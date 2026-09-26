/**
 * Shape-gesture history: the shape drag's frames are a private preview, never a
 * shared-stack undo.
 *
 * This drives the protocol the overlay actually ships (`applyShapeGestureFrame`,
 * `collapseShapeGestureFrame`, `commitShapeGesture` from `ShapeOverlay.tsx`),
 * against the real store and controller, so it tests the gesture rather than a
 * copy of it. The pointer wiring itself is not mounted here — the suite runs in
 * a node environment with no DOM — but every history decision the pointer
 * handlers make is one of these three calls.
 *
 * The contract, identical to the timeline clip drag: a frame is applied without
 * publishing, a frame collapse reverts only what that frame wrote, the release
 * publishes exactly one entry, and an AI edit adopted mid-gesture survives all
 * of it.
 */

import { describe, it, expect } from 'vitest';
import { useTimelineStore } from '../../store/timeline';
import { effectiveBox, type ProjectPoint } from '../../lib/shape-overlay';
import {
  applyShapeGestureFrame,
  collapseShapeGestureFrame,
  commitShapeGesture,
  type Gesture,
} from './ShapeOverlay';
import type { EditorController } from '../../../shared/editor/controller';
import type { Clip, Project } from '../../../shared/types/project';

const AGENT_CLIP_ID = 'agent-clip';

/** A shape on the timeline, selected, with the overlay enabled (root scope). */
function seedShape(): { controller: EditorController; clipId: string; seeded: string | null } {
  const { controller } = useTimelineStore.getState();
  controller.reset();
  const clipId = useTimelineStore.getState().addShapeAtPlayhead('rect');
  return { controller, clipId, seeded: controller.getLastCommandDescription() };
}

function clipById(controller: EditorController, id: string): Clip | undefined {
  return controller.getClips().find((clip) => clip.id === id);
}

/** A pointermove at project-space (x, y), the way the overlay computes one. */
function pointer(x: number, y = 0): ProjectPoint {
  return { x, y };
}

/** The gesture a body press starts: move mode, anchored at project origin. */
function beginMove(controller: EditorController, clipId: string): Gesture {
  const clip = clipById(controller, clipId)!;
  return {
    mode: 'move',
    pointerId: 1,
    clipId,
    startBox: effectiveBox(clip, controller.getPlayhead()),
    startPointer: pointer(0),
    lastPoint: pointer(0),
    frame: null,
  };
}

/** One processed pointermove, exactly as `handlePointerMove` drives it. */
function moveTo(gesture: Gesture, point: ProjectPoint): void {
  gesture.lastPoint = point;
  applyShapeGestureFrame(gesture, point, false);
}

/**
 * What main hands the renderer when the agent edits: the whole project as JSON.
 * It adds a clip in the SAME scope the gesture is editing and dims the very
 * shape being dragged, so a collapse that reverts the whole scope, or the whole
 * project, is visible in the result.
 */
function agentEditedProject(controller: EditorController): Project {
  const project = JSON.parse(JSON.stringify(controller.getProject())) as Project;
  const template = project.timeline.clips[0]!;
  project.timeline.clips = [
    ...project.timeline.clips.map((clip) => (clip.id === template.id ? { ...clip, opacity: 0.25 } : clip)),
    { ...template, id: AGENT_CLIP_ID, startFrame: 400, opacity: 1 },
  ];
  return project;
}

/** The agent's edit, adopted mid-gesture exactly as `useEditorSync` adopts it. */
function adoptAgentEdit(controller: EditorController): void {
  controller.adoptProject(agentEditedProject(controller), 'AI edit');
}

describe('shape transform gesture history', () => {
  it('previews every frame from the gesture start and publishes nothing until release', () => {
    const { controller, clipId, seeded } = seedShape();
    const startX = clipById(controller, clipId)!.x;
    const gesture = beginMove(controller, clipId);

    // Absolute from the gesture start, not accumulated: +25 lands 25 from the
    // start, and +40 lands 40, so a frame that failed to close the previous one
    // would read 65 here.
    for (const dx of [10, 25, 40]) {
      moveTo(gesture, pointer(dx));
      expect(clipById(controller, clipId)!.x).toBe(startX + dx);
      // Nothing has reached the undo stack: the add is still the last entry.
      expect(controller.getLastCommandDescription()).toBe(seeded);
    }

    commitShapeGesture(gesture);

    expect(clipById(controller, clipId)!.x).toBe(startX + 40);
    // The gesture is ONE entry, and it is the same command the step publishes
    // on its own ('Move shape' / setClipProperties).
    expect(controller.getLastCommandDescription()).toBe('setClipProperties');
    // One undo reverts the whole gesture, not just its last frame.
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)!.x).toBe(startX);
    // The next undo is the add that preceded the gesture.
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)).toBeUndefined();
  });

  it('keeps an AI edit adopted mid-gesture when the gesture commits', () => {
    const { controller, clipId } = seedShape();
    const gesture = beginMove(controller, clipId);

    moveTo(gesture, pointer(20));
    adoptAgentEdit(controller);
    moveTo(gesture, pointer(45));
    commitShapeGesture(gesture);

    // The gesture landed where the pointer is...
    expect(clipById(controller, clipId)!.x).toBe(gesture.startBox.x + 45);
    // ...and the agent's edit is still in the project: its added clip survived
    // the frame collapses, and so did its change to the dragged shape.
    expect(clipById(controller, AGENT_CLIP_ID)?.startFrame).toBe(400);
    expect(clipById(controller, clipId)!.opacity).toBe(0.25);
  });

  it('keeps an AI edit adopted mid-gesture when the gesture is cancelled with Escape', () => {
    const { controller, clipId } = seedShape();
    const startX = clipById(controller, clipId)!.x;
    const gesture = beginMove(controller, clipId);

    moveTo(gesture, pointer(20));
    adoptAgentEdit(controller);
    moveTo(gesture, pointer(45));
    collapseShapeGestureFrame(gesture); // What Escape and teardown both do.

    // Escape reverts the GESTURE, not the agent's edit.
    expect(clipById(controller, clipId)!.x).toBe(startX);
    expect(clipById(controller, clipId)!.opacity).toBe(0.25);
    expect(clipById(controller, AGENT_CLIP_ID)?.startFrame).toBe(400);
    // A cancelled gesture publishes nothing, so the agent's own entry is still
    // the newest one on the stack.
    expect(controller.getLastCommandDescription()).toBe('replaceProject');
  });

  it('leaves the agent entry on the stack so undo of the gesture spares it', () => {
    const { controller, clipId } = seedShape();
    const startX = clipById(controller, clipId)!.x;
    const gesture = beginMove(controller, clipId);

    moveTo(gesture, pointer(20));
    adoptAgentEdit(controller);
    moveTo(gesture, pointer(45));
    commitShapeGesture(gesture);

    // The gesture's entry is on top of the agent's, not in place of it.
    expect(controller.getLastCommandDescription()).toBe('setClipProperties');
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)!.x).toBe(startX);
    // The agent's edit was not consumed by the gesture's undo.
    expect(clipById(controller, AGENT_CLIP_ID)?.startFrame).toBe(400);
    expect(clipById(controller, clipId)!.opacity).toBe(0.25);
    // And it is still undoable in its own right: the agent's ReplaceProjectCommand
    // remains the entry underneath (it restores the snapshot captured when it
    // landed, which is why only the agent's own change is asserted here).
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, AGENT_CLIP_ID)).toBeUndefined();
  });

  it('does not let a mid-gesture AI edit corrupt the frames that follow it', () => {
    const { controller, clipId } = seedShape();
    const startX = clipById(controller, clipId)!.x;
    const gesture = beginMove(controller, clipId);

    moveTo(gesture, pointer(15));
    adoptAgentEdit(controller);
    // Every later frame is re-derived from the gesture start, so the frames
    // after the agent's edit land exactly where the pointer is, and the
    // agent's clip stays where the agent put it.
    for (const dx of [30, 55, 70]) {
      moveTo(gesture, pointer(dx));
      expect(clipById(controller, clipId)!.x).toBe(startX + dx);
      expect(clipById(controller, AGENT_CLIP_ID)?.startFrame).toBe(400);
    }

    commitShapeGesture(gesture);
    expect(clipById(controller, clipId)!.x).toBe(startX + 70);
    expect(clipById(controller, AGENT_CLIP_ID)?.startFrame).toBe(400);
  });

  it('drops the staged frame on teardown without publishing, leaving history alone', () => {
    // The case the clip drag has no equivalent for: the overlay unmounts
    // mid-gesture. Teardown must not reach for an entry that is not its own.
    const { controller, clipId } = seedShape();
    const startX = clipById(controller, clipId)!.x;
    const gesture = beginMove(controller, clipId);

    moveTo(gesture, pointer(30));
    expect(clipById(controller, clipId)!.x).toBe(startX + 30);
    // The preview is on screen and no entry was published for it.
    expect(controller.getLastCommandDescription()).not.toBe('setClipProperties');

    // The unmount cleanup is exactly this call.
    collapseShapeGestureFrame(gesture);

    // The transient is gone and the gesture added nothing to history: the add
    // that preceded it is still the newest entry, and one undo removes the clip
    // outright instead of stepping through the gesture.
    expect(clipById(controller, clipId)!.x).toBe(startX);
    expect(controller.getLastCommandDescription()).not.toBe('setClipProperties');
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)).toBeUndefined();
  });

  it('cannot be made to consume a neighbouring entry when teardown lands mid-gesture', () => {
    // Same teardown, but with an unrelated entry pushed while the gesture was in
    // flight — the shape of the defect: closing the frame used to pop whatever
    // was on top of the shared stack.
    const { controller, clipId } = seedShape();
    const startX = clipById(controller, clipId)!.x;
    const gesture = beginMove(controller, clipId);

    moveTo(gesture, pointer(30));
    controller.setTrackLocked('v1', true); // A published entry, mid-gesture.
    expect(controller.getLastCommandDescription()).toBe('replaceTracks');

    collapseShapeGestureFrame(gesture); // Teardown.

    // The gesture's transient is gone, the track lock is untouched, and the
    // gesture is still not on the stack at all.
    expect(clipById(controller, clipId)!.x).toBe(startX);
    expect(controller.getTracks().find((track) => track.id === 'v1')!.locked).toBe(true);
    expect(controller.getLastCommandDescription()).toBe('replaceTracks');
    controller.setTrackLocked('v1', false);
    expect(controller.undo()).toBe(true);
    expect(controller.getLastCommandDescription()).toBe('replaceTracks');
  });

  it('treats a press that never moved as adding no history at all', () => {
    const { controller, clipId, seeded } = seedShape();
    const startX = clipById(controller, clipId)!.x;
    const gesture = beginMove(controller, clipId);

    // Rounds to no movement → an unchanged draft → the controller skips it, so
    // no frame is staged and the release has nothing to publish.
    moveTo(gesture, pointer(0.4, -0.4));
    expect(gesture.frame).toBeNull();
    commitShapeGesture(gesture);

    expect(clipById(controller, clipId)!.x).toBe(startX);
    expect(controller.getLastCommandDescription()).toBe(seeded);
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)).toBeUndefined();
  });

  it('treats a gesture that wanders back to its start as having moved nothing', () => {
    const { controller, clipId, seeded } = seedShape();
    const startX = clipById(controller, clipId)!.x;
    const gesture = beginMove(controller, clipId);

    moveTo(gesture, pointer(30));
    expect(clipById(controller, clipId)!.x).toBe(startX + 30);
    // Back to the start: the frame closes the previous one and stages nothing.
    moveTo(gesture, pointer(0));
    expect(gesture.frame).toBeNull();
    expect(clipById(controller, clipId)!.x).toBe(startX);
    commitShapeGesture(gesture);

    expect(controller.getLastCommandDescription()).toBe(seeded);
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)).toBeUndefined();
  });

  it('previews and commits a rotate step through the same protocol', () => {
    const { controller, clipId, seeded } = seedShape();
    const clip = clipById(controller, clipId)!;
    const gesture: Gesture = {
      mode: 'rotate',
      pointerId: 2,
      clipId,
      startBox: effectiveBox(clip, controller.getPlayhead()),
      startPointer: pointer(0, 0),
      lastPoint: pointer(0, 0),
      frame: null,
    };

    // A quarter turn about the box pivot: the rotation is the one property the
    // rotate mode writes, so it is the whole assertion.
    moveTo(gesture, pointer(0, gesture.startBox.height));
    expect(clipById(controller, clipId)!.rotation).not.toBe(clip.rotation);
    expect(controller.getLastCommandDescription()).toBe(seeded);

    commitShapeGesture(gesture);
    const rotated = clipById(controller, clipId)!.rotation;
    expect(rotated).not.toBe(clip.rotation);
    expect(controller.getLastCommandDescription()).toBe('setClipProperties');
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)!.rotation).toBe(clip.rotation);
  });
});
