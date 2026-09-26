/**
 * Compound clips / nested sequences (upstream issue #155, slice 1).
 *
 * ORIGINAL DESIGN — the orchestrator verified upstream has no
 * compound/nested/sequence implementation at b4b1333, so there is nothing to
 * translate. What follows is built from this repo's own conventions instead:
 *
 * - A `compound` clip references a sub-timeline by id (`Project.timelines`).
 *   Its own `inPoint`/`outPoint`/`durationFrames` are the source window into
 *   that timeline — the exact contract media clips use against an asset — so
 *   trim, split, move, delete, and the shared source-time mapping
 *   (`shared/media/source-time.ts`) work on compounds unchanged.
 * - TIMEBASE RULE: every frame-valued field everywhere — main and nested
 *   timelines, compound in/out — is in PROJECT frames. Nested timelines have
 *   no independent fps; a project fps change rescales them with the same
 *   `rescaleTimelineFrames` the main timeline uses. The source-time helpers
 *   therefore apply verbatim, and nested fps-vs-project-fps mapping is a
 *   non-issue by construction.
 * - Absolute-frame keyframe tracks (`motionX/Y/Rot/ScaleX/ScaleY`,
 *   `volumeDb`) are rebased on nest (−minStart) and flatten (+offset) because
 *   they move across timelines; the render resolution shifts them back to
 *   absolute main-timeline frames so preview and export evaluate them with
 *   zero downstream changes.
 * - One user action is one undo step: `planNest`/`planFlatten` are pure
 *   planners (validate everything, then build the next project), and the
 *   controller commits each as a single `ReplaceProjectCommand`.
 * - Preview and export share `resolveRenderTimeline`: a compound expands to
 *   ordinary clips with composed transforms, so both paths consume identical
 *   geometry/timing. Cyclic, over-deep, or dangling compounds resolve to
 *   nothing — render never throws and never recurses unboundedly.
 *
 * Explicitly OUT of slice 1 (see the change report): a nested-timeline
 * editor UI (double-click to open, breadcrumbs), composing the compound's own
 * grade/effects/transition onto its content, and copying markers into nested
 * timelines.
 */

import { nanoid } from 'nanoid';
import type { Clip, Frame, Project, Timeline, Track } from '../types/project';
import { clampFrame } from '../utils/safe-number';
import { clampPan } from '../audio/pan';
import { effectiveSpeed } from '../media/source-time';

/** Synthetic asset id for compound clips, mirroring `__title__`/`__shape__`. */
export const COMPOUND_ASSET_ID = '__compound__';
/**
 * Deepest allowed nesting (main → … → leaf). Cycles are refused separately;
 * this cap bounds filter-graph label growth and preview decode fan-out for
 * pathologically deep (hand-edited) projects.
 */
export const MAX_COMPOUND_DEPTH = 8;

/** Max length of a user-supplied nested-sequence name. */
export const COMPOUND_NAME_MAX_LENGTH = 120;

// ─── Sanitize + narrow-on-read ───────────────────────────────────────────────

/** A usable nested-timeline reference: a non-empty string. */
export function sanitizeCompoundTimelineId(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

interface CompoundClipLike {
  type?: unknown;
  compoundTimelineId?: unknown;
}

/**
 * Narrow a stored clip's compound field on read: a hostile or hand-edited
 * value degrades to absent, and a non-compound clip carrying the field has it
 * stripped. A syntactically valid but DANGLING reference is kept — render
 * skips it and diagnostics reports it — so a load never destroys meaning.
 * Returns the input when clean.
 */
export function narrowCompoundClip<T extends CompoundClipLike>(clip: T): T {
  if (clip.type !== 'compound') {
    if (clip.compoundTimelineId === undefined) return clip;
    const next = { ...clip };
    delete next.compoundTimelineId;
    return next as T;
  }
  if (clip.compoundTimelineId === undefined) return clip;
  if (sanitizeCompoundTimelineId(clip.compoundTimelineId) !== undefined) return clip;
  const next = { ...clip };
  delete next.compoundTimelineId;
  return next as T;
}

/** Narrow every clip on the main and all nested timelines (load path). */
export function withNarrowedCompounds(project: Project): Project {
  let changed = false;
  const narrowList = (clips: Clip[]): Clip[] => clips.map((clip) => {
    const narrowed = narrowCompoundClip(clip);
    if (narrowed !== clip) changed = true;
    return narrowed;
  });
  const timeline = (() => {
    const clips = narrowList(project.timeline.clips);
    return clips === project.timeline.clips ? project.timeline : { ...project.timeline, clips };
  })();
  let timelines = project.timelines;
  if (timelines) {
    let timelinesChanged = false;
    const next: Record<string, Timeline> = {};
    for (const [id, nested] of Object.entries(timelines)) {
      const clips = narrowList(nested.clips);
      next[id] = clips === nested.clips ? nested : { ...nested, clips };
      if (next[id] !== nested) timelinesChanged = true;
    }
    if (timelinesChanged) {
      timelines = next;
      changed = true;
    }
  }
  if (!changed) return project;
  return timelines === project.timelines
    ? { ...project, timeline }
    : { ...project, timeline, timelines };
}

// ─── Editing scope (slice 2: in-place nested editing) ────────────────────────

/** Display name of the root timeline in breadcrumbs. */
export const MAIN_TIMELINE_NAME = 'Main';

/** One breadcrumb: the root (`id: null`) or a nested timeline. */
export interface TimelineBreadcrumb {
  id: string | null;
  name: string;
}

/**
 * Read one timeline by scope id (`null` = main). Throws a precise error for
 * a dangling id — opening or planning against a timeline that no longer
 * exists refuses instead of editing the wrong one.
 */
export function timelineInScope(project: Project, scopeId: string | null): Timeline {
  if (scopeId === null) return project.timeline;
  const nested = nestedTimelinesOf(project)[scopeId];
  if (!nested) throw new Error(`Nested timeline "${scopeId}" no longer exists.`);
  return nested;
}

/** Replant one timeline into its scope slot, leaving every other slot alone. */
export function withTimelineInScope(project: Project, scopeId: string | null, next: Timeline): Project {
  if (scopeId === null) return { ...project, timeline: next };
  return {
    ...project,
    timelines: { ...nestedTimelinesOf(project), [scopeId]: next },
  };
}

/** Display name of one scope slot (`null` = main). */
export function scopeDisplayName(project: Project, scopeId: string | null): string {
  if (scopeId === null) return MAIN_TIMELINE_NAME;
  return nestedTimelinesOf(project)[scopeId]?.name ?? 'Nested sequence';
}

/**
 * Breadcrumb chain from the root to `leafId` (`null` = root alone). Pure.
 * Returns null when the leaf is unreachable (dangling id, orphaned timeline,
 * or a hand-edited cycle) — callers refuse precisely instead of navigating
 * into a loop. First reference wins when two compounds share one timeline.
 */
export function timelineBreadcrumbs(project: Project, leafId: string | null): TimelineBreadcrumb[] | null {
  if (leafId === null) return [{ id: null, name: MAIN_TIMELINE_NAME }];
  const nested = nestedTimelinesOf(project);
  if (!nested[leafId]) return null;
  const parentOf = new Map<string, string | null>();
  const holders: Array<{ holder: string | null; clips: readonly Clip[] }> = [
    { holder: null, clips: project.timeline.clips },
    ...Object.entries(nested).map(([id, timeline]) => ({ holder: id as string | null, clips: timeline.clips })),
  ];
  for (const { holder, clips } of holders) {
    for (const ref of referencedIds(clips)) {
      if (nested[ref] !== undefined && !parentOf.has(ref)) parentOf.set(ref, holder);
    }
  }
  const chain: string[] = [leafId];
  const seen = new Set<string>([leafId]);
  let cursor: string | null = leafId;
  while (cursor !== null) {
    const parent = parentOf.get(cursor);
    if (parent === undefined) return null;
    if (parent !== null) {
      if (seen.has(parent)) return null;
      seen.add(parent);
      chain.unshift(parent);
    }
    cursor = parent;
  }
  return [
    { id: null, name: MAIN_TIMELINE_NAME },
    ...chain.map((id) => ({ id: id as string | null, name: nested[id]?.name ?? 'Nested sequence' })),
  ];
}

/** Edges from the root to `leafId`, or null when unresolvable (see above). */
export function nestedTimelineDepth(project: Project, leafId: string | null): number | null {
  const chain = timelineBreadcrumbs(project, leafId);
  return chain === null ? null : chain.length - 1;
}

/**
 * Longest compound-reference chain starting INSIDE `leafId` (0 when it holds
 * no compounds). Cycle-guarded: a revisit contributes nothing instead of
 * looping. Together with the breadcrumb distance above, this bounds the
 * render recursion reachable through the leaf.
 */
export function nestedSubtreeDepth(project: Project, leafId: string): number {
  const nested = nestedTimelinesOf(project);
  const walk = (id: string, seen: Set<string>): number => {
    const timeline = nested[id];
    if (!timeline || seen.has(id)) return 0;
    const next = new Set(seen);
    next.add(id);
    let depth = 0;
    for (const ref of referencedIds(timeline.clips)) {
      if (nested[ref] === undefined) continue;
      depth = Math.max(depth, 1 + walk(ref, next));
    }
    return depth;
  };
  return walk(leafId, new Set());
}

// ─── Graph validation ────────────────────────────────────────────────────────

type TimelineKey = string;

const MAIN_KEY = '\0main';

function timelineKeyOf(id: string | null): TimelineKey {
  return id === null ? MAIN_KEY : id;
}

function nestedTimelinesOf(project: Project): Record<string, Timeline> {
  return project.timelines ?? {};
}

/** Timeline ids referenced by compound clips inside one clip list. */
function referencedIds(clips: readonly Clip[]): string[] {
  const out: string[] = [];
  for (const clip of clips) {
    if (clip.type !== 'compound') continue;
    const ref = sanitizeCompoundTimelineId(clip.compoundTimelineId);
    if (ref !== undefined) out.push(ref);
  }
  return out;
}

/**
 * Validate the whole compound graph, returning precise error strings (empty
 * when valid). Covers dangling references, direct and transitive cycles, and
 * chains deeper than MAX_COMPOUND_DEPTH. Pure — used by diagnostics, tests,
 * and (via throws below) nest/flatten planning.
 */
export function validateCompoundGraph(project: Project): string[] {
  const errors: string[] = [];
  const nested = nestedTimelinesOf(project);

  const clipsByTimeline = new Map<TimelineKey, Clip[]>();
  clipsByTimeline.set(MAIN_KEY, project.timeline.clips);
  for (const [id, timeline] of Object.entries(nested)) {
    clipsByTimeline.set(timelineKeyOf(id), timeline.clips);
  }

  // Dangling references, per clip.
  const allClips: Clip[] = [...project.timeline.clips];
  for (const timeline of Object.values(nested)) allClips.push(...timeline.clips);
  for (const clip of allClips) {
    if (clip.type !== 'compound') continue;
    const ref = sanitizeCompoundTimelineId(clip.compoundTimelineId);
    if (ref === undefined) {
      errors.push(`Compound clip "${clip.id}" has no nested timeline reference.`);
    } else if (!nested[ref]) {
      errors.push(`Compound clip "${clip.id}" references unknown nested timeline "${ref}".`);
    }
  }

  // Cycles + depth via DFS over timeline → timeline edges.
  const adjacency = new Map<TimelineKey, string[]>();
  for (const [key, clips] of clipsByTimeline) {
    adjacency.set(
      key,
      referencedIds(clips).filter((ref) => nested[ref] !== undefined),
    );
  }
  const depthMemo = new Map<TimelineKey, number>();
  const visit = (key: TimelineKey, path: TimelineKey[]): number => {
    const cycleAt = path.indexOf(key);
    if (cycleAt !== -1) {
      const loop = [...path.slice(cycleAt), key].map((entry) =>
        (entry === MAIN_KEY ? '(main timeline)' : `"${entry}"`)).join(' → ');
      errors.push(`Nested timeline cycle refused: ${loop} contains itself.`);
      return 0;
    }
    const memoized = depthMemo.get(key);
    if (memoized !== undefined) return memoized;
    let depth = 0;
    for (const ref of adjacency.get(key) ?? []) {
      depth = Math.max(depth, 1 + visit(timelineKeyOf(ref), [...path, key]));
    }
    depthMemo.set(key, depth);
    return depth;
  };
  for (const key of clipsByTimeline.keys()) visit(key, []);

  // Depth cap: longest chain starting at any timeline.
  for (const [key, depth] of depthMemo) {
    if (depth > MAX_COMPOUND_DEPTH) {
      const label = key === MAIN_KEY ? 'The main timeline' : `Nested timeline "${key}"`;
      errors.push(
        `${label} nests ${depth} levels deep, past the maximum of ${MAX_COMPOUND_DEPTH}.`,
      );
    }
  }
  return [...new Set(errors)];
}

/** Nesting depth of one clip: 0 for plain clips, ≥1 for compounds (guarded). */
function compoundClipDepth(project: Project, clip: Clip, seen: Set<string>): number {
  if (clip.type !== 'compound') return 0;
  const ref = sanitizeCompoundTimelineId(clip.compoundTimelineId);
  if (ref === undefined || seen.has(ref)) return 1;
  const nested = nestedTimelinesOf(project)[ref];
  if (!nested) return 1;
  seen.add(ref);
  let child = 0;
  for (const inner of nested.clips) {
    child = Math.max(child, compoundClipDepth(project, inner, seen));
  }
  seen.delete(ref);
  return 1 + child;
}

// ─── Absolute-frame keyframe rebasing ────────────────────────────────────────

type KeyframePoint = { frame: number; value: number; easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' };

type KeyframedClip = Clip & {
  motionX?: KeyframePoint[];
  motionY?: KeyframePoint[];
  motionRot?: KeyframePoint[];
  motionScaleX?: KeyframePoint[];
  motionScaleY?: KeyframePoint[];
  volumeDb?: KeyframePoint[];
};

function shiftTrackPoints<
  T extends { frame: number },
>(points: readonly T[] | undefined, delta: number, scale = 1): T[] | undefined {
  if (!points) return undefined;
  // Keyframe frames are absolute in the clip's OWN timeline, so moving them
  // into render space is the same timeline→render map the placement uses: a
  // scale plus a delta. `scale` is 1 everywhere except under a nest whose
  // compound carries `speed !== 1`, where the frames are not just displaced.
  return points.map((point) => ({ ...point, frame: Math.round(point.frame * scale) + delta }));
}

/** Rebase every absolute-frame keyframe track by `delta` frames and a `scale`. */
function rebaseKeyframeTracks(clip: Clip, delta: number, scale = 1): Clip {
  if (delta === 0 && scale === 1) return clip;
  const keyframed = clip as KeyframedClip;
  if (
    !keyframed.motionX && !keyframed.motionY && !keyframed.motionRot
    && !keyframed.motionScaleX && !keyframed.motionScaleY && !keyframed.volumeDb
  ) {
    return clip;
  }
  return {
    ...clip,
    ...(keyframed.motionX ? { motionX: shiftTrackPoints(keyframed.motionX, delta, scale) } : {}),
    ...(keyframed.motionY ? { motionY: shiftTrackPoints(keyframed.motionY, delta, scale) } : {}),
    ...(keyframed.motionRot ? { motionRot: shiftTrackPoints(keyframed.motionRot, delta, scale) } : {}),
    ...(keyframed.motionScaleX ? { motionScaleX: shiftTrackPoints(keyframed.motionScaleX, delta, scale) } : {}),
    ...(keyframed.motionScaleY ? { motionScaleY: shiftTrackPoints(keyframed.motionScaleY, delta, scale) } : {}),
    ...(keyframed.volumeDb ? { volumeDb: shiftTrackPoints(keyframed.volumeDb, delta, scale) } : {}),
  };
}

// ─── Nest (selection → sub-timeline + compound clip) ─────────────────────────

export interface NestReceipt {
  compoundClipId: string;
  timelineId: string;
  timelineName: string;
  /** Every nested clip id, including auto-included linked partners. */
  nestedClipIds: string[];
  /** Timeline track the compound clip lands on (within the scope below). */
  trackId: string;
  startFrame: Frame;
  durationFrames: Frame;
  /** Scope the nest ran in (`null` = main timeline). */
  scopeTimelineId: string | null;
  /** Display name of that scope (`Main` at the root). */
  scopeName: string;
}

function expandLinkedClipIds(clips: readonly Clip[], clipIds: Iterable<string>): string[] {
  const requested = new Set(clipIds);
  const groupIds = new Set(
    clips
      .filter((clip) => requested.has(clip.id) && clip.linkGroupId)
      .map((clip) => clip.linkGroupId as string),
  );
  for (const clip of clips) {
    if (clip.linkGroupId && groupIds.has(clip.linkGroupId)) requested.add(clip.id);
  }
  return [...requested];
}

/**
 * Plan nesting clips into a new sub-timeline. Pure: validates everything
 * first (throws precise errors, mutates nothing), then returns the next
 * project plus the agent/UI receipt. `scopeTimelineId` selects the timeline
 * the selection lives in (`null`/omitted = main); the compound clip lands
 * back in that same scope.
 */
export function planNest(
  project: Project,
  clipIds: Iterable<string>,
  options: { name?: string; scopeTimelineId?: string | null } = {},
): { project: Project; receipt: NestReceipt } {
  const scopeId = options.scopeTimelineId ?? null;
  const source = timelineInScope(project, scopeId);
  const requested = [...new Set(clipIds)];
  if (requested.length === 0) {
    throw new Error('Nest requires at least one clip: pass the clip ids to group into the nested sequence.');
  }
  const byId = new Map(source.clips.map((clip) => [clip.id, clip] as const));
  for (const id of requested) {
    if (!byId.has(id)) throw new Error(`Clip not found: ${id}`);
  }

  // Linked partners nest together — the same auto-expansion remove, ripple
  // delete, move, and split apply, so a picture-plus-audio pair cannot be
  // torn in half by nesting one side.
  const nestedIds = expandLinkedClipIds(source.clips, requested);
  const nested = nestedIds.map((id) => byId.get(id) as Clip);

  const lockedTrackIds = new Set(
    source.tracks.filter((track) => track.locked).map((track) => track.id),
  );
  if (nested.some((clip) => lockedTrackIds.has(clip.trackId))) {
    throw new Error('One or more clips are on a locked track.');
  }

  const depth = 1 + Math.max(0, ...nested.map((clip) => compoundClipDepth(project, clip, new Set())));
  if (depth > MAX_COMPOUND_DEPTH) {
    throw new Error(
      `Nesting these clips would reach depth ${depth}, past the maximum of ${MAX_COMPOUND_DEPTH}.`,
    );
  }

  const startFrame = Math.min(...nested.map((clip) => clip.startFrame));
  const endFrame = Math.max(...nested.map((clip) => clip.startFrame + clip.durationFrames));
  const durationFrames = clampFrame(endFrame - startFrame, 1);

  const trackById = new Map(source.tracks.map((track) => [track.id, track] as const));
  const visualTracks = nested
    .filter((clip) => clip.type !== 'audio')
    .map((clip) => trackById.get(clip.trackId))
    .filter((track): track is Track => track !== undefined);
  const anchorTrack = visualTracks.length > 0
    ? visualTracks.reduce((top, track) => (track.order > top.order ? track : top))
    : trackById.get(nested[0]!.trackId);
  if (!anchorTrack) throw new Error('The nested clips reference a track that does not exist.');

  const existingCount = Object.keys(nestedTimelinesOf(project)).length;
  const rawName = options.name?.trim() ?? '';
  const timelineName = rawName.length > 0
    ? rawName.slice(0, COMPOUND_NAME_MAX_LENGTH)
    : `Compound ${existingCount + 1}`;
  const timelineId = nanoid();

  // Inner tracks keep their ids: each timeline is its own namespace (every
  // lookup resolves within one timeline object), so flatten restores clips to
  // their exact original tracks. Solo is UI-only state — never persisted —
  // and stays behind on the source timeline.
  const involvedTrackIds = new Set(nested.map((clip) => clip.trackId));
  const innerTracks = source.tracks
    .filter((track) => involvedTrackIds.has(track.id))
    .map((track) => {
      if (track.soloed === undefined) return track;
      const next = { ...track };
      delete next.soloed;
      return next;
    });
  // Keyframe tracks are keyed to absolute timeline frames, so they rebase
  // with the move; fades/transitions are clip-relative and travel untouched.
  const innerClips = nested.map((clip) => rebaseKeyframeTracks(
    { ...clip, startFrame: clip.startFrame - startFrame },
    -startFrame,
  ));

  const compoundClipId = nanoid();
  const compound: Clip = {
    id: compoundClipId,
    assetId: COMPOUND_ASSET_ID,
    type: 'compound',
    trackId: anchorTrack.id,
    startFrame,
    durationFrames,
    inPoint: 0,
    outPoint: durationFrames,
    x: 0,
    y: 0,
    width: project.settings.width,
    height: project.settings.height,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    anchorX: 0,
    anchorY: 0,
    volume: 1,
    muted: false,
    label: timelineName,
    compoundTimelineId: timelineId,
  };

  const nestedIdSet = new Set(nestedIds);
  const next: Project = withTimelineInScope(project, scopeId, {
    ...source,
    clips: [
      ...source.clips.filter((clip) => !nestedIdSet.has(clip.id)),
      compound,
    ],
  });
  // Plant the new sub-timeline alongside the (already replanted) scope slot.
  next.timelines = {
    ...next.timelines,
    [timelineId]: { tracks: innerTracks, clips: innerClips, playheadFrame: 0, name: timelineName },
  };
  next.updatedAt = new Date().toISOString();
  return {
    project: next,
    receipt: {
      compoundClipId,
      timelineId,
      timelineName,
      nestedClipIds: nestedIds,
      trackId: anchorTrack.id,
      startFrame,
      durationFrames,
      scopeTimelineId: scopeId,
      scopeName: scopeDisplayName(project, scopeId),
    },
  };
}

// ─── Flatten (compound clip → sub-timeline content back on main) ─────────────

export interface FlattenReceipt {
  compoundClipId: string;
  timelineId: string;
  /** Restored scope-timeline clip ids (remapped only on id collision). */
  restoredClipIds: string[];
  /** Scope-timeline track ids recreated because they were missing. */
  restoredTrackIds: string[];
  /** Scope the flatten ran in (`null` = main timeline). */
  scopeTimelineId: string | null;
  /** Display name of that scope (`Main` at the root). */
  scopeName: string;
}

/**
 * Plan flattening one compound clip one level: its referenced window lands
 * back in the scope timeline that holds the compound, inner compounds stay
 * nested. Pure: validates first (throws precise errors), then returns the
 * next project plus receipt. `options.scopeTimelineId` selects the holding
 * scope (`null`/omitted = main).
 */
export function planFlatten(
  project: Project,
  compoundClipId: string,
  options: { scopeTimelineId?: string | null } = {},
): { project: Project; receipt: FlattenReceipt } {
  const scopeId = options.scopeTimelineId ?? null;
  const source = timelineInScope(project, scopeId);
  const compound = source.clips.find((clip) => clip.id === compoundClipId);
  if (!compound) throw new Error(`Clip not found: ${compoundClipId}`);
  if (compound.type !== 'compound') {
    throw new Error(`Clip "${compoundClipId}" is not a compound clip.`);
  }
  const ref = sanitizeCompoundTimelineId(compound.compoundTimelineId);
  if (ref === undefined) {
    throw new Error(`Compound clip "${compoundClipId}" has no nested timeline reference.`);
  }
  const nested = nestedTimelinesOf(project)[ref];
  if (!nested) {
    throw new Error(`Nested timeline "${ref}" no longer exists.`);
  }
  const outerTrack = source.tracks.find((track) => track.id === compound.trackId);
  if (!outerTrack) throw new Error(`Compound clip "${compoundClipId}" is on a track that does not exist.`);
  if (outerTrack.locked) {
    throw new Error('One or more clips are on a locked track.');
  }
  if (
    !Number.isFinite(compound.inPoint) || !Number.isFinite(compound.outPoint)
    || compound.inPoint < 0 || compound.outPoint <= compound.inPoint
    || compound.durationFrames !== compound.outPoint - compound.inPoint
  ) {
    throw new Error(
      `Compound clip "${compoundClipId}" has an invalid nested window [${compound.inPoint}, ${compound.outPoint}).`,
    );
  }

  // The full nested content is restored (not just the referenced window), so
  // an outer trim never destroys material on flatten — visible content lands
  // exactly where it rendered.
  const frameShift = compound.startFrame - compound.inPoint;
  const existingIds = new Set(source.clips.map((clip) => clip.id));
  const remapped = new Map<string, string>();
  for (const clip of nested.clips) {
    if (existingIds.has(clip.id)) remapped.set(clip.id, nanoid());
  }

  const mainTrackIds = new Set(source.tracks.map((track) => track.id));
  const restoredTrackIds: string[] = [];
  const recreatedTracks: Track[] = [];
  for (const track of nested.tracks) {
    if (!mainTrackIds.has(track.id)) {
      restoredTrackIds.push(track.id);
      recreatedTracks.push({ ...track });
      mainTrackIds.add(track.id);
    }
  }

  const restoredClips = nested.clips.map((clip) => {
    const next: Clip = rebaseKeyframeTracks(
      { ...clip, id: remapped.get(clip.id) ?? clip.id, startFrame: clip.startFrame + frameShift },
      frameShift,
    );
    return next;
  });

  const updatedSource: Timeline = {
    ...source,
    tracks: [...source.tracks, ...recreatedTracks],
    clips: [
      ...source.clips.filter((clip) => clip.id !== compoundClipId),
      ...restoredClips,
    ],
  };
  const remainingTimelines = { ...nestedTimelinesOf(project) };
  if (scopeId !== null) remainingTimelines[scopeId] = updatedSource;
  // Refcount across every scope: the flattened compound is already gone from
  // the scan (the holding scope reads updated above), so a surviving
  // reference — a duplicate on the main timeline, a sibling nest, or a
  // hand-edited self-reference in the restored content — keeps the record.
  // (Slice 1's paste-shares-reference case included.)
  const stillReferenced = (clips: readonly Clip[]): boolean =>
    clips.some((clip) =>
      clip.type === 'compound'
      && sanitizeCompoundTimelineId(clip.compoundTimelineId) === ref
    );
  const survivors: Clip[] = [...restoredClips];
  if (scopeId === null) {
    survivors.push(...updatedSource.clips);
  } else {
    survivors.push(...project.timeline.clips);
  }
  for (const timeline of Object.values(remainingTimelines)) {
    if (timeline !== nested) survivors.push(...timeline.clips);
  }
  if (!stillReferenced(survivors)) {
    delete remainingTimelines[ref];
  }
  const next: Project = scopeId === null
    ? {
      ...project,
      timeline: updatedSource,
      ...(Object.keys(remainingTimelines).length > 0 ? { timelines: remainingTimelines } : {}),
      updatedAt: new Date().toISOString(),
    }
    : {
      ...project,
      // A nested scope normally survives (it holds the restored clips), but
      // a self-referential flatten can empty the whole record.
      timelines: remainingTimelines,
      updatedAt: new Date().toISOString(),
    };
  if (Object.keys(remainingTimelines).length === 0) delete next.timelines;
  return {
    project: next,
    receipt: {
      compoundClipId,
      timelineId: ref,
      restoredClipIds: restoredClips.map((clip) => clip.id),
      restoredTrackIds,
      scopeTimelineId: scopeId,
      scopeName: scopeDisplayName(project, scopeId),
    },
  };
}

// ─── Recursive render resolution ─────────────────────────────────────────────

interface NestContext {
  /** Namespace prefix for synthesized track ids ('' at the root). */
  namespace: string;
  /** Visible window in the CURRENT timeline's frames. */
  windowStart: number;
  windowEnd: number;
  /**
   * CURRENT-timeline frames → render frames: `render = frameScale * frame +
   * frameOffset`. Identity (1, 0) at the root.
   *
   * A SCALE, not a running sum of shifts. One compound's timeline→nested map
   * is `n = inPoint + (t - startFrame) * speed`, so the way back is
   * `t = startFrame + (n - inPoint) / speed`: already a scaled offset, and
   * composing two of those multiplies the scales where a sum of displacements
   * cannot express it. For a `speed: 1` nest every scale is 1 and every offset
   * an integer, which is exactly the additive shift this pair replaces.
   */
  frameScale: number;
  frameOffset: number;
  /** Composed outer transform (identity at the root). */
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  volume: number;
  pan: number;
  muted: boolean;
  /** Ancestor fade gates, in the CURRENT timeline's frames. */
  fadeIns: Array<{ start: number; length: number }>;
  fadeOuts: Array<{ start: number; length: number }>;
  /** Effective outer track (visibility/solo derive from it). */
  track: Track | null;
}

function rootContext(): NestContext {
  return {
    namespace: '',
    windowStart: Number.NEGATIVE_INFINITY,
    windowEnd: Number.POSITIVE_INFINITY,
    frameScale: 1,
    frameOffset: 0,
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    opacity: 1,
    volume: 1,
    pan: 0,
    muted: false,
    fadeIns: [],
    fadeOuts: [],
    track: null,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// ─── Timeline frames → source window (speed-aware) ───────────────────────────

/**
 * The source frame reached at `timelineFrame` inside `clip`.
 *
 * The frames-level form of the shared source-time model
 * (`shared/media/source-time.ts`):
 *
 *   sourceOffset = clip.inPoint + (timelineFrame - clip.startFrame) * speed
 *
 * `EditorController` derives the same value through its module-private
 * `sourceFrameAtBoundary`, so the rounding rule is restated here rather than
 * imported. What IS shared is the primitive both sides resolve speed through:
 * `effectiveSpeed` from `source-time.ts`, so garbage (`undefined`, `NaN`, a
 * negative) degrades to 1 identically in both. Nothing in this module multiplies
 * by a speed of its own — that omission is what trimmed a sped-up clip against
 * the wrong source window.
 */
function sourceFrameAtBoundary(clip: Clip, timelineFrame: Frame): Frame {
  return clip.inPoint
    + Math.round((timelineFrame - clip.startFrame) * effectiveSpeed(clip.speed));
}

/**
 * The source trim window for the timeline slice [start, end) of `clip`.
 *
 * Rounding: the start boundary rounds once (above) and the span rounds once,
 * with `outPoint` derived from the already-rounded `inPoint`. That is the shape
 * `setClipSpeed` writes — `outPoint = inPoint + round(durationFrames * speed)` —
 * so `outPoint - inPoint === round(durationFrames * speed)` holds for any
 * speed, and an emitted clip can never claim more or less source than its own
 * duration says. It is also the controller's `sourceWindowForSlice` contract,
 * restated, so a nested window and a main-timeline one are the same object.
 *
 * `speed: 1` is frame-for-frame the speed-free arithmetic this replaces: every
 * product is an integer, and `sourceFrameAtBoundary` degenerates to
 * `inPoint + (timelineFrame - startFrame)`.
 */
function sourceWindowForSlice(
  clip: Clip,
  start: Frame,
  end: Frame,
): { inPoint: Frame; outPoint: Frame } {
  const inPoint = sourceFrameAtBoundary(clip, start);
  return {
    inPoint,
    outPoint: inPoint + Math.round((end - start) * effectiveSpeed(clip.speed)),
  };
}

/**
 * The length of a ramp that spans `length` frames of `clip`'s OWN timeline,
 * expressed in the frames of the timeline nested inside it.
 *
 * A compound sped up 2x plays twice as many source frames per timeline frame,
 * so the same ramp covers twice as many frames in the nested timeline. A gate's
 * position and its length are the same timeline→source conversion applied to an
 * endpoint and to a span, so both go through the shared model; converting the
 * position alone would land the ramp in the right place at the wrong length.
 */
function nestedGateLength(clip: Clip, length: number): number {
  return Math.round(length * effectiveSpeed(clip.speed));
}

// ─── The same model, inverted: nested frames → render frames ─────────────────

/**
 * Render frame for a frame of the CURRENT timeline, through the nest so far.
 *
 * The inverse of `sourceFrameAtBoundary` and of the `childWindow` it feeds: a
 * nested frame is reached at timeline frame `startFrame + (n - inPoint) / speed`,
 * and that timeline frame still has to be carried to render space by whatever
 * ancestors are already open. So the composed nest map is affine and is stored
 * as one (`NestContext.frameScale`/`frameOffset`), never accumulated as a sum of
 * displacements — a running sum is that affine restricted to slope 1, which is
 * what a `speed: 1` nest gives and what made the sum look sufficient.
 */
function renderFrameOf(ctx: NestContext, frame: number): number {
  return Math.round(ctx.frameScale * frame + ctx.frameOffset);
}

/**
 * Expand one timeline into render clips/tracks. Cyclic, over-deep, dangling,
 * or window-invalid compounds expand to nothing — render never throws.
 */
function expandTimeline(
  project: Project,
  timeline: Timeline,
  tracksById: ReadonlyMap<string, Track>,
  ctx: NestContext,
  depth: number,
  seen: ReadonlySet<string>,
  outClips: Clip[],
  outTracks: Map<string, Track>,
): void {
  for (const clip of timeline.clips) {
    if (clip.type !== 'compound') {
      emitLeaf(clip, ctx, outClips, outTracks);
      continue;
    }
    const ref = sanitizeCompoundTimelineId(clip.compoundTimelineId);
    const nested = ref === undefined ? undefined : nestedTimelinesOf(project)[ref];
    if (
      !nested
      || depth >= MAX_COMPOUND_DEPTH
      || (ref !== undefined && seen.has(ref))
      || !Number.isFinite(clip.inPoint) || !Number.isFinite(clip.outPoint)
      || clip.inPoint < 0 || clip.outPoint <= clip.inPoint
      || clip.durationFrames !== clip.outPoint - clip.inPoint
    ) {
      continue;
    }
    const outerTrack = tracksById.get(clip.trackId);
    if (!outerTrack) continue;

    // Child window: the compound's own window intersected with the ancestor
    // window, mapped into nested-timeline frames through the shared source-time
    // model, so a sped-up compound maps the crop by the same `speed` term
    // preview and export use.
    const windowStart = Math.max(clip.startFrame, ctx.windowStart);
    const windowEnd = Math.min(clip.startFrame + clip.durationFrames, ctx.windowEnd);
    if (windowEnd <= windowStart) continue;
    const childWindow = sourceWindowForSlice(clip, windowStart, windowEnd);
    const childWindowStart = childWindow.inPoint;
    const childWindowEnd = childWindow.outPoint;

    const namespace = `${ctx.namespace}${clip.id}/`;
    // Composed nested → render map for this level, the exact inverse of the
    // timeline → nested map `sourceWindowForSlice` just applied. With the
    // parent's map `R(x) = A·x + B` and this clip's own `t = startFrame +
    // (n - inPoint) / speed`:
    //
    //   R(t) = (A / speed)·n + (A·(startFrame - inPoint / speed) + B)
    //
    // so entering a nest both MULTIPLIES the scale and re-anchors the offset —
    // which is why an additive `frameShift` was exact only while every compound
    // on the path ran at `speed: 1`, where A/speed = A = 1 and this collapses
    // to the old `B + startFrame - inPoint`.
    const speed = effectiveSpeed(clip.speed);
    const childFrameScale = ctx.frameScale / speed;
    const childFrameOffset = ctx.frameScale * (clip.startFrame - clip.inPoint / speed) + ctx.frameOffset;
    const innerTracksById = new Map(nested.tracks.map((track) => [track.id, track] as const));
    for (const inner of nested.tracks) {
      const synthId = `${namespace}#${inner.id}`;
      if (!outTracks.has(synthId)) {
        outTracks.set(synthId, {
          ...inner,
          id: synthId,
          visible: outerTrack.visible !== false && inner.visible !== false,
          // Solo is decided on main-timeline tracks; the nest follows its own.
          ...(outerTrack.soloed === undefined ? {} : { soloed: outerTrack.soloed }),
        });
      }
    }

    const child: NestContext = {
      namespace,
      windowStart: childWindowStart,
      windowEnd: childWindowEnd,
      frameScale: childFrameScale,
      frameOffset: childFrameOffset,
      x: ctx.x + clip.x,
      y: ctx.y + clip.y,
      scaleX: ctx.scaleX * clip.scaleX,
      scaleY: ctx.scaleY * clip.scaleY,
      rotation: ctx.rotation + clip.rotation,
      opacity: clamp01(ctx.opacity * clip.opacity),
      volume: clamp01(ctx.volume * clip.volume),
      pan: clampPan(ctx.pan + (clip.pan ?? 0)),
      muted: ctx.muted || clip.muted,
      fadeIns: [
        ...ctx.fadeIns.map((gate) => ({
          start: sourceFrameAtBoundary(clip, gate.start),
          length: nestedGateLength(clip, gate.length),
        })),
        // The compound's own ramp starts at its window start, which is already
        // `inPoint` because that boundary is the clip's own start frame.
        ...((clip.fadeInFrames ?? 0) > 0
          ? [{ start: clip.inPoint, length: nestedGateLength(clip, clip.fadeInFrames as number) }]
          : []),
      ],
      fadeOuts: [
        ...ctx.fadeOuts.map((gate) => ({
          start: sourceFrameAtBoundary(clip, gate.start),
          length: nestedGateLength(clip, gate.length),
        })),
        ...((clip.fadeOutFrames ?? 0) > 0
          ? [{
            start: sourceFrameAtBoundary(
              clip,
              clip.startFrame + clip.durationFrames - (clip.fadeOutFrames as number),
            ),
            length: nestedGateLength(clip, clip.fadeOutFrames as number),
          }]
          : []),
      ],
      track: outerTrack,
    };
    const childSeen = new Set(seen);
    childSeen.add(ref as string);
    expandTimeline(project, nested, innerTracksById, child, depth + 1, childSeen, outClips, outTracks);
  }
}

/**
 * Emit one non-compound clip into render space: intersect the ancestor
 * window, rebase to render frames, compose the outer transform.
 */
function emitLeaf(
  clip: Clip,
  ctx: NestContext,
  outClips: Clip[],
  outTracks: Map<string, Track>,
): void {
  const atRoot = ctx.namespace === '';
  const overlapStart = Math.max(clip.startFrame, ctx.windowStart);
  const overlapEnd = Math.min(clip.startFrame + clip.durationFrames, ctx.windowEnd);
  if (overlapEnd <= overlapStart) return;

  // Inner tracks are namespaced (`<compound-id>/…#<track-id>`) so nested
  // layer order survives the flatten; a clip whose inner track is missing is
  // dropped (its timeline is corrupt — diagnostics flags the structure).
  const trackId = atRoot ? clip.trackId : `${ctx.namespace}#${clip.trackId}`;
  if (!atRoot && !outTracks.has(trackId)) return;

  // Placement is in RENDER frames, so a nest whose compound carries a
  // non-unit speed lands the leaf where it actually renders instead of one
  // level's worth of displacement away. The source window is then read off the
  // RENDER-space head cut and span — the same `speed` term, applied to the
  // frames the emitted clip actually occupies — which keeps the main-timeline
  // invariant `outPoint - inPoint === round(durationFrames * speed)` at any
  // nesting scale, and keeps a sped-up clip from claiming the wrong amount of
  // source: rebuilt without the `speed` term, a 2x clip claims half the source
  // material and mis-trims on preview and export.
  //
  // `speed: 1` is frame-for-frame the nested-frame arithmetic this replaces:
  // every scale is 1 and every offset an integer, so the mapped boundaries are
  // the nested ones, the head cut is the nested one, and the window is
  // `sourceWindowForSlice(clip, overlapStart, overlapEnd)`.
  const speed = effectiveSpeed(clip.speed);
  const renderStart = atRoot ? overlapStart : renderFrameOf(ctx, overlapStart);
  const renderEnd = atRoot ? overlapEnd : renderFrameOf(ctx, overlapEnd);
  const renderClipStart = atRoot ? clip.startFrame : renderFrameOf(ctx, clip.startFrame);
  const headCut = renderStart - renderClipStart;
  const emittedDuration = renderEnd - renderStart;
  // A nested slice shorter than one render frame (only reachable when an
  // ancestor's speed makes the scale < 1) occupies no render time at all.
  if (emittedDuration <= 0) return;
  const emittedInPoint = clip.inPoint + Math.round(headCut * speed);
  const emitted: Clip = {
    ...rebaseKeyframeTracks(clip, atRoot ? 0 : ctx.frameOffset, atRoot ? 1 : ctx.frameScale),
    startFrame: renderStart,
    durationFrames: emittedDuration,
    inPoint: emittedInPoint,
    outPoint: emittedInPoint + Math.round(emittedDuration * speed),
    trackId,
  };

  if (!atRoot) {
    const keyframed = emitted as KeyframedClip;
    // Motion VALUES compose with the outer geometry (frames were shifted by
    // rebaseKeyframeTracks above); statics compose directly.
    if (keyframed.motionX) {
      emitted.motionX = keyframed.motionX.map((p: KeyframePoint) => ({ ...p, value: p.value + ctx.x }));
    }
    if (keyframed.motionY) {
      emitted.motionY = keyframed.motionY.map((p: KeyframePoint) => ({ ...p, value: p.value + ctx.y }));
    }
    if (keyframed.motionRot) {
      emitted.motionRot = keyframed.motionRot.map((p: KeyframePoint) => ({ ...p, value: p.value + ctx.rotation }));
    }
    if (keyframed.motionScaleX) {
      emitted.motionScaleX = keyframed.motionScaleX.map((p: KeyframePoint) => ({ ...p, value: p.value * ctx.scaleX }));
    }
    if (keyframed.motionScaleY) {
      emitted.motionScaleY = keyframed.motionScaleY.map((p: KeyframePoint) => ({ ...p, value: p.value * ctx.scaleY }));
    }
    emitted.x = clip.x + ctx.x;
    emitted.y = clip.y + ctx.y;
    emitted.scaleX = clip.scaleX * ctx.scaleX;
    emitted.scaleY = clip.scaleY * ctx.scaleY;
    emitted.rotation = clip.rotation + ctx.rotation;
    emitted.opacity = clamp01(clip.opacity * ctx.opacity);
    emitted.volume = clamp01(clip.volume * ctx.volume);
    // Preserve an absent center pan: preview and export both read `?? 0`,
    // so stamping `pan: 0` would only noise up resolved clips and break
    // nested-vs-flattened equality.
    const composedPan = clampPan((clip.pan ?? 0) + ctx.pan);
    if (clip.pan !== undefined || composedPan !== 0) emitted.pan = composedPan;
    emitted.muted = ctx.muted || clip.muted;

    // Outer fades ride the whole nest: the longest applicable ramp wins at
    // each edge (an approximation — two multiplied ramps are not exactly one
    // ramp — documented in the module header as out of slice scope to model
    // exactly). Gates arrive in nested-timeline frames here while the emitted
    // ramp is a render-frame length, so a surviving remainder crosses the same
    // map as the placement above (`* frameScale`, exact at 1). Without it a
    // compound's own ramp changes length as soon as the nest runs at a
    // non-unit speed, and reads as nested frames against a render-frame cap.
    const nestedStart = overlapStart;
    const nestedEnd = overlapEnd;
    let fadeIn = emitted.fadeInFrames ?? 0;
    for (const gate of ctx.fadeIns) {
      const remaining = (gate.length - (nestedStart - gate.start)) * ctx.frameScale;
      if (remaining > 0) fadeIn = Math.max(fadeIn, remaining);
    }
    let fadeOut = emitted.fadeOutFrames ?? 0;
    for (const gate of ctx.fadeOuts) {
      const remaining = (gate.length - (gate.start + gate.length - nestedEnd)) * ctx.frameScale;
      if (remaining > 0) fadeOut = Math.max(fadeOut, remaining);
    }
    fadeIn = clampFrame(Math.min(fadeIn, emittedDuration), 0);
    fadeOut = clampFrame(Math.min(fadeOut, emittedDuration), 0);
    if (fadeIn > 0) emitted.fadeInFrames = fadeIn;
    else delete emitted.fadeInFrames;
    if (fadeOut > 0) emitted.fadeOutFrames = fadeOut;
    else delete emitted.fadeOutFrames;
    // The compound's own grade/effects/transition do not compose onto nested
    // content in this slice (documented above); inner clips keep their own.
  }
  outClips.push(emitted);
}

/**
 * Find a clip stored inside any nested timeline (deepest match wins when an
 * id repeats across levels, mirroring how resolution emits the innermost
 * content). Main-timeline clips are NOT matched — those need no lookup.
 * The preview compositor uses this to reconcile renderer-computed rasters
 * (box content from stored fields) with resolved placement.
 */
export function findNestedClip(project: Project, clipId: string): Clip | undefined {
  const nested = nestedTimelinesOf(project);
  const ids = Object.keys(nested);
  for (let level = ids.length - 1; level >= 0; level -= 1) {
    const found = nested[ids[level]!]!.clips.find((clip) => clip.id === clipId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Flatten a project for rendering: every valid compound expands to ordinary
 * clips (composed transforms, rebased keyframes, namespaced tracks) spliced
 * in place. Preview (`visibleClipsAtFrame`), export eligibility, and the
 * FFmpeg graph builder all consume this one shape, so they cannot disagree.
 * Fast path: projects without compounds return the timeline untouched.
 */
export function resolveRenderTimeline(project: Project): Timeline {
  const nested = nestedTimelinesOf(project);
  const hasCompound = project.timeline.clips.some((clip) => clip.type === 'compound');
  if (!hasCompound && Object.keys(nested).length === 0) return project.timeline;

  const outClips: Clip[] = [];
  const outTracks = new Map<string, Track>();
  for (const track of project.timeline.tracks) outTracks.set(track.id, track);
  expandTimeline(
    project,
    project.timeline,
    new Map(project.timeline.tracks.map((track) => [track.id, track] as const)),
    rootContext(),
    0,
    new Set(),
    outClips,
    outTracks,
  );
  return { ...project.timeline, tracks: [...outTracks.values()], clips: outClips };
}
