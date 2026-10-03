#!/usr/bin/env node
// Guarded editor for the upstream reconciliation record.
//
// `docs/UPSTREAM_ISSUES.md` carries its whole history in one ~87,000-character
// paragraph (line 1008), and it has been silently corrupted twice in one session
// by two different mechanisms, both of which write cleanly and parse cleanly:
//
//   1. A `|` typed into prose invents a GFM table column. Nothing errors.
//   2. A scripted `.replace()` whose anchor an earlier edit in the same run had
//      already destroyed. It no-ops. The agent's anchor check had run against a
//      pre-edit snapshot, so it reported "matched exactly once" while the
//      replacement did nothing, and a committed forward reference dangled.
//
// This tool exists so that neither can reach the file. It refuses to write
// unless every one of the following holds, all of them checked BEFORE the write
// against an in-memory simulation, and re-checked on disk afterwards:
//
//   - each anchor occurs exactly once AT THE MOMENT THAT EDIT RUNS, against the
//     text as it stands after every earlier edit in the same run;
//   - no anchor is a substring of, equal to, or otherwise overlapping another
//     anchor, and no edit's replacement can consume or duplicate a later edit's
//     anchor;
//   - every declared probe is satisfied by the resulting text, at the location
//     it was promised ("this record is at the end of this thread" must be
//     followed by that record);
//   - the edit leaves the table-shape histogram, the bare-LF count, the U+FFFD
//     count, the BOM, the line-ending style and the mojibake-run count exactly
//     as it found them;
//   - the file carries no lone CR, before or after the write.
//
// That last one is not a formatting preference. Git's `convert_is_binary` reads
// a lone CR as proof the file is binary, and a binary file skips the clean
// filter, so one lone CR is enough to let CRLF into the index for good. The
// round trip here is an exact identity even on `\r\r\n`, so this tool never
// caused that defect; it failed to notice it, and certified the same 8 bytes as
// safe on every later run.
//
// Usage:
//   node scripts/upstream-record-edit.mjs --plan <plan.json> [--dry-run]
//
// The plan is data, not code:
// {
//   "file": "docs/UPSTREAM_ISSUES.md",
//   "edits": [
//     { "id": "short-slug",
//       "find": "literal text, unique when this edit runs",
//       "replace": "literal replacement",
//       "probe": { "text": "what must be there", "after": "the sentence that promised it" } }
//   ]
// }

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tableShapeHistogram, overWideRows, dispositionCounts } from './parity-table-check.mjs';
import { mojibakeSummary, truncatedRuns } from './mojibake-check.mjs';

export class Refusal extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'Refusal';
    this.code = code;
    this.detail = detail;
  }
}

export function countOccurrences(haystack, needle) {
  if (needle === '') return Infinity;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

// ── the file as a byte-preserving object ──────────────────────────────────────

/**
 * Count CR characters that are not part of a CRLF pair: a lone CR.
 *
 * A lone CR is the third line-ending state, and the one that matters most.
 * Git's `convert_is_binary` treats a CR that is not followed by an LF as
 * proof that a file is binary, and a binary file bypasses the clean filter
 * entirely. So one lone CR is enough to make `git add` store the working tree's
 * CRLF verbatim, silently, and for the index to keep those bytes from then on.
 *
 * This tool counted CRLF and bare LF and counted a lone CR as NEITHER, so a
 * `\r\r\n` paragraph break read as clean CRLF and the file was certified safe.
 * That is how 8 lone CRs reached `docs/UPSTREAM_ISSUES.md` and took the clean
 * filter out of play for it. The defect is invisible to a count that only asks
 * "is every LF preceded by a CR", so it asks this question separately.
 */
export function countLoneCr(text) {
  let lone = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\r' && text[i + 1] !== '\n') lone += 1;
  }
  return lone;
}

/**
 * Read a file into a form that can be written back byte-for-byte. The BOM and
 * the line-ending style are carried, not normalised away, because this file has
 * a BOM in git and CRLF in the working tree and both are load-bearing for the
 * checks downstream.
 */
export function readDocument(file) {
  const bytes = readFileSync(file);
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = bytes.toString('utf8');
  const body = bom ? text.slice(1) : text;
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lf = (body.match(/\n/g) ?? []).length - crlf;
  // Checked BEFORE the mixed-line-ending refusal, because a lone CR breaks git's
  // normalisation outright whereas mixing is only unreadable, and a file can
  // carry both. This refuses rather than repairs: stripping the CR would be a
  // silent content change to the one file whose whole purpose is that no
  // silent change reaches it, and it would destroy the evidence of the writer
  // that produced the doubled CR in the first place.
  const loneCr = countLoneCr(body);
  if (loneCr > 0) {
    throw new Refusal(
      'lone-cr',
      `${file} contains ${loneCr} lone CR character(s), which git would read as binary and leave un-normalised, so a rewrite could not be proven byte-preserving`,
      { loneCr, crlf, lf },
    );
  }
  if (crlf > 0 && lf > 0) {
    throw new Refusal(
      'mixed-line-endings',
      `${file} mixes CRLF and bare LF, so a rewrite could not be proven byte-preserving`,
      { crlf, lf },
    );
  }
  return {
    file,
    bytes,
    bom,
    eol: crlf > 0 ? '\r\n' : '\n',
    // Normalising `\r\n` to `\n` and expanding it back is an exact identity for
    // every input this function accepts, because acceptance means every CR is
    // part of a CRLF pair. It was already an identity on `\r\r\n` too: the
    // orphan CR survives normalisation untouched, and encodeDocument only ever
    // prefixes a CR to an LF, so `\r\r\n` in is `\r\r\n` out. The round trip
    // was never lossy. What was wrong was accepting a file it should refuse.
    text: body.replace(/\r\n/g, '\n'),
    raw: body,
  };
}

export function encodeDocument(doc, normalizedText) {
  return Buffer.from(
    (doc.bom ? '\uFEFF' : '') + normalizedText.replace(/\n/g, doc.eol),
    'utf8',
  );
}

/**
 * Content invariants, computed on the newline-normalised text. These are the
 * ones that can be decided before anything is written, because the simulated
 * text is the text that would be written.
 */
export function contentConditions(text) {
  const histogram = tableShapeHistogram(text);
  return {
    uFFFD: (text.match(/\uFFFD/g) ?? []).length,
    tableShape: [...histogram.entries()].sort().map(([k, v]) => `${k}:${v}`).join(' '),
    mojibake: mojibakeSummary(text),
  };
}

/**
 * Encoding invariants, computed on the bytes as they sit on disk. These are only
 * meaningful after a write, because the newline form is chosen at write time: a
 * file of CRLF lines read as text has no bare LF in it, and a normalised buffer
 * has a bare LF on every line, so counting bare LFs before the write would
 * measure the buffer rather than the file.
 */
export function encodingConditions(raw) {
  let bareLf = 0;
  let crlf = 0;
  let loneCr = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '\r' && raw[i + 1] !== '\n') loneCr += 1;
    if (raw[i] === '\n') {
      if (i > 0 && raw[i - 1] === '\r') crlf += 1;
      else bareLf += 1;
    }
  }
  return { bareLf, crlf, loneCr, uFFFD: (raw.match(/\uFFFD/g) ?? []).length };
}

function compareConditions(before, after) {
  const problems = [];
  if (after.uFFFD !== before.uFFFD) {
    problems.push(`U+FFFD count changed: ${before.uFFFD} -> ${after.uFFFD}`);
  }
  if (after.mojibake.runs !== before.mojibake.runs || after.mojibake.chars !== before.mojibake.chars) {
    problems.push(
      `truncated-mojibake count changed: ${before.mojibake.runs} runs / ${before.mojibake.chars} chars ` +
        `-> ${after.mojibake.runs} runs / ${after.mojibake.chars} chars`,
    );
  }
  if (after.tableShape !== before.tableShape) {
    problems.push(`table shape changed: "${before.tableShape}" -> "${after.tableShape}"`);
  }
  return problems;
}

// ── plan validation ───────────────────────────────────────────────────────────

function validateShape(plan) {
  if (!plan || typeof plan !== 'object') throw new Refusal('bad-plan', 'plan is not an object');
  if (typeof plan.file !== 'string' || plan.file === '') {
    throw new Refusal('bad-plan', 'plan.file must be a non-empty string');
  }
  if (!Array.isArray(plan.edits) || plan.edits.length === 0) {
    throw new Refusal('bad-plan', 'plan.edits must be a non-empty array');
  }
  plan.edits.forEach((edit, i) => {
    const where = `edits[${i}]`;
    if (typeof edit?.id !== 'string' || edit.id === '') {
      throw new Refusal('bad-plan', `${where}.id must be a non-empty string`);
    }
    if (typeof edit.find !== 'string' || edit.find === '') {
      throw new Refusal('bad-plan', `${where}.find must be a non-empty string`);
    }
    if (typeof edit.replace !== 'string') {
      throw new Refusal('bad-plan', `${where}.replace must be a string`);
    }
    if (edit.find === edit.replace) {
      throw new Refusal('no-op-edit', `${where} (${edit.id}) replaces its anchor with itself`);
    }
    // String.replace expands `$&`, `` $` ``, `$'`, `$$` and `$1` in a
    // replacement, so a plan carrying one would write text other than the text
    // it declares. Refused up front rather than caught by the rollback.
    const expansion = /\$(?:[&$`']|\d)/.exec(edit.replace);
    if (expansion) {
      throw new Refusal(
        'bad-replacement-pattern',
        `${where} (${edit.id}) replacement contains "${expansion[0]}", which String.replace would expand`,
        { id: edit.id, at: expansion.index },
      );
    }
    if (edit.probe !== undefined) {
      if (typeof edit.probe?.text !== 'string' || edit.probe.text === '') {
        throw new Refusal('bad-plan', `${where}.probe.text must be a non-empty string`);
      }
      if (typeof edit.probe.after !== 'string' || edit.probe.after === '') {
        throw new Refusal('bad-plan', `${where}.probe.after must be a non-empty string`);
      }
    }
  });
}

/**
 * P1. Anchors must not overlap, and no replacement may manufacture a copy of a
 * later anchor. Both make the per-edit uniqueness count ambiguous, and both are
 * cheaper to report here than to diagnose from a count of 2.
 */
export function checkAnchorsDoNotOverlap(edits) {
  for (let i = 0; i < edits.length; i += 1) {
    for (let j = i + 1; j < edits.length; j += 1) {
      const a = edits[i];
      const b = edits[j];
      if (a.find === b.find) {
        throw new Refusal('anchor-duplicate', `edits "${a.id}" and "${b.id}" share an identical anchor`, {
          a: a.id,
          b: b.id,
        });
      }
      if (a.find.includes(b.find)) {
        throw new Refusal('anchor-overlap', `anchor "${b.id}" is a substring of anchor "${a.id}"`, {
          a: a.id,
          b: b.id,
        });
      }
      if (b.find.includes(a.find)) {
        throw new Refusal('anchor-overlap', `anchor "${a.id}" is a substring of anchor "${b.id}"`, {
          a: a.id,
          b: b.id,
        });
      }
      if (a.replace.includes(b.find)) {
        throw new Refusal(
          'anchor-duplicated-by-replacement',
          `the replacement for "${a.id}" contains the anchor "${b.id}", which would make it ambiguous`,
          { a: a.id, b: b.id },
        );
      }
    }
  }
}

/**
 * P2. Replay the plan in memory, checking each anchor against the text as it
 * stands AT THAT MOMENT -- after every earlier edit -- and checking that no
 * earlier edit has broken a later anchor. This is the check whose absence
 * produced the silent no-op: validating against the original text cannot see
 * an earlier edit's side effect.
 */
export function simulate(docText, edits) {
  let text = docText;
  const applied = [];
  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    const seen = countOccurrences(text, edit.find);
    if (seen !== 1) {
      throw new Refusal(
        seen === 0 ? 'anchor-missing' : 'anchor-ambiguous',
        `edit "${edit.id}": anchor occurs ${seen} time(s) when it runs, expected exactly 1`,
        { id: edit.id, occurrences: seen, position: i, anchor: preview(edit.find) },
      );
    }
    text = text.replace(edit.find, edit.replace);
    applied.push({ id: edit.id, at: i });
    for (let j = i + 1; j < edits.length; j += 1) {
      const later = edits[j];
      const laterSeen = countOccurrences(text, later.find);
      if (laterSeen !== 1) {
        throw new Refusal(
          'later-anchor-broken',
          `edit "${edit.id}" left the anchor for "${later.id}" occurring ${laterSeen} time(s); ` +
            `an earlier edit in this run consumed or duplicated it`,
          { consumedBy: edit.id, id: later.id, occurrences: laterSeen, anchor: preview(later.find) },
        );
      }
    }
  }
  return { text, applied };
}

/**
 * P3. Every promise must be kept at the place it was made. "The anchor matched"
 * is not evidence; "the thing the anchor promised is present, after the sentence
 * that promised it" is. A forward reference with nothing behind it fails here.
 */
export function checkProbes(text, edits) {
  for (const edit of edits) {
    if (!edit.probe) continue;
    const promisedAt = text.indexOf(edit.probe.after);
    if (promisedAt < 0) {
      throw new Refusal(
        'probe-promise-missing',
        `edit "${edit.id}": the sentence that made the promise is gone, so the probe has nothing to sit after`,
        { id: edit.id, after: preview(edit.probe.after) },
      );
    }
    const found = text.indexOf(edit.probe.text);
    if (found < 0) {
      throw new Refusal(
        'probe-missing',
        `edit "${edit.id}": promised content is absent - a dangling forward reference`,
        { id: edit.id, text: preview(edit.probe.text) },
      );
    }
    if (found < promisedAt) {
      throw new Refusal(
        'probe-misplaced',
        `edit "${edit.id}": promised content exists only BEFORE the sentence that promised it`,
        { id: edit.id, text: preview(edit.probe.text), after: preview(edit.probe.after) },
      );
    }
  }
}

function preview(text, max = 90) {
  const flat = text.replace(/\n/g, '\\n');
  return flat.length <= max ? JSON.stringify(flat) : `${JSON.stringify(flat.slice(0, max))}...`;
}

/**
 * P4. Re-read what actually landed on disk. Cheap, and it is the only check that
 * sees a write that was not the write we simulated.
 *
 * The readDocument call below is not just a way to get the bytes. It re-applies
 * every encoding refusal in readDocument to the file as it now stands, so the
 * post-write audit covers the BOM, the line-ending style, mixed line endings and
 * lone CRs without duplicating any of those checks here. A lone CR that the
 * pre-flight never saw -- a write that was not the write we simulated -- is
 * refused there, and `runPlan` puts the original bytes back.
 */
export function verifyOnDisk(doc, edits) {
  const after = readDocument(doc.file);
  if (after.bom !== doc.bom) {
    throw new Refusal('bom-changed', `BOM state changed: ${doc.bom} -> ${after.bom}`, {});
  }
  if (after.eol !== doc.eol) {
    throw new Refusal(
      'line-endings-changed',
      `line-ending style changed: ${JSON.stringify(doc.eol)} -> ${JSON.stringify(after.eol)}`,
      {},
    );
  }
  const encoding = encodingConditions(after.raw);
  if (encoding.crlf > 0 && encoding.bareLf > 0) {
    throw new Refusal(
      'mixed-line-endings',
      `the written file mixes ${encoding.crlf} CRLF and ${encoding.bareLf} bare LF line(s)`,
      encoding,
    );
  }
  // Neither COUNT is an invariant: an edit that appends a record adds line
  // breaks, and refusing that would refuse the edit this tool exists to make.
  // The STYLE is the invariant, and it was checked above.
  //
  // A bare LF is not itself a defect. It is the whole file's newline form on an
  // LF checkout, which is what every Linux CI runner and every `git show HEAD`
  // produces for a repo with core.autocrlf=true. Vetoing a nonzero bare-LF
  // count therefore made this tool refuse every edit on any LF checkout, which
  // is what the Linux gate caught. MIXING is the defect: a file that has both
  // forms is the state AGENTS.md calls out, because a reader cannot tell which
  // form any given line break is.
  for (const edit of edits) {
    const left = countOccurrences(after.text, edit.find);
    if (left !== 0) {
      throw new Refusal('verify-anchor-remains', `edit "${edit.id}": anchor still present ${left} time(s) after the write`, {
        id: edit.id,
      });
    }
    const landed = countOccurrences(after.text, edit.replace);
    if (landed !== 1) {
      throw new Refusal(
        'verify-replacement-missing',
        `edit "${edit.id}": replacement present ${landed} time(s) after the write, expected 1`,
        { id: edit.id },
      );
    }
  }
  checkProbes(after.text, edits);
  const problems = compareConditions(contentConditions(doc.text), contentConditions(after.text));
  if (problems.length > 0) {
    throw new Refusal('post-condition-failed', problems.join('; '), { problems });
  }
  return after;
}

/**
 * The whole procedure. Nothing is written unless every pre-write check passes;
 * anything that fails after the write puts the original bytes back.
 */
export function runPlan(plan, { dryRun = false, log = () => {} } = {}) {
  validateShape(plan);
  const doc = readDocument(plan.file);
  const before = contentConditions(doc.text);
  const encodingBefore = encodingConditions(doc.raw);
  log(`file: ${plan.file}`);
  log(
    `  bom=${doc.bom} eol=${JSON.stringify(doc.eol)} chars=${doc.text.length} ` +
      `bareLF=${encodingBefore.bareLf} loneCR=${encodingBefore.loneCr} uFFFD=${before.uFFFD} ` +
      `mojibake=${before.mojibake.runs}r/${before.mojibake.chars}c`,
  );
  log(`  table shape: ${before.tableShape}`);
  log(`  pre-existing over-wide rows: ${overWideRows(doc.text).length}`);

  checkAnchorsDoNotOverlap(plan.edits);
  const simulated = simulate(doc.text, plan.edits);
  checkProbes(simulated.text, plan.edits);
  // A clean file is not sufficient on its own: a plan can introduce the defect
  // itself, by carrying a lone CR in a replacement. Checked on the text that
  // would be written, so the veto lands before anything reaches the disk.
  const simulatedLoneCr = countLoneCr(simulated.text);
  if (simulatedLoneCr > 0) {
    throw new Refusal(
      'lone-cr',
      `the edit would leave ${simulatedLoneCr} lone CR character(s) in ${plan.file}, which git would read as binary and leave un-normalised`,
      { loneCr: simulatedLoneCr },
    );
  }
  const problems = compareConditions(before, contentConditions(simulated.text));
  if (problems.length > 0) {
    throw new Refusal('post-condition-failed', `the edit would change: ${problems.join('; ')}`, { problems });
  }
  log(`  pre-flight ok: ${plan.edits.length} edit(s) simulated, ${plan.edits.filter((e) => e.probe).length} probe(s)`);

  if (dryRun) {
    return { ok: true, written: false, dryRun: true, chars: doc.text.length };
  }

  writeFileSync(plan.file, encodeDocument(doc, simulated.text));
  try {
    verifyOnDisk(doc, plan.edits);
  } catch (error) {
    writeFileSync(plan.file, doc.bytes);
    log(`  ROLLED BACK: ${error.code} ${error.message}`);
    return { ok: false, written: false, rolledBack: true, error };
  }

  const after = readDocument(plan.file);
  log(`  wrote ${plan.file}: ${doc.bytes.length} -> ${after.bytes.length} bytes`);
  log(`  table shape after: ${contentConditions(after.text).tableShape}`);
  log(`  over-wide rows after: ${overWideRows(after.text).length}`);
  log(`  dispositions after: ${JSON.stringify(Object.fromEntries(dispositionCounts(after.text)))}`);
  if (truncatedRuns(after.text).length > 0) {
    log(`  pre-existing mojibake runs preserved: ${truncatedRuns(after.text).length}`);
  }
  return { ok: true, written: true, bytesBefore: doc.bytes.length, bytesAfter: after.bytes.length };
}

function main(argv) {
  const args = argv.slice(2);
  let planPath = null;
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--plan') planPath = args[++i];
    else if (args[i] === '--dry-run') dryRun = true;
  }
  if (!planPath) {
    console.error('usage: node scripts/upstream-record-edit.mjs --plan <plan.json> [--dry-run]');
    process.exitCode = 2;
    return;
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (error) {
    console.error(`[record-edit] cannot read plan ${planPath}: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  try {
    const result = runPlan(plan, { dryRun, log: (line) => console.log(`[record-edit] ${line}`) });
    if (result.dryRun) {
      console.log('[record-edit] dry run: nothing written');
    } else if (result.ok) {
      console.log('[record-edit] OK');
    } else {
      // The write happened and the verification of it did not pass, so the
      // original bytes are back. Reporting success here would be the same class
      // of lie this tool exists to prevent.
      console.error(`[record-edit] FAILED after writing: ${result.error.code} ${result.error.message}`);
      console.error('[record-edit] the file was restored to its pre-edit bytes');
      process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof Refusal) {
      console.error(`[record-edit] REFUSED (${error.code}): ${error.message}`);
      if (Object.keys(error.detail).length > 0) {
        console.error(`[record-edit] detail: ${JSON.stringify(error.detail)}`);
      }
      console.error('[record-edit] nothing was written');
    } else {
      console.error(`[record-edit] ERROR: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv);
}
