/**
 * Regression tests for `scripts/upstream-record-edit.mjs`, the guarded editor
 * for the upstream reconciliation record.
 *
 * The record has been silently corrupted twice in one session, by two
 * mechanisms that both write cleanly and parse cleanly:
 *
 *   1. A `|` typed into prose invents a GFM table column. Nothing errors, the
 *      file still parses, and only a cell count notices.
 *   2. A scripted `.replace()` whose anchor an earlier edit in the same run had
 *      already destroyed. It no-ops, the pre-edit anchor check still reports
 *      "matched exactly once", and a forward reference is left dangling.
 *
 * Each test asserts the two things that matter: a refusal that names its cause
 * and a non-zero exit, and the fixture's bytes UNCHANGED. A refusal that still
 * wrote would be a different bug.
 *
 * These drive the CLI in a child process rather than importing the tool, and that
 * is deliberate on two counts. It is the contract a caller actually sees: exit
 * code, refusal text, bytes. And vitest CANNOT import this module: a `.mjs` with
 * CRLF endings - which is what every file in `scripts/` has, and what this one
 * must keep - throws `SyntaxError: Invalid or unexpected token` in vite's
 * transform, while Node imports the same file without complaint. Importing it
 * here would trade a real failure mode for a phantom one.
 *
 * Fixtures are synthesised rather than copied from the live ledger, so the tests
 * keep their meaning when the ledger's prose changes. One test does run against a
 * copy of the real file, asserting only invariants relative to its own pre-edit
 * state, so it cannot go stale.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOOL = join(REPO_ROOT, 'scripts', 'upstream-record-edit.mjs');
const LEDGER = join(REPO_ROOT, 'docs', 'UPSTREAM_ISSUES.md');

// U+00C3 U+00A2 U+00E2 U+201A U+00AC U+00E2 U+20AC: the seven-character
// truncated double-encoding run the real record already carries three times.
const MOJIBAKE_RUN = '\u00C3\u00A2\u00E2\u201A\u00AC\u00E2\u20AC';

const FIXTURE_LINES = [
  '# Reconciliation record',
  '',
  '| Issue | Title | Disposition | Reason |',
  '|---|---|---|---|',
  '| [#1](https://example.test/1) | A row whose prose must not grow a column | Implemented | reason text here |',
  '',
  `_Footer: one failed write whose atomic rename still holds.**The speed/source-time family closes, and its last two gaps needed a derivation. The pre-existing \`Timeline store ${MOJIBAKE_RUN} Zustend\` corruption must not change._`,
  '',
];

/** The synthetic fixture, with the BOM and CRLF the real record also carries. */
function writeFixture(dir: string, name: string, lines: string[] = FIXTURE_LINES): string {
  const file = join(dir, name);
  writeFileSync(file, `\uFEFF${lines.join('\r\n')}`, 'utf8');
  return file;
}

type Edit = { id: string; find: string; replace: string; probe?: { text: string; after: string } };

/** Run the tool on a plan and report its exit status and combined output. */
function runTool(dir: string, file: string, edits: Edit[]): { status: number; output: string } {
  const planPath = join(dir, 'plan.json');
  writeFileSync(planPath, JSON.stringify({ file, edits }, null, 2), 'utf8');
  try {
    const output = execFileSync('node', [TOOL, '--plan', planPath], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('upstream-record-edit', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'record-edit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── failure mode 2: an anchor destroyed by an earlier edit in the same run ──

  it('refuses a run whose first edit consumes the period a later anchor needs', () => {
    // The historical shape. Edit one ends its replacement with a semicolon, so
    // the period edit two's anchor depends on stops existing. The two anchors
    // are DISJOINT - edit two's anchor straddles the end of edit one's - so
    // neither a substring check nor a pre-edit uniqueness check can see it.
    // Only validating each anchor against the text as it stands when that edit
    // runs catches it, and it is caught BEFORE anything is written.
    const file = writeFixture(dir, 'ledger.md');
    const before = readFileSync(file);
    const result = runTool(dir, file, [
      {
        id: 'consume-the-period',
        find: 'one failed write whose atomic rename still holds.',
        replace:
          "one failed write whose atomic rename still holds; and **`project:save`'s extension test is case-sensitive**",
      },
      {
        id: 'reword-the-next-sentence',
        find: 'still holds.**The speed/source-time family closes, and its last two gaps',
        replace: 'still holds.**The speed/source-time family now closes, and its last two gaps',
      },
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('REFUSED (later-anchor-broken)');
    expect(result.output).toContain('reword-the-next-sentence');
    expect(result.output).toContain('nothing was written');
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('refuses two edits whose anchors overlap', () => {
    // The same incident with anchors that do overlap: caught earlier, by the
    // pre-flight, but it must still be caught.
    const file = writeFixture(dir, 'ledger.md');
    const before = readFileSync(file);
    const result = runTool(dir, file, [
      { id: 'inner', find: 'whose atomic rename still holds.', replace: 'whose atomic rename still holds;' },
      {
        id: 'outer',
        find: 'whose atomic rename still holds.**The speed/source-time',
        replace: 'whose atomic rename still holds.**The speed/source-time now',
      },
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('REFUSED (anchor-overlap)');
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('refuses a plan whose later anchor an earlier replacement would duplicate', () => {
    const file = writeFixture(dir, 'ledger.md');
    const before = readFileSync(file);
    const result = runTool(dir, file, [
      { id: 'first', find: 'reason text here', replace: 'reason text here, and again reason text here' },
      { id: 'second', find: 'reason text here', replace: 'REPLACED' },
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('REFUSED (anchor-duplicate)');
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  // ── failure mode 1: a pipe in prose inventing a table column ────────────────

  it('refuses a raw pipe written into a table cell, and leaves the shape alone', () => {
    const file = writeFixture(dir, 'ledger.md');
    const before = readFileSync(file);
    const result = runTool(dir, file, [
      { id: 'pipe-in-prose', find: 'reason text here', replace: 'reason text | here' },
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('REFUSED (post-condition-failed)');
    expect(result.output).toContain('table shape changed');
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  // ── the dangling forward reference ──────────────────────────────────────────

  it('refuses a replacement that promises a record the plan never supplies', () => {
    const file = writeFixture(dir, 'ledger.md');
    const before = readFileSync(file);
    const result = runTool(dir, file, [
      {
        id: 'promise-a-record',
        find: 'needed a derivation.',
        replace: 'needed a derivation, and the record with its evidence is recorded at the end of this thread.',
        probe: { text: '## The record', after: 'recorded at the end of this thread' },
      },
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('REFUSED (probe-missing)');
    expect(result.output).toContain('dangling forward reference');
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('refuses promised content that only exists BEFORE the promise', () => {
    const file = writeFixture(dir, 'ledger.md');
    const result = runTool(dir, file, [
      {
        id: 'promise-after-the-fact',
        find: 'needed a derivation.',
        replace: '## The record is above. The rest is recorded at the end of this thread.',
        probe: { text: '## The record is above', after: 'recorded at the end of this thread' },
      },
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('REFUSED (probe-misplaced)');
  });

  // ── the happy path, and the byte-level promises it makes ────────────────────

  it('accepts a forward reference whose record is really there', () => {
    // The positive control: the probe is not a formality, it is satisfiable, and
    // satisfying it is what lets a real record be appended.
    const file = writeFixture(dir, 'ledger.md');
    const result = runTool(dir, file, [
      {
        id: 'promise-a-record',
        find: 'needed a derivation.',
        replace:
          'needed a derivation, and the record with its evidence is recorded at the end of this thread.\n\n## The record\n\nIt is here.',
        probe: { text: '## The record', after: 'recorded at the end of this thread' },
      },
    ]);

    expect(result.status).toBe(0);
    expect(result.output).toContain('OK');
    expect(readFileSync(file, 'utf8')).toContain('## The record');
  });

  it('applies a benign edit and leaves BOM, line endings, mojibake and table shape intact', () => {
    const file = writeFixture(dir, 'ledger.md');
    const before = readFileSync(file);
    const result = runTool(dir, file, [
      {
        id: 'name-the-derivation',
        find: 'its last two gaps needed a derivation.',
        replace: 'its last two gaps needed a derivation, not a missing term.',
        probe: { text: 'not a missing term', after: 'its last two gaps needed a derivation' },
      },
    ]);
    const after = readFileSync(file);
    const text = after.toString('utf8');

    expect(result.status).toBe(0);
    expect(result.output).toContain('OK');
    expect(after.equals(before)).toBe(false);
    expect(after[0]).toBe(0xef);
    expect(text).toContain('not a missing term');
    // Seven lines joined by CRLF means seven line breaks, and none of them bare.
    expect((text.match(/\r\n/g) ?? []).length).toBe(FIXTURE_LINES.length - 1);
    expect(text).not.toMatch(/(?<!\r)\n/);
    expect(text).not.toContain('\uFFFD');
    // The pre-existing corruption survives untouched, in both directions.
    expect(text.split(MOJIBAKE_RUN).length - 1).toBe(1);
    // Only the footer line differs from the fixture; the other seven are identical.
    const beforeLines = before.toString('utf8').replace(/^\uFEFF/, '').split('\r\n');
    const afterLines = text.replace(/^\uFEFF/, '').split('\r\n');
    const changed = beforeLines.map((line, i) => (line === afterLines[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toEqual([6]);
  });

  it('refuses a replacement carrying a $-substitution pattern before writing', () => {
    // `$&` is expanded by String.replace, so the text that would land is not
    // the text the plan declares. Refused up front, which is better than
    // relying on the rollback to notice.
    const file = writeFixture(dir, 'ledger.md');
    const before = readFileSync(file);
    const result = runTool(dir, file, [
      {
        id: 'dollar-ampersand',
        find: 'needed a derivation.',
        replace: 'needed a derivation, $& as upstream wrote it.',
      },
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('REFUSED (bad-replacement-pattern)');
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('refuses to touch a file whose line endings are mixed', () => {
    const file = join(dir, 'mixed.md');
    writeFileSync(file, '\uFEFFone\r\ntwo\nthree', 'utf8');
    const before = readFileSync(file);
    const result = runTool(dir, file, [{ id: 'x', find: 'two', replace: 'TWO' }]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('REFUSED (mixed-line-endings)');
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  // ── against the real record ────────────────────────────────────────────────

  it("preserves the real ledger's pre-existing damage, neither growing nor shrinking it", () => {
    // Relative to its own pre-edit state, so this cannot go stale: whatever the
    // record already carries must still be there afterwards, unchanged. This is
    // the run that proves the guard is compatible with the file it exists for,
    // including its BOM, its CRLF, its three mojibake runs and its four
    // over-wide rows.
    const file = join(dir, 'real-ledger.md');
    copyFileSync(LEDGER, file);
    const before = readFileSync(file).toString('utf8');
    const anchor = 'so there is currently no such list.';
    expect(before.split(anchor).length - 1).toBe(1);

    const result = runTool(dir, file, [
      { id: 'name-the-missing-list', find: anchor, replace: 'so there is currently no such list at all.' },
    ]);
    const afterBytes = readFileSync(file);
    const after = afterBytes.toString('utf8').replace(/^\uFEFF/, '');

    expect(result.status).toBe(0);
    expect(after).toContain('no such list at all');
    expect(afterBytes[0]).toBe(0xef);
    expect(after.split('\r\n').length).toBe(before.split('\r\n').length);
    expect(after).not.toContain('\uFFFD');
    // The mojibake runs, the table shape and the four over-wide rows are all
    // reported unchanged, which is the same comparison the tool made itself.
    expect(result.output).toMatch(/table shape after: .*4cells:61/);
    expect(result.output).toMatch(/over-wide rows after: 4/);
    expect(result.output).toMatch(/pre-existing mojibake runs preserved: 3/);
  });
});
