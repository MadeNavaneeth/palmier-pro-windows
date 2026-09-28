// Counts the truncated double-encoding runs a document already carries, so an
// edit can be required to leave the count alone.
//
// This is not the U+FFFD scan. U+FFFD means the original bytes were already
// unrecoverable; a truncated double-encoded run still decodes greedily to
// something, which is why a strict scanner misses it and why it survives in
// `docs/UPSTREAM_ISSUES.md` to this day (three runs, sixteen characters, all on
// the reconciliation line). The count must never grow (a new corruption) and
// never shrink (a silent repair dressed up as an edit).
//
// Usage:
//   node scripts/mojibake-check.mjs <file> [...more files]
//
// Exported for `upstream-record-edit.mjs`.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CP1252_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

const CANDIDATE =
  /[\u0080-\u00FF\u2012\u2013\u2014\u2015\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC]/;

function charToByte() {
  const map = new Map();
  for (let b = 0xa0; b < 0x100; b += 1) map.set(String.fromCharCode(b), b);
  for (const [b, cp] of Object.entries(CP1252_HIGH)) map.set(String.fromCodePoint(cp), Number.parseInt(b, 10));
  return map;
}

const CHAR_TO_BYTE = charToByte();

/** Every truncated double-encoding run in the text, with its line and length. */
export function truncatedRuns(text) {
  const runs = [];
  text.split(/\r?\n/).forEach((line, index) => {
    let i = 0;
    while (i < line.length) {
      if (!CANDIDATE.test(line[i])) {
        i += 1;
        continue;
      }
      let j = i;
      while (j < line.length && CANDIDATE.test(line[j])) j += 1;
      const run = line.slice(i, j);
      const bytes = [];
      let mappable = true;
      for (const ch of run) {
        const byte = CHAR_TO_BYTE.get(ch);
        if (byte === undefined) {
          mappable = false;
          break;
        }
        bytes.push(byte);
      }
      if (mappable && bytes.length > 1) {
        const decoded = Buffer.from(bytes).toString('utf8');
        if (decoded.includes('\uFFFD') || decoded === run) {
          runs.push({
            line: index + 1,
            chars: run.length,
            bytes: bytes.map((b) => b.toString(16).padStart(2, '0')).join(' '),
            context: line.slice(Math.max(0, i - 30), Math.min(line.length, j + 20)),
          });
        }
      }
      i = j;
    }
  });
  return runs;
}

/** The invariant an edit must preserve: run count and total character count. */
export function mojibakeSummary(text) {
  const runs = truncatedRuns(text);
  return { runs: runs.length, chars: runs.reduce((n, r) => n + r.chars, 0) };
}

function main(argv) {
  if (argv.length === 0) {
    console.error('usage: node scripts/mojibake-check.mjs <file> [...more files]');
    process.exitCode = 2;
    return;
  }
  let total = 0;
  for (const file of argv) {
    const text = readFileSync(file, 'utf8');
    const runs = truncatedRuns(text);
    total += runs.length;
    console.log(`${file}: ${runs.length} truncated run(s)`);
    for (const run of runs) {
      console.log(`  line ${run.line}: ${run.chars} chars, bytes=[${run.bytes}]`);
      console.log(`    context: ${JSON.stringify(run.context)}`);
    }
  }
  console.log(`total truncated runs: ${total}`);
  process.exitCode = 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
