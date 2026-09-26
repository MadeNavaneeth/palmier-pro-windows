/**
 * `setClipSpeed` must not be the thing that breaks a compound clip.
 *
 * THE DEFECT (measured, not inferred): the eligibility check refused `audio`
 * and `title` but not `compound`, while the mutator rewrites
 * `outPoint = inPoint + round(durationFrames * speed)`. A compound's
 * `inPoint`/`outPoint` ARE its window into the nested timeline, and compound
 * validation requires `durationFrames === outPoint - inPoint`
 * (`planFlatten`, `expandTimeline`). So the edit was accepted, the receipt said
 * it changed, and the compound then resolved to nothing in
 * `resolveRenderTimeline` and refused to flatten: a nested sequence
 * disappearing from preview and export, reported as success.
 *
 * Two ways in, both covered below:
 *  - the compound itself is the target;
 *  - the target is a plain clip LINKED to a compound. `linkClips` links any two
 *    clips of different media types and 'compound' is one, so a link group can
 *    hold a nest, and the same mutator would break that member while its
 *    partner looked fine. The group is therefore ineligible as a whole, the
 *    same all-or-nothing rule the title member already uses.
 *
 * LOUDNESS: the refusal throws rather than returning `false`, which is the
 * compound-area convention (`nestClips`, `flattenCompound`,
 * `openCompoundClip`) and the only shape either caller reads:
 *  - the agent tool receipt is built as
 *    `err instanceof Error ? err.message : 'Speed change failed.'`
 *    (src/main/ai/executor.ts, `set_clip_speed`), so a thrown Error carries the
 *    reason and a generic fallback would have hidden it;
 *  - the renderer store wraps the call in
 *    `try { … } catch { return false }` (src/renderer/store/timeline.ts),
 *    whose documented policy for these refusals is "select nothing rather than
 *    surfacing a toast on right-click". The wrapper is mirrored by
 *    `throughStoreWrapper` below so the UI contract is pinned here too.
 *  Both wrappers are exercised rather than restated: a `false` return that the
 *  context menu ignores is the silent refusal this guard exists to end.
 *
 * ALREADY-CORRUPTED STATE: a project saved while the defect existed can still
 * hold a compound whose `durationFrames !== outPoint - inPoint`. This lane does
 * NOT rewrite it on load or on flatten (see the report): the resolver already
 * refuses it and `planFlatten` already refuses it with a precise message, and
 * silently re-deriving `durationFrames` would change what a saved project
 * renders without telling anyone. `pinned: the resolver rejects an invalid
 * nested window` keeps that state visible instead of letting it drift.
 *
 * A sped-up CHILD inside a nest is a different thing and stays legal: a child
 * has real source, its window is what preview and export trim against, and
 * `expandTimeline` maps it through the shared source-time model. Over-refusing
 * would break that, so it is covered explicitly below.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { planFlatten, resolveRenderTimeline } from './compound';
import { createEmptyProject } from '../types/project';
import type { Clip, Frame, Project, Timeline, Track } from '../types/project';

const TRACK_ID = 'v1';

function videoTrack(): Track {
  return { id: TRACK_ID, name: 'V1', type: 'video', locked: false, visible: true, syncLocked: true, order: 0 };
}

function addAsset(controller: EditorController, id: string, filename: string): void {
  controller.addMedia({
    id, path: `/test/${filename}`, filename, type: 'video',
    duration: 5000, fileSize: 1, addedAt: '2026-07-29T00:00:00.000Z',
  });
}

/** A controller holding one plain visual clip on v1, plus its id. */
function controllerWithClip(
  assetId = 'asset-a',
  filename = 'a.mp4',
  startFrame: Frame = 0,
  durationFrames: Frame = 120,
): { ctrl: EditorController; clipId: string } {
  const ctrl = new EditorController();
  addAsset(ctrl, assetId, filename);
  const clipId = ctrl.addClip({ assetId, trackId: TRACK_ID, startFrame, durationFrames });
  return { ctrl, clipId };
}

/** The message a thrown refusal reports, or '' when the call did not throw. */
function refusalMessage(run: () => unknown): string {
  try {
    run();
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : '';
  }
}

/**
 * The exact wrapper the renderer store puts around the call
 * (src/renderer/store/timeline.ts, `setClipSpeed`): a refusal must degrade to
 * `false` there rather than escaping into the React onClick.
 */
function throughStoreWrapper(ctrl: EditorController, clipId: string, speed: number): boolean {
  try {
    return ctrl.setClipSpeed(clipId, speed);
  } catch {
    return false;
  }
}

function compounds(clips: Clip[]): Clip[] {
  return clips.filter((clip) => clip.type === 'compound');
}

/** True when every compound still satisfies the nested-window invariant. */
function windowsValid(clips: Clip[]): boolean {
  return compounds(clips).every((clip) => clip.durationFrames === clip.outPoint - clip.inPoint);
}

describe('setClipSpeed refuses a compound target', () => {
  it('throws a precise message, changes nothing, and leaves the nest rendering', () => {
    const { ctrl, clipId } = controllerWithClip();
    const nest = ctrl.nestClips([clipId]);
    const before = structuredClone(ctrl.getProject());
    const historyBefore = ctrl.getLastCommandDescription();

    // The refusal is loud and names the clip and the remedy.
    const message = refusalMessage(() => ctrl.setClipSpeed(nest.compoundClipId, 2));
    expect(message).toMatch(/cannot be sped up/);
    expect(message).toContain(nest.compoundClipId);

    // Nothing changed: no speed, no rescaled window, no undo entry.
    expect(ctrl.getProject()).toEqual(before);
    expect(ctrl.getLastCommandDescription()).toBe(historyBefore);
    const compound = ctrl.getClips()[0]!;
    expect(compound.type).toBe('compound');
    expect(compound.speed).toBeUndefined();
    expect(compound.outPoint).toBe(120);
    expect(compound.durationFrames).toBe(compound.outPoint - compound.inPoint);

    // The nested sequence still renders, and still flattens.
    const rendered = resolveRenderTimeline(ctrl.getProject()).clips;
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ id: clipId, inPoint: 0, outPoint: 120, durationFrames: 120 });
    expect(rendered[0]!.speed).toBeUndefined();
    expect(ctrl.flattenCompound(nest.compoundClipId).restoredClipIds).toEqual([clipId]);
    expect(ctrl.getClips().map((clip) => clip.id)).toEqual([clipId]);
  });

  it('refuses a linked group holding a compound without touching the group', () => {
    const { ctrl, clipId } = controllerWithClip();
    const nest = ctrl.nestClips([clipId]);
    // A second visual clip, then linked to the nest: `linkClips` only requires
    // two clips of different media types, and 'compound' is one.
    addAsset(ctrl, 'asset-b', 'b.mp4');
    const partnerId = ctrl.addClip({
      assetId: 'asset-b', trackId: TRACK_ID, startFrame: 200, durationFrames: 60,
    });
    ctrl.linkClips([nest.compoundClipId, partnerId]);
    const groupId = ctrl.getClips().find((clip) => clip.id === nest.compoundClipId)!.linkGroupId;
    expect(groupId).toBeDefined();
    expect(ctrl.getClips().find((clip) => clip.id === partnerId)!.linkGroupId).toBe(groupId);

    const before = structuredClone(ctrl.getProject());
    const historyBefore = ctrl.getLastCommandDescription();

    const message = refusalMessage(() => ctrl.setClipSpeed(partnerId, 2));
    expect(message).toMatch(/cannot be sped up/);
    expect(message).toContain(nest.compoundClipId);

    // The plain partner is NOT sped up either: no half-applied group.
    expect(ctrl.getProject()).toEqual(before);
    expect(ctrl.getLastCommandDescription()).toBe(historyBefore);
    expect(ctrl.getClips().find((clip) => clip.id === partnerId)!.speed).toBeUndefined();
    expect(windowsValid(ctrl.getClips())).toBe(true);

    // Both halves still render: the nest expands and the partner is a plain clip.
    const rendered = resolveRenderTimeline(ctrl.getProject()).clips;
    expect(rendered.map((clip) => clip.id).sort()).toEqual([clipId, partnerId].sort());
  });

  it('keeps durationFrames === outPoint - inPoint on a compound nobody sped up', () => {
    const { ctrl, clipId } = controllerWithClip();
    const nest = ctrl.nestClips([clipId]);
    expect(windowsValid(ctrl.getClips())).toBe(true);

    // Every refusal path, including the ones that only return false, and a trim
    // (the other writer of these fields) must leave the invariant intact.
    expect(throughStoreWrapper(ctrl, nest.compoundClipId, 2)).toBe(false);
    expect(throughStoreWrapper(ctrl, nest.compoundClipId, 0.5)).toBe(false);
    expect(throughStoreWrapper(ctrl, nest.compoundClipId, 99)).toBe(false);
    expect(throughStoreWrapper(ctrl, 'no-such-clip', 2)).toBe(false);
    ctrl.trimClip(nest.compoundClipId, 0, 90);
    ctrl.trimClip(nest.compoundClipId, 30, 90);

    expect(windowsValid(ctrl.getClips())).toBe(true);
    expect(resolveRenderTimeline(ctrl.getProject()).clips).toHaveLength(1);
    expect(() => ctrl.flattenCompound(nest.compoundClipId)).not.toThrow();
  });

  it('still speeds a plain clip INSIDE the nest (a sped-up child is legal)', () => {
    const { ctrl, clipId } = controllerWithClip();
    const nest = ctrl.nestClips([clipId]);
    ctrl.openNestedTimeline(nest.timelineId);

    expect(ctrl.setClipSpeed(clipId, 2)).toBe(true);
    const child = ctrl.getClips()[0]!;
    expect(child.speed).toBe(2);
    expect(child.outPoint - child.inPoint).toBe(240);

    // The compound itself is untouched and still valid.
    ctrl.navigateToScope(null);
    const compound = ctrl.getClips()[0]!;
    expect(compound.speed).toBeUndefined();
    expect(windowsValid([compound])).toBe(true);

    // The nest renders the sped-up child against the source it actually plays,
    // and flattens it with that window intact.
    const rendered = resolveRenderTimeline(ctrl.getProject()).clips;
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({
      id: clipId, inPoint: 0, outPoint: 240, durationFrames: 120, speed: 2,
    });
    expect(ctrl.flattenCompound(nest.compoundClipId).restoredClipIds).toEqual([clipId]);
    expect(ctrl.getClips().find((clip) => clip.id === clipId)!.outPoint - 0).toBe(240);
  });
});

describe('the refusal reaches the agent and the UI', () => {
  it('throws an Error, so the tool receipt carries the reason and not a fallback', () => {
    const { ctrl, clipId } = controllerWithClip();
    const nest = ctrl.nestClips([clipId]);

    // The agent boundary: `err instanceof Error ? err.message : 'Speed change
    // failed.'` — an Error is what makes the specific reason survive.
    let thrown: unknown;
    try {
      ctrl.setClipSpeed(nest.compoundClipId, 2);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toBe(
      `Compound clip "${nest.compoundClipId}" cannot be sped up. `
      + 'Set the speed on its clips inside the nest instead.',
    );

    // The UI boundary: the store's wrapper turns it into `false` instead of
    // letting the refusal escape into the context menu's onClick.
    expect(throughStoreWrapper(ctrl, nest.compoundClipId, 2)).toBe(false);
  });
});

describe('pinned: the resolver rejects an invalid nested window', () => {
  function mediaClip(overrides: Partial<Clip> = {}): Clip {
    return {
      id: 'clip',
      assetId: 'asset',
      type: 'video',
      trackId: TRACK_ID,
      startFrame: 0,
      durationFrames: 60,
      inPoint: 0,
      outPoint: 60,
      x: 0, y: 0, width: 1920, height: 1080, rotation: 0,
      scaleX: 1, scaleY: 1, opacity: 1, anchorX: 0, anchorY: 0,
      volume: 1, muted: false,
      ...overrides,
    };
  }

  /** The state the defect produced: speed written, outPoint scaled from it. */
  function corruptProject(): Project {
    const corrupt: Clip = {
      ...mediaClip({
        id: 'nest-clip',
        type: 'compound',
        assetId: '__compound__',
        durationFrames: 60,
        inPoint: 0,
        outPoint: 120,
        compoundTimelineId: 'leaf',
        speed: 2,
      }),
    };
    const leaf: Timeline = {
      tracks: [videoTrack()],
      clips: [mediaClip({ id: 'inner', durationFrames: 120, inPoint: 0, outPoint: 120 })],
      playheadFrame: 0,
      name: 'Leaf',
    };
    const base = createEmptyProject('corrupt nest');
    return {
      ...base,
      timeline: { ...base.timeline, tracks: [videoTrack()], clips: [corrupt] },
      timelines: { leaf },
    };
  }

  it('drops the compound from render and refuses the flatten', () => {
    const project = corruptProject();
    const corrupt = project.timeline.clips[0]!;
    expect(corrupt.durationFrames).not.toBe(corrupt.outPoint - corrupt.inPoint);
    // CURRENT CONTRACT: the resolver refuses the window rather than rendering
    // a nested timeline through a window it does not describe.
    expect(resolveRenderTimeline(project).clips).toEqual([]);
    expect(() => planFlatten(project, 'nest-clip')).toThrow(/invalid nested window/);
  });

  it('setClipSpeed neither creates nor worsens that state', () => {
    const ctrl = new EditorController(corruptProject());
    const before = structuredClone(ctrl.getProject());

    // Refused on type, exactly like a healthy compound.
    expect(throughStoreWrapper(ctrl, 'nest-clip', 2)).toBe(false);
    expect(ctrl.getProject()).toEqual(before);
    expect(windowsValid(ctrl.getClips())).toBe(false);
    expect(resolveRenderTimeline(ctrl.getProject()).clips).toEqual([]);
  });
});
