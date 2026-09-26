/**
 * The import outcome the media bin shows: a success, a failure, and the
 * format's own omission notes (#154).
 *
 * The success line used to be written into the same state as the error text, so
 * "Imported: 3 clips, 0 titles, 2 tracks." rendered in the panel's red error
 * banner — a clean import read as a failure, and the amber omission box added
 * under it made the contradiction louder. Success and failure are separate
 * fields of one result value now, and these tests hold both the treatment and
 * the clearing: neither line can survive the other.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatImportSummary, ImportOutcome, type ImportResultState } from './MediaBin';

function counts(placedClips: number, titles: number, tracksCreated: number) {
  return { placedClips, titles, tracksCreated, skippedOffline: 0 };
}

function render(result: ImportResultState): string {
  return renderToStaticMarkup(React.createElement(ImportOutcome, { result }));
}

const NO_RESULT: ImportResultState = { error: '', summary: '', notes: [] };

describe('the counts line an import reports', () => {
  it('reads as a sentence and takes a singular form for one', () => {
    expect(formatImportSummary(counts(0, 0, 0), 0)).toBe('Imported: 0 clips, 0 titles, 0 tracks.');
    expect(formatImportSummary(counts(1, 1, 1), 0)).toBe('Imported: 1 clip, 1 title, 1 track.');
    expect(formatImportSummary(counts(3, 2, 2), 0)).toBe('Imported: 3 clips, 2 titles, 2 tracks.');
  });

  it('names the unresolvable assets only when there are some', () => {
    expect(formatImportSummary(counts(1, 0, 1), 0)).toBe('Imported: 1 clip, 0 titles, 1 track.');
    expect(formatImportSummary(counts(1, 0, 1), 1)).toBe('Imported: 1 clip, 0 titles, 1 track, 1 offline.');
    // "offline" is a label here, not a counted noun: it keeps its old shape.
    expect(formatImportSummary(counts(4, 1, 2), 3)).toBe('Imported: 4 clips, 1 title, 2 tracks, 3 offline.');
  });
});

describe('the outcome the media bin shows', () => {
  it('shows nothing at all when no import has reported', () => {
    expect(render(NO_RESULT)).toBe('');
  });

  it('never puts a successful import in the error banner', () => {
    const markup = render({ ...NO_RESULT, summary: 'Imported: 3 clips, 0 titles, 2 tracks.' });

    expect(markup).toContain('Imported: 3 clips, 0 titles, 2 tracks.');
    expect(markup).toContain('data-import-summary');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('text-emerald-400');
    // The panel's error treatment is for failures alone.
    expect(markup).not.toContain('text-red');
    expect(markup).not.toContain('role="alert"');
  });

  it('keeps a genuine failure in the red error banner, unsoftened', () => {
    const markup = render({ ...NO_RESULT, error: 'Could not import the XML file.' });

    expect(markup).toContain('Could not import the XML file.');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('border-red-500/40');
    expect(markup).toContain('bg-red-500/10');
    expect(markup).toContain('text-red-300');
    expect(markup).not.toContain('data-import-summary');
  });

  it('stacks a success, its omissions and nothing else', () => {
    const markup = render({
      error: '',
      summary: 'Imported: 1 clip, 1 title, 1 track.',
      notes: ['Asset-clip "Interview" has an unsupported timeMap: frameSampling must be "floor".'],
    });

    expect(markup).toContain('Imported: 1 clip, 1 title, 1 track.');
    expect(markup).toContain('Not imported (1):');
    expect(markup).toContain('Asset-clip');
    // Success stays emerald even with omissions under it: the import ran.
    expect(markup).toContain('text-emerald-400');
    expect(markup).toContain('text-amber-300');
    expect(markup).not.toContain('text-red');
  });
});

describe('a new import replaces the last one completely', () => {
  it('a failing import leaves no stale success line and no stale notes', () => {
    // What the bin did before the failure, and what it holds after it.
    const afterOk = render({
      error: '',
      summary: 'Imported: 3 clips, 2 titles, 2 tracks.',
      notes: ['effect-ref elements are skipped.'],
    });
    expect(afterOk).toContain('data-import-summary');

    const afterFail = render({
      ...NO_RESULT,
      error: 'The file has no usable <format frameDuration>.',
    });

    expect(afterFail).toContain('The file has no usable');
    expect(afterFail).toContain('role="alert"');
    expect(afterFail).not.toContain('data-import-summary');
    expect(afterFail).not.toContain('Not imported');
    expect(afterFail).not.toContain('effect-ref elements are skipped.');
  });

  it('a successful import leaves no stale error', () => {
    const afterFail = render({ ...NO_RESULT, error: 'Could not import the XML file.' });
    expect(afterFail).toContain('role="alert"');

    const afterOk = render({
      error: '',
      summary: 'Imported: 1 clip, 0 titles, 1 track.',
      notes: [],
    });

    expect(afterOk).toContain('data-import-summary');
    expect(afterOk).not.toContain('role="alert"');
    expect(afterOk).not.toContain('text-red');
    expect(afterOk).not.toContain('Could not import the XML file.');
  });
});
