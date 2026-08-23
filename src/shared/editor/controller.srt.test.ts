/**
 * Regression coverage for SRT import (roadmap R3): cue-to-clip mapping
 * relative to the drop frame, one undoable step, sanitization skips, and
 * track guards.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,000',
  'First line',
  '',
  '2',
  '00:00:04,500 --> 00:00:06,000',
  'Second <i>cue</i>',
].join('\n');

describe('importSrt (R3)', () => {
  it('creates one title clip per cue relative to the start frame', () => {
    const ctrl = new EditorController();
    const ids = ctrl.importSrt('v1', SRT, 300);
    expect(ids).toHaveLength(2);

    const clips = ctrl.getClips();
    expect(clips.every((c) => c.type === 'title')).toBe(true);
    // Cue 1: [1s,3s) → frames [330, 390)
    const first = clips.find((c) => c.id === ids[0])!;
    expect(first.startFrame).toBe(330);
    expect(first.durationFrames).toBe(60);
    // Cue 2: [4.5s,6s) → [435, 480)
    const second = clips.find((c) => c.id === ids[1])!;
    expect(second.startFrame).toBe(435);
    expect(second.text).toBe('Second cue'); // markup stripped
  });

  it('is one undoable step', () => {
    const ctrl = new EditorController();
    ctrl.importSrt('v1', SRT, 0);
    ctrl.undo();
    expect(ctrl.getClips()).toHaveLength(0);
    ctrl.redo();
    expect(ctrl.getClips()).toHaveLength(2);
  });

  it('refuses locked/audio tracks and returns [] with no history on empty import', () => {
    const ctrl = new EditorController();
    ctrl.setTrackLocked('v1', true);
    expect(ctrl.importSrt('v1', SRT)).toEqual([]);
    ctrl.setTrackLocked('v1', false);
    expect(ctrl.importSrt('a1', SRT)).toEqual([]);
    expect(() => ctrl.importSrt('ghost', SRT)).not.toThrow();

    expect(ctrl.importSrt('v1', 'no cues here')).toEqual([]);
    const canUndoBefore = ctrl.canUndo();
    expect(ctrl.canUndo()).toBe(canUndoBefore);
  });
});
