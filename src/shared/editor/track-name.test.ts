/**
 * Regression coverage for track naming (upstream PR #520).
 *
 * Upstream's rules: trim surrounding whitespace, refuse control characters and
 * line breaks, cap the length, and treat an empty result as "restore the
 * generated label" rather than as a name of nothing.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { resolveTrackName, TRACK_NAME_MAX_LENGTH } from './track-name';

describe('resolveTrackName', () => {
  it('trims surrounding whitespace', () => {
    expect(resolveTrackName('  Interview  ', 'Video 1')).toBe('Interview');
  });

  it('resolves an empty name to the generated default', () => {
    expect(resolveTrackName('', 'Audio 2')).toBe('Audio 2');
    expect(resolveTrackName('   ', 'Audio 2')).toBe('Audio 2');
  });

  it('refuses control characters and newlines', () => {
    expect(resolveTrackName('line1\nline2', 'Video 1')).toBeNull();
    expect(resolveTrackName('a\tb', 'Video 1')).toBeNull();
    expect(resolveTrackName('bad\u0000name', 'Video 1')).toBeNull();
  });

  it('refuses names over the length cap', () => {
    expect(resolveTrackName('x'.repeat(TRACK_NAME_MAX_LENGTH), 'V')).toBe(
      'x'.repeat(TRACK_NAME_MAX_LENGTH),
    );
    expect(resolveTrackName('x'.repeat(TRACK_NAME_MAX_LENGTH + 1), 'V')).toBeNull();
  });
});

describe('EditorController.setTrackName', () => {
  function controllerWithTracks() {
    const ctrl = new EditorController();
    // Default project has v1/a1; add one more of each for position testing.
    ctrl.addTrack('video', 'Video 2');
    ctrl.addTrack('audio', 'Audio 2');
    return ctrl;
  }

  it('renames a track as one undoable step', () => {
    const ctrl = controllerWithTracks();
    const trackId = ctrl.getTracks()[0].id;

    expect(ctrl.setTrackName(trackId, 'Interview')).toBe(true);
    expect(ctrl.getTracks().find((t) => t.id === trackId)?.name).toBe('Interview');

    ctrl.undo();
    expect(ctrl.getTracks().find((t) => t.id === trackId)?.name).toBe('Video 1');
    ctrl.redo();
    expect(ctrl.getTracks().find((t) => t.id === trackId)?.name).toBe('Interview');
  });

  it('restores the generated label when cleared', () => {
    const ctrl = controllerWithTracks();
    const secondVideo = ctrl.getTracks().find((t) => t.name === 'Video 2')!;

    ctrl.setTrackName(secondVideo.id, 'B-roll');
    ctrl.setTrackName(secondVideo.id, '');
    expect(ctrl.getTracks().find((t) => t.id === secondVideo.id)?.name).toBe('Video 2');
  });

  it('refuses invalid names without touching history', () => {
    const ctrl = controllerWithTracks();
    const trackId = ctrl.getTracks()[0].id;
    const canUndoBefore = ctrl.canUndo();

    expect(ctrl.setTrackName(trackId, 'bad\nname')).toBe(false);
    expect(ctrl.getTracks().find((t) => t.id === trackId)?.name).toBe('Video 1');
    expect(ctrl.canUndo()).toBe(canUndoBefore);
  });

  it('treats an unchanged name as a no-op', () => {
    const ctrl = controllerWithTracks();
    const trackId = ctrl.getTracks()[0].id;
    const canUndoBefore = ctrl.canUndo();

    expect(ctrl.setTrackName(trackId, '  Video 1  ')).toBe(false);
    expect(ctrl.canUndo()).toBe(canUndoBefore);
  });

  it('returns false for an unknown track', () => {
    const ctrl = controllerWithTracks();
    expect(ctrl.setTrackName('nope', 'X')).toBe(false);
  });
});
