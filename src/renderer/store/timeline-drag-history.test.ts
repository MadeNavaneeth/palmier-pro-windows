/**
 * Clip-drag history: a drag's frames are a private preview, never a shared-stack
 * undo.
 *
 * A drag used to collapse each frame by calling `controller.undo()`, which pops
 * whatever is on top of the SHARED `CommandHistory`. An AI edit adopted from
 * main mid-drag (`useEditorSync` -> `adoptProject` -> `ReplaceProjectCommand`)
 * lands on that same stack, so the next pointer move reverted the AGENT's edit
 * instead of the drag's own frame, and Escape reverted it wholesale. These pin
 * the contract that replaced it: frames are applied without publishing, one
 * entry is published when the gesture ends, and a frame collapse reverts only
 * what that frame wrote.
 *
 * Every case is driven through the real store and the real controller, the way
 * `useDragHandler` drives them, with pixel offsets converted through the
 * viewport's own `pixelsPerFrame`.
 */

import { describe, it, expect } from 'vitest';
import { useTimelineStore } from './timeline';
import type { EditorController } from '../../shared/editor/controller';
import type { Clip, Project } from '../../shared/types/project';

const AGENT_CLIP_ID = 'agent-clip';

/** A fresh empty project, one asset, one clip at frame 0, and no snapping. */
function seedProject(): {
  store: typeof useTimelineStore;
  controller: EditorController;
  clipId: string;
  seeded: string | null;
} {
  const store = useTimelineStore;
  const { controller } = store.getState();
  controller.reset();
  controller.addMedia({
    id: 'drag-asset',
    path: '/test/drag.mp4',
    filename: 'drag.mp4',
    type: 'video',
    duration: 1000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  const clipId = controller.addClip({
    assetId: 'drag-asset',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 100,
  });
  // Snapping is on by default; the frames here are stated in exact frames.
  if (store.getState().snapEnabled) store.getState().toggleSnap();
  // Whatever the seed's own last entry is called: a drag must leave it alone.
  return { store, controller, clipId, seeded: controller.getLastCommandDescription() };
}

/** Pointer X that lands `frames` frames away from where the drag started. */
function pointerAt(store: typeof useTimelineStore, startX: number, frames: number): number {
  return startX + frames * store.getState().viewport.pixelsPerFrame;
}

function clipById(controller: EditorController, id: string): Clip | undefined {
  return controller.getClips().find((clip) => clip.id === id);
}

/**
 * What main hands the renderer when the agent edits: the whole project as JSON,
 * carrying changes the drag cannot have written. It adds a clip in the SAME
 * scope the drag is editing and dims the very clip being dragged, so a collapse
 * that reverts the whole scope, or the whole project, is visible in the result.
 */
function agentEditedProject(controller: EditorController, at = 400): Project {
  const project = JSON.parse(JSON.stringify(controller.getProject())) as Project;
  const template = project.timeline.clips[0]!;
  project.timeline.clips = [
    ...project.timeline.clips.map((clip) => (clip.id === template.id ? { ...clip, opacity: 0.25 } : clip)),
    { ...template, id: AGENT_CLIP_ID, startFrame: at, opacity: 1 },
  ];
  return project;
}

/** The agent's edit, adopted mid-drag exactly as `useEditorSync` adopts it. */
function adoptAgentEdit(controller: EditorController, at?: number): void {
  controller.adoptProject(agentEditedProject(controller, at), 'AI edit');
}

describe('clip drag history', () => {
  it('previews every frame from the gesture start and publishes nothing until mouse-up', () => {
    const { store, controller, clipId, seeded } = seedProject();
    const startX = 200;

    store.getState().startDrag('move', clipId, startX, 0);
    // Absolute from the start, not accumulated: the second move is +25, not
    // +35, and the third is +40, not +75.
    for (const [frames, expected] of [[10, 10], [25, 25], [40, 40]] as const) {
      store.getState().updateDrag(pointerAt(store, startX, frames));
      expect(clipById(controller, clipId)!.startFrame).toBe(expected);
      // Nothing has reached the undo stack: the seed's add is still the last entry.
      expect(controller.getLastCommandDescription()).toBe(seeded);
    }

    store.getState().endDrag();

    expect(clipById(controller, clipId)!.startFrame).toBe(40);
    // The gesture is ONE entry, and it is the same command the domain
    // operation publishes on its own ('Move clip' / replaceClips).
    expect(controller.getLastCommandDescription()).toBe('replaceClips');
    // One undo reverts the whole drag, not just its last frame.
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)!.startFrame).toBe(0);
    // The next undo is the add that preceded the drag: the drag took one entry.
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)).toBeUndefined();
  });

  it('re-derives a trim from the gesture start rather than compounding frames', () => {
    const { store, controller, clipId, seeded } = seedProject();
    const startX = 200;

    store.getState().startDrag('trim-right', clipId, startX, 0);
    store.getState().updateDrag(pointerAt(store, startX, 10));
    expect(clipById(controller, clipId)!.outPoint).toBe(110);
    // A trim is a RELATIVE delta, so a frame that failed to close the previous
    // one would compound to 120 here instead of reading 110 again.
    store.getState().updateDrag(pointerAt(store, startX, 25));
    expect(clipById(controller, clipId)!.outPoint).toBe(125);
    expect(controller.getLastCommandDescription()).toBe(seeded);

    store.getState().endDrag();
    expect(clipById(controller, clipId)!.outPoint).toBe(125);
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)!.outPoint).toBe(100);
  });

  it('keeps an AI edit adopted mid-drag when the drag ends', () => {
    const { store, controller, clipId } = seedProject();
    const startX = 200;

    store.getState().startDrag('move', clipId, startX, 0);
    store.getState().updateDrag(pointerAt(store, startX, 20));
    adoptAgentEdit(controller);
    store.getState().updateDrag(pointerAt(store, startX, 45));
    store.getState().endDrag();

    // The drag landed where the pointer is...
    expect(clipById(controller, clipId)!.startFrame).toBe(45);
    // ...and the agent's edit is still in the project: its added clip survived
    // the frame collapses, and so did its change to the dragged clip.
    expect(clipById(controller, AGENT_CLIP_ID)?.startFrame).toBe(400);
    expect(clipById(controller, clipId)!.opacity).toBe(0.25);
  });

  it('keeps an AI edit adopted mid-drag when the drag is cancelled with Escape', () => {
    const { store, controller, clipId } = seedProject();
    const startX = 200;

    store.getState().startDrag('move', clipId, startX, 0);
    store.getState().updateDrag(pointerAt(store, startX, 20));
    adoptAgentEdit(controller);
    store.getState().updateDrag(pointerAt(store, startX, 45));
    store.getState().cancelDrag();

    // Escape reverts the DRAG, not the agent's edit.
    expect(clipById(controller, clipId)!.startFrame).toBe(0);
    expect(clipById(controller, clipId)!.opacity).toBe(0.25);
    expect(clipById(controller, AGENT_CLIP_ID)?.startFrame).toBe(400);
    // A cancelled drag publishes nothing, so the agent's own entry is still the
    // newest one on the stack.
    expect(controller.getLastCommandDescription()).toBe('replaceProject');
  });

  it('leaves the agent entry on the stack so undo of the drag spares it', () => {
    const { store, controller, clipId } = seedProject();
    const startX = 200;

    store.getState().startDrag('move', clipId, startX, 0);
    store.getState().updateDrag(pointerAt(store, startX, 20));
    adoptAgentEdit(controller);
    store.getState().updateDrag(pointerAt(store, startX, 45));
    store.getState().endDrag();

    // The drag's entry is on top of the agent's, not in place of it.
    expect(controller.getLastCommandDescription()).toBe('replaceClips');
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)!.startFrame).toBe(0);
    // The agent's edit was not consumed by the drag's undo.
    expect(clipById(controller, AGENT_CLIP_ID)?.startFrame).toBe(400);
    expect(clipById(controller, clipId)!.opacity).toBe(0.25);
    // And it is still undoable in its own right: the agent's ReplaceProjectCommand
    // remains the entry underneath (it restores the snapshot captured when it
    // landed, which is why only the agent's own change is asserted here).
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, AGENT_CLIP_ID)).toBeUndefined();
  });

  it('does not let a mid-drag AI edit corrupt the frames that follow it', () => {
    const { store, controller, clipId } = seedProject();
    const startX = 200;

    store.getState().startDrag('move', clipId, startX, 0);
    store.getState().updateDrag(pointerAt(store, startX, 15));
    adoptAgentEdit(controller);
    // Every later frame is re-derived from the gesture start, so the frames
    // after the agent's edit land exactly where the pointer is, and the
    // agent's clip stays where the agent put it.
    for (const frames of [30, 55, 70]) {
      store.getState().updateDrag(pointerAt(store, startX, frames));
      expect(clipById(controller, clipId)!.startFrame).toBe(frames);
      expect(clipById(controller, AGENT_CLIP_ID)?.startFrame).toBe(400);
    }

    store.getState().endDrag();
    expect(clipById(controller, clipId)!.startFrame).toBe(70);
    expect(clipById(controller, AGENT_CLIP_ID)?.startFrame).toBe(400);
  });

  it('keeps an AI edit adopted mid-drag through a ripple trim', () => {
    // A ripple trim is the one drag frame whose command replaces the WHOLE
    // project (clips and markers together), so it is the frame a collapse
    // cannot roll back by undoing that command.
    const { store, controller, clipId } = seedProject();
    const startX = 200;
    const followerId = controller.addClip({
      assetId: 'drag-asset',
      trackId: 'v1',
      startFrame: 150,
      durationFrames: 100,
    });
    controller.changeTimelineMarkers({ creates: [{ name: 'M', startFrame: 300 }] });
    const markerId = controller.getMarkers()[0]!.id;

    store.getState().startDrag('trim-right', clipId, startX, 0, true);
    store.getState().updateDrag(pointerAt(store, startX, 20));
    adoptAgentEdit(controller, 500);
    store.getState().updateDrag(pointerAt(store, startX, 40));
    store.getState().endDrag();

    // The drag landed at the pointer (+40 from the gesture start, not +60).
    expect(clipById(controller, clipId)!.outPoint).toBe(140);
    // Still the one entry the operation publishes on its own: a ripple trim's
    // whole-project replace, committed once.
    expect(controller.getLastCommandDescription()).toBe('replaceProject');
    // The ripple shifted what follows the trimmed clip, the agent's new clip
    // included, and carried the marker — none of it twice.
    expect(clipById(controller, followerId)!.startFrame).toBe(190);
    expect(clipById(controller, AGENT_CLIP_ID)?.startFrame).toBe(540);
    expect(controller.getMarkers()[0]!.startFrame).toBe(340);
    // And the agent's own change to the trimmed clip is still there.
    expect(clipById(controller, clipId)!.opacity).toBe(0.25);
    expect(markerId).not.toBe('');
  });

  it('treats a drag that wanders back to its start as having moved nothing', () => {
    const { store, controller, clipId, seeded } = seedProject();
    const startX = 200;

    store.getState().startDrag('move', clipId, startX, 0);
    store.getState().updateDrag(pointerAt(store, startX, 30));
    expect(clipById(controller, clipId)!.startFrame).toBe(30);
    // Back to zero: the frame closes the previous one and stages nothing.
    store.getState().updateDrag(startX);
    expect(clipById(controller, clipId)!.startFrame).toBe(0);
    store.getState().endDrag();

    expect(controller.getLastCommandDescription()).toBe(seeded);
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)).toBeUndefined();
  });

  it('does not let a refused frame collapse an unrelated history entry', () => {
    const { store, controller, clipId } = seedProject();
    const startX = 200;
    // A locked track refuses the move, so no frame is ever staged; the next
    // frame must not reach for the shared stack to close a frame that is not
    // there (which used to undo whatever entry happened to be on top).
    const locked = () => controller.getTracks().find((track) => track.id === 'v1')!.locked;
    controller.setTrackLocked('v1', true);

    store.getState().startDrag('move', clipId, startX, 0);
    store.getState().updateDrag(pointerAt(store, startX, 30));
    store.getState().updateDrag(pointerAt(store, startX, 60));
    expect(clipById(controller, clipId)!.startFrame).toBe(0);
    store.getState().endDrag();
    // The lock is still the newest entry: the drag published nothing at all.
    expect(controller.getLastCommandDescription()).toBe('replaceTracks');
    controller.setTrackLocked('v1', false);

    // Walking the whole stack: unlock, lock, add. No drag entry in between, so
    // the drag consumed nothing that was not its own.
    expect(controller.undo()).toBe(true);
    expect(locked()).toBe(true);
    expect(controller.undo()).toBe(true);
    expect(locked()).toBe(false);
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)).toBeUndefined();
  });
});
