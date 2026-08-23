/**
 * Regression coverage for title clips v1 (R3 foundation): creation at the
 * playhead, text sanitization refusals, undo, and text-only edits that
 * never touch timing.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

describe('title clips v1 (R3)', () => {
  it('adds a title clip on a video track with defaults', () => {
    const ctrl = new EditorController();
    const id = ctrl.addTitleClip({ trackId: 'v1', text: 'Hello' });
    expect(id).not.toBe('');
    const clip = ctrl.getClips().find((c) => c.id === id)!;
    expect(clip.type).toBe('title');
    expect(clip.text).toBe('Hello');
    expect(clip.durationFrames).toBe(Math.round(ctrl.getProject().settings.fps * 3));
  });

  it('lands at the playhead by default and is one undo step', () => {
    const ctrl = new EditorController();
    ctrl.setPlayhead(120);
    const id = ctrl.addTitleClip({ trackId: 'v1', text: 'Hi' });
    ctrl.undo();
    expect(ctrl.getClips().some((c) => c.id === id)).toBe(false);
    ctrl.redo();
    expect(ctrl.getClips()[0].startFrame).toBe(120);
  });

  it('refuses invalid text and audio/locked tracks', () => {
    const ctrl = new EditorController();
    ctrl.setTrackLocked('v1', true);
    expect(ctrl.addTitleClip({ trackId: 'v1', text: 'X' })).toBe('');
    ctrl.setTrackLocked('v1', false);
    expect(ctrl.addTitleClip({ trackId: 'a1', text: 'X' })).toBe('');
    expect(ctrl.addTitleClip({ trackId: 'v1', text: '   ' })).toBe('');
    expect(ctrl.getClips()).toHaveLength(0);
  });

  it('edits text without touching timing, refusing invalid input', () => {
    const ctrl = new EditorController();
    const id = ctrl.addTitleClip({ trackId: 'v1', text: 'First' });
    const before = ctrl.getClips()[0];

    expect(ctrl.setTitleText(id, 'Second draft')).toBe(true);
    const after = ctrl.getClips()[0];
    expect(after.text).toBe('Second draft');
    expect(after.startFrame).toBe(before.startFrame);
    expect(after.durationFrames).toBe(before.durationFrames);

    expect(ctrl.setTitleText(id, '')).toBe(false);
    expect(after.text ?? 'First').not.toBe('');
  });
});
