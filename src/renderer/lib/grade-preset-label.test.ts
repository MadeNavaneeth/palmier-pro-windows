/**
 * Unit coverage for the Inspector's preset-row display metadata (#157). The
 * repository has no DOM test setup, so the picker text, the "carries a shot"
 * predicate, and the clip→preset link resolution are pinned as pure functions.
 */

import { describe, expect, it } from 'vitest';
import { clipPresetLink, presetCarriesShot, presetOptionLabel } from './grade-preset-label';

describe('presetCarriesShot', () => {
  it('is false for a grade-only preset (no shot at all)', () => {
    expect(presetCarriesShot({})).toBe(false);
    expect(presetCarriesShot({ shot: undefined })).toBe(false);
  });

  it('is true once the stored shot normalizes to at least one field', () => {
    expect(presetCarriesShot({ shot: { rotation: 12 } })).toBe(true);
    expect(presetCarriesShot({ shot: { x: 0.2, opacity: 0.8 } })).toBe(true);
  });

  it('ignores a shot that narrows away to nothing (hostile or empty)', () => {
    expect(presetCarriesShot({ shot: {} })).toBe(false);
    expect(presetCarriesShot({ shot: 'not-an-object' })).toBe(false);
  });
});

describe('presetOptionLabel', () => {
  it('leaves a grade-only preset label bare', () => {
    expect(presetOptionLabel({ label: 'Neutral' })).toBe('Neutral');
  });

  it('suffixes a shot-carrying preset so the row says it moves framing too', () => {
    expect(presetOptionLabel({ label: 'Interview tight', shot: { scaleX: 1.2 } })).toBe(
      'Interview tight · grade + framing',
    );
  });

  it('keeps a hostile shot from claiming framing', () => {
    expect(presetOptionLabel({ label: 'Look', shot: 42 })).toBe('Look');
  });
});

describe('clipPresetLink', () => {
  const saved = [
    { id: 'user-1', label: 'Golden' },
    { id: 'user-2', label: 'Interview tight' },
  ];

  it('reports no link for a clip without one', () => {
    expect(clipPresetLink({}, saved)).toEqual({ kind: 'none' });
    expect(clipPresetLink({ gradePresetId: undefined }, saved)).toEqual({ kind: 'none' });
  });

  it('reports the saved label when the link resolves', () => {
    expect(clipPresetLink({ gradePresetId: 'user-1' }, saved)).toEqual({
      kind: 'linked',
      label: 'Golden',
    });
  });

  it('reports a dangling link when the preset no longer exists', () => {
    // A deleted preset leaves the link in place; it must not resolve to a name.
    expect(clipPresetLink({ gradePresetId: 'user-gone' }, saved)).toEqual({ kind: 'dangling' });
    expect(clipPresetLink({ gradePresetId: 'user-1' }, [])).toEqual({ kind: 'dangling' });
  });

  it('ignores a malformed link instead of rendering it', () => {
    for (const malformed of ['', ' ', 'has space', 'a'.repeat(65), 42, null, {}]) {
      expect(clipPresetLink({ gradePresetId: malformed }, saved)).toEqual({ kind: 'none' });
    }
  });
});
