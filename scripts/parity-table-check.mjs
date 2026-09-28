// Escaped-pipe-aware structural checks for the upstream ledgers.
//
// The failure this exists to catch: GFM splits a table cell on an unescaped
// `|`, so a pipe typed into prose silently invents a column. Nothing errors, the
// file still parses, and the damage is only visible to something that counts
// cells. `docs/UPSTREAM_ISSUES.md` still carries four such rows from before this
// check existed (lines 114, 125, 132 and 144), which is why the comparison is
// made against a pre-edit snapshot rather than against zero.
//
// Usage:
//   node scripts/parity-table-check.mjs <file> [snapshotOut.json]
//
// Exported for `upstream-record-edit.mjs`, which refuses to write when an edit
// changes the table-shape histogram.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DISPOSITIONS = [
  'Different by design',
  'Needs investigation',
  'N/A platform',
  'Implemented',
  'Partial',
  'Planned',
];

/**
 * Split one table row into cells. A pipe written as `\|` is a literal pipe and
 * does not terminate a cell; that is GFM's own rule, and getting it wrong is
 * how a naive splitter reports phantom mismatches.
 */
export function splitCells(line) {
  const inner = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isSeparatorRow(line) {
  return /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
}

/** Every table row outside a fenced code block, with its line number. */
export function tableRows(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!/^\s*\|/.test(line)) continue;
    if (isSeparatorRow(line)) continue;
    rows.push({ lineNo: i + 1, cells: splitCells(line), raw: line });
  }
  return rows;
}

/**
 * The shape histogram every ledger edit must leave untouched: how many table rows
 * have 2 cells, 3 cells, 4 cells, and so on. Prose edits do not move it; an
 * unescaped pipe does, by adding a wider bucket.
 */
export function tableShapeHistogram(text) {
  const histogram = new Map();
  for (const row of tableRows(text)) {
    const key = `${row.cells.length}cells`;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }
  return histogram;
}

/** Rows whose cell count exceeds the 4-column shape the ledgers use. */
export function overWideRows(text) {
  return tableRows(text)
    .filter((row) => row.cells.length > 4)
    .map((row) => ({ lineNo: row.lineNo, cells: row.cells.length, id: row.cells[0].slice(0, 40) }));
}

/** Disposition words per row, for the ledger's own summary arithmetic. */
export function dispositionCounts(text) {
  const counts = new Map();
  for (const row of tableRows(text)) {
    const cell = row.cells[2];
    if (cell && DISPOSITIONS.includes(cell)) counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
  return counts;
}

function histogramText(histogram) {
  return [...histogram.entries()]
    .sort((a, b) => Number.parseInt(a[0], 10) - Number.parseInt(b[0], 10))
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
}

function main(argv) {
  const file = argv[0];
  const snapshotOut = argv[1];
  if (!file) {
    console.error('usage: node scripts/parity-table-check.mjs <file> [snapshotOut.json]');
    process.exitCode = 2;
    return;
  }
  const text = readFileSync(file, 'utf8');
  const rows = tableRows(text);
  const dispositionRows = rows.filter((r) => r.cells.length >= 3 && DISPOSITIONS.includes(r.cells[2]));
  const over = overWideRows(text);
  const nearDisposition = rows.filter(
    (r) =>
      r.cells.length >= 3 &&
      !DISPOSITIONS.includes(r.cells[2]) &&
      DISPOSITIONS.some((d) => r.cells[2].startsWith(d)),
  );

  console.log('file:', file);
  console.log('total table rows parsed:', rows.length);
  console.log('disposition rows:', dispositionRows.length);
  // The ledgers also carry 3-column and 2-column tables, so "not 4" is not a
  // defect. Only a row WIDER than the shape it sits in is one.
  console.log('rows wider than 4 cells:', over.length);
  for (const row of over) {
    console.log(`  line ${row.lineNo}: ${row.cells} cells | ids=${JSON.stringify(row.id)}`);
  }
  console.log('near-disposition rows (3rd cell starts with a word):', nearDisposition.length);
  console.log('table shape histogram:', histogramText(tableShapeHistogram(text)));

  if (snapshotOut) {
    writeFileSync(
      snapshotOut,
      JSON.stringify(
        {
          file,
          tableRowCount: rows.length,
          dispositionRowCount: dispositionRows.length,
          overWideRowCount: over.length,
          shapeHistogram: Object.fromEntries(tableShapeHistogram(text)),
          dispositionCounts: Object.fromEntries(dispositionCounts(text)),
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log('snapshot written:', snapshotOut);
  }

  process.exitCode = over.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
