/**
 * Regression coverage for the armed media swap (upstream PR #500's UI half):
 * arming waits for a replacement pick in the media grid, a refused
 * replacement keeps the arm so another tile can be picked, and an edit that
 * moves the clip under the arm cancels it instead of swapping a stale target.
 *
 * Runs against the real stores and a real EditorController, because the
 * value under test is exactly the bridge between them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useMediaPanelStore } from './media-panel';
import { useTimelineStore } from './timeline';
import { useProjectStore } from './project';
import { EditorController } from '../../shared/editor/controller';

function fixture() {
  const controller = useTimelineStore.getState().controller;
  controller.addMedia({
    id: 'video-a',
    path: '/test/a.mp4',
    filename: 'a.mp4',
    type: 'video',
    duration: 900,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  controller.addMedia({
    id: 'video-short',
    path: '/test/short.mp4',
    filename: 'short.mp4',
    type: 'video',
    duration: 50,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  const clipId = controller.addClip({
    assetId: 'video-a',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 100,
  }) as string;
  return { controller, clipId };
}

beforeEach(() => {
  // A fresh controller per test, so neither clips nor media leak between
  // cases; the panel state resets alongside.
  useTimelineStore.setState({
    controller: new EditorController(),
    project: new EditorController().getProject(),
  });
  useMediaPanelStore.setState({ armedSwap: null, notice: null });
});

describe('armed media swap (#500)', () => {
  it('arms with the clip edit-state fingerprint and toggles off on the same clip', () => {
    const { clipId } = fixture();
    const store = useMediaPanelStore.getState();

    store.armMediaSwap(clipId);
    expect(useMediaPanelStore.getState().armedSwap).toMatchObject({ clipId });

    // Same menu item again = cancel.
    useMediaPanelStore.getState().armMediaSwap(clipId);
    expect(useMediaPanelStore.getState().armedSwap).toBeNull();
  });

  it('completes against the controller and clears the arm', () => {
    const { controller, clipId } = fixture();
    useMediaPanelStore.getState().armMediaSwap(clipId);

    const result = useMediaPanelStore.getState().completeArmedSwap('video-a');

    expect(result).toEqual({ swapped: true });
    expect(useMediaPanelStore.getState().armedSwap).toBeNull();
    expect(controller.getClips().find((c) => c.id === clipId)?.assetId).toBe('video-a');
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(true);
  });

  it('arming an unknown clip is a no-op', () => {
    fixture();
    useMediaPanelStore.getState().armMediaSwap('ghost');
    expect(useMediaPanelStore.getState().armedSwap).toBeNull();
  });

  it('keeps the arm and surfaces the refusal when the pick is ineligible', () => {
    const { controller, clipId } = fixture();
    useMediaPanelStore.getState().armMediaSwap(clipId);

    const result = useMediaPanelStore.getState().completeArmedSwap('video-short');

    expect(result).toEqual({ swapped: false });
    expect(useMediaPanelStore.getState().armedSwap).toMatchObject({ clipId });
    expect(useMediaPanelStore.getState().notice).toMatch(/too short/i);
    // Nothing was swapped.
    expect(controller.getClips().find((c) => c.id === clipId)?.assetId).toBe('video-a');
  });

  it('cancels instead of swapping when the timeline moved the clip', async () => {
    const { controller, clipId } = fixture();
    useMediaPanelStore.getState().armMediaSwap(clipId);
    // The user nudges the clip after arming.
    controller.moveClip(clipId, 40);

    const result = useMediaPanelStore.getState().completeArmedSwap('video-short');

    expect(result).toEqual({ swapped: false });
    expect(useMediaPanelStore.getState().armedSwap).toBeNull();
    expect(useMediaPanelStore.getState().notice).toMatch(/cancelled/i);
    expect(controller.getClips().find((c) => c.id === clipId)?.assetId).toBe('video-a');
  });

  it('is inert with nothing armed', () => {
    fixture();
    expect(useMediaPanelStore.getState().completeArmedSwap('anything')).toEqual({ swapped: false });
    expect(useMediaPanelStore.getState().notice).toBeNull();
  });

  it('disappears when the armed clip is removed from the timeline', () => {
    const { controller, clipId } = fixture();
    useMediaPanelStore.getState().armMediaSwap(clipId);
    controller.removeClips([clipId]);

    expect(controller.getClips().find((c) => c.id === clipId)).toBeUndefined();
    // The next completion attempt sees the missing clip and cancels cleanly.
    const result = useMediaPanelStore.getState().completeArmedSwap('video-a');
    expect(result).toEqual({ swapped: false });
    expect(useMediaPanelStore.getState().armedSwap).toBeNull();
  });
});
