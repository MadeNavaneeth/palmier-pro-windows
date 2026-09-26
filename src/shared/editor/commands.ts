/**
 * EditorController command system.
 *
 * Every edit operation is a Command — named, undoable, serializable.
 * The UI, the in-app AI agent, and the MCP server all call the same commands.
 * This is the core design inherited from Palmier Pro.
 */

import type { Project, Clip, Track, Frame, MediaAsset } from '../types/project';
import type { TimelineMarker } from './markers';
import type { Timeline } from '../types/project';
import { effectiveSpeed } from '../media/source-time';

// ─── Timeline scope lens ─────────────────────────────────────────────────────

/**
 * Editing scope for timeline-mutating commands (upstream issue #155 slice 2):
 * `null` addresses the main timeline, otherwise a `Project.timelines` id.
 *
 * Commands that replace clips/tracks/markers carry the scope they ran in, so
 * undo restores the edit exactly where it happened even if the user navigated
 * elsewhere since. The controller coerces its ambient scope after every
 * commit, so a stored scope almost always resolves; when the scope's timeline
 * is gone anyway (flattened away between execute and undo), the command is a
 * no-op rather than resurrecting deleted state.
 */
export type TimelineScopeId = string | null;

/** Read one timeline by scope, assuming the id resolves (controller coerces). */
export function scopeTimeline(project: Project, scope: TimelineScopeId): Timeline {
  if (scope === null) return project.timeline;
  return project.timelines?.[scope] ?? project.timeline;
}

/** True when a scoped write has a live target (main always does). */
export function scopeTimelineExists(project: Project, scope: TimelineScopeId): boolean {
  return scope === null || project.timelines?.[scope] !== undefined;
}

/** Replant one timeline into its scope slot. */
export function replaceScopeTimeline(project: Project, scope: TimelineScopeId, next: Timeline): Project {
  if (scope === null) return { ...project, timeline: next };
  return {
    ...project,
    timelines: { ...(project.timelines ?? {}), [scope]: next },
  };
}

// ─── Command interface ───────────────────────────────────────────────────────

export interface Command {
  readonly name: string;
  execute(project: Project): Project;
  undo(project: Project): Project;
  /** Human-readable description for undo/redo UI */
  describe(): string;
}

// ─── Command History (undo/redo stack) ───────────────────────────────────────

/** One open transaction scope and the commands it has collected so far. */
interface TransactionScope {
  label: string;
  commands: Command[];
}

export class CommandHistory {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private maxSize: number;
  /** Open transaction scopes, outermost first. */
  private scopes: TransactionScope[] = [];

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  /**
   * Execute one command. Outside a transaction it becomes one history entry;
   * inside the innermost open scope it is collected for that scope to publish.
   */
  execute(command: Command, project: Project): Project {
    const result = command.execute(project);
    const scope = this.scopes[this.scopes.length - 1];
    if (scope) scope.commands.push(command);
    else this.publish(command);
    return result;
  }

  /**
   * Open a scope that collects every command executed until it commits and
   * publishes them as ONE history entry named `label`. A transaction groups by
   * construction, so nothing that happens between the grouped commands can
   * change which commands belong to it.
   *
   * Opening a scope while one is already open nests: the inner scope joins the
   * outer one and publishes no entry of its own (see commitTransaction).
   */
  beginTransaction(label: string): void {
    this.scopes.push({ label, commands: [] });
  }

  /**
   * Close the innermost scope.
   *
   * - Outermost scope: its commands become one entry. A scope that collected
   *   NOTHING adds no entry, so a no-op, a refusal, or a fully-clamped action
   *   leaves history untouched. A scope that collected exactly ONE command
   *   publishes that command as-is, because a transaction labels a grouped
   *   action and must not relabel a single domain operation.
   * - Nested scope: joins the outer one. Its commands fold into the parent's
   *   collection, so the user still gets a single undo step, and its own label
   *   is dropped — the outer action names the step.
   */
  commitTransaction(): void {
    const scope = this.scopes.pop();
    if (!scope) return;
    const outer = this.scopes[this.scopes.length - 1];
    if (outer) {
      outer.commands.push(...scope.commands);
      return;
    }
    if (scope.commands.length === 0) return;
    this.publish(
      scope.commands.length === 1
        ? scope.commands[0]
        : new CompositeCommand(scope.commands, scope.label),
    );
  }

  /**
   * Close the innermost scope and publish nothing. Returns the discarded
   * commands in execution order so the caller can restore the project it had
   * before the scope by undoing them in reverse. History is left exactly as it
   * was — no entry, no redo truncation — because nothing was committed.
   *
   * Aborting a nested scope discards only that scope's commands; the outer
   * scope keeps whatever it collected before and after.
   */
  abortTransaction(): Command[] {
    const scope = this.scopes.pop();
    if (!scope) return [];
    const outer = this.scopes[this.scopes.length - 1];
    if (outer) outer.commands.push(...scope.commands);
    return scope.commands;
  }

  /** Publish one committed history entry, clearing redo and trimming the cap. */
  private publish(entry: Command): void {
    this.undoStack.push(entry);
    this.redoStack = []; // clear redo on new action

    // Trim if over max size
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
  }

  undo(project: Project): Project | null {
    const command = this.undoStack.pop();
    if (!command) return null;
    this.redoStack.push(command);
    return command.undo(project);
  }

  redo(project: Project): Project | null {
    const command = this.redoStack.pop();
    if (!command) return null;
    this.undoStack.push(command);
    return command.execute(project);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  lastCommandName(): string | null {
    const last = this.undoStack[this.undoStack.length - 1];
    return last ? last.name : null;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

// ─── Concrete Commands ───────────────────────────────────────────────────────

export class AddClipCommand implements Command {
  readonly name = 'addClip';
  constructor(private clip: Clip, private scopeId: TimelineScopeId = null) {}

  execute(project: Project): Project {
    if (!scopeTimelineExists(project, this.scopeId)) return project;
    const timeline = scopeTimeline(project, this.scopeId);
    return {
      ...replaceScopeTimeline(project, this.scopeId, {
        ...timeline,
        clips: [...timeline.clips, this.clip],
      }),
      updatedAt: new Date().toISOString(),
    };
  }

  undo(project: Project): Project {
    if (!scopeTimelineExists(project, this.scopeId)) return project;
    const timeline = scopeTimeline(project, this.scopeId);
    return {
      ...replaceScopeTimeline(project, this.scopeId, {
        ...timeline,
        clips: timeline.clips.filter((c) => c.id !== this.clip.id),
      }),
      updatedAt: new Date().toISOString(),
    };
  }

  describe(): string {
    return `Add clip "${this.clip.label || this.clip.id}"`;
  }
}

export class AddMediaAndClipsCommand implements Command {
  readonly name = 'addMediaAndClips';
  private readonly mediaIds: Set<string>;
  private readonly clipIds: Set<string>;
  private readonly trackIds: Set<string>;

  constructor(
    private media: MediaAsset[],
    private clips: Clip[],
    private label: string,
    private tracks: Track[] = [],
    private scopeId: TimelineScopeId = null,
  ) {
    this.mediaIds = new Set(media.map((asset) => asset.id));
    this.clipIds = new Set(clips.map((clip) => clip.id));
    this.trackIds = new Set(tracks.map((track) => track.id));
  }

  execute(project: Project): Project {
    if (!scopeTimelineExists(project, this.scopeId)) return project;
    const timeline = scopeTimeline(project, this.scopeId);
    const scoped = replaceScopeTimeline(project, this.scopeId, {
      ...timeline,
      tracks: [
        ...timeline.tracks.filter((track) => !this.trackIds.has(track.id)),
        ...this.tracks,
      ],
      clips: [
        ...timeline.clips.filter((clip) => !this.clipIds.has(clip.id)),
        ...this.clips,
      ],
    });
    return {
      ...scoped,
      media: [
        ...project.media.filter((asset) => !this.mediaIds.has(asset.id)),
        ...this.media,
      ],
      updatedAt: new Date().toISOString(),
    };
  }

  undo(project: Project): Project {
    if (!scopeTimelineExists(project, this.scopeId)) return project;
    const timeline = scopeTimeline(project, this.scopeId);
    const scoped = replaceScopeTimeline(project, this.scopeId, {
      ...timeline,
      tracks: timeline.tracks.filter((track) => !this.trackIds.has(track.id)),
      clips: timeline.clips.filter((clip) => !this.clipIds.has(clip.id)),
    });
    return {
      ...scoped,
      media: project.media.filter((asset) => !this.mediaIds.has(asset.id)),
      updatedAt: new Date().toISOString(),
    };
  }

  describe(): string {
    return this.label;
  }
}

export class RemoveClipCommand implements Command {
  readonly name = 'removeClip';
  private removedClip: Clip | null = null;

  constructor(private clipId: string) {}

  execute(project: Project): Project {
    this.removedClip = project.timeline.clips.find((c) => c.id === this.clipId) || null;
    return {
      ...project,
      timeline: {
        ...project.timeline,
        clips: project.timeline.clips.filter((c) => c.id !== this.clipId),
      },
      updatedAt: new Date().toISOString(),
    };
  }

  undo(project: Project): Project {
    if (!this.removedClip) return project;
    return {
      ...project,
      timeline: {
        ...project.timeline,
        clips: [...project.timeline.clips, this.removedClip],
      },
      updatedAt: new Date().toISOString(),
    };
  }

  describe(): string {
    return `Remove clip "${this.clipId}"`;
  }
}

export class MoveClipCommand implements Command {
  readonly name = 'moveClip';
  private previousStartFrame: Frame = 0;
  private previousTrackId: string = '';

  constructor(
    private clipId: string,
    private newStartFrame: Frame,
    private newTrackId?: string,
  ) {}

  execute(project: Project): Project {
    const clips = project.timeline.clips.map((c) => {
      if (c.id !== this.clipId) return c;
      this.previousStartFrame = c.startFrame;
      this.previousTrackId = c.trackId;
      return {
        ...c,
        startFrame: this.newStartFrame,
        trackId: this.newTrackId || c.trackId,
      };
    });
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  undo(project: Project): Project {
    const clips = project.timeline.clips.map((c) => {
      if (c.id !== this.clipId) return c;
      return { ...c, startFrame: this.previousStartFrame, trackId: this.previousTrackId };
    });
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  describe(): string {
    return `Move clip to frame ${this.newStartFrame}`;
  }
}

/**
 * Timeline length, in frames, of a trim window `[inPoint, outPoint)`.
 *
 * `inPoint`/`outPoint` are SOURCE frames while `durationFrames` is a TIMELINE
 * length, and the shared source-time model relates them by the clip's speed:
 * source time advances `speed` frames per timeline frame
 * (`sourceOffset = inPoint + (timelineFrame - startFrame) * speed`), which is
 * why `setClipSpeed` writes the window as
 * `outPoint = inPoint + round(durationFrames * speed)`. Reading the span
 * straight off the window is that relation inverted with the `speed` term
 * missing, so a 2x clip trimmed to a 60-frame source window came out 60
 * timeline frames long -- twice the material the window names, and twice the
 * length preview, ripple and export were told to reserve for it. Dividing by
 * the clip's own speed is the inverse of the write, so a trimmed clip still
 * satisfies `outPoint - inPoint === round(durationFrames * speed)` whatever
 * the speed, and at speed 1 it is the span unchanged.
 *
 * The window is the input and the length is derived from it: the caller asked
 * for a source range, so the timeline length is a consequence of that range
 * and of the clip's speed, never a value read back off the old length or
 * carried in from outside.
 *
 * A COMPOUND is the one exemption, and it is a type contract rather than an
 * exception: its window is a range of NESTED-timeline frames that maps 1:1
 * onto its own duration (compound validation requires
 * `durationFrames === outPoint - inPoint`, and `setClipSpeed` refuses the type
 * outright), so its window length already is a timeline length.
 *
 * The floor of 1 frame is the speed-aware form of the "out point is at least
 * one frame past the in point" rule callers establish when they clamp
 * `outPoint`: a span of one source frame on a 4x clip is still one timeline
 * frame, and a clip may not be trimmed out of existence.
 */
export function trimWindowDurationFrames(clip: Clip, inPoint: Frame, outPoint: Frame): Frame {
  const speed = clip.type === 'compound' ? 1 : effectiveSpeed(clip.speed);
  return Math.max(1, Math.round((outPoint - inPoint) / speed));
}

export class TrimClipCommand implements Command {
  readonly name = 'trimClip';
  private prevIn: Frame = 0;
  private prevOut: Frame = 0;
  private prevDuration: Frame = 0;

  constructor(
    private clipId: string,
    private newInPoint: Frame,
    private newOutPoint: Frame,
  ) {}

  execute(project: Project): Project {
    const clips = project.timeline.clips.map((c) => {
      if (c.id !== this.clipId) return c;
      this.prevIn = c.inPoint;
      this.prevOut = c.outPoint;
      this.prevDuration = c.durationFrames;
      return {
        ...c,
        inPoint: this.newInPoint,
        outPoint: this.newOutPoint,
        // Recomputed here, from the live clip's speed, rather than stored in
        // the constructor: the constructor is handed the window before it has
        // seen the project, so any length it carried would be a guess at the
        // speed the clip is edited at. See `trimWindowDurationFrames`.
        durationFrames: trimWindowDurationFrames(c, this.newInPoint, this.newOutPoint),
      };
    });
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  undo(project: Project): Project {
    const clips = project.timeline.clips.map((c) => {
      if (c.id !== this.clipId) return c;
      return { ...c, inPoint: this.prevIn, outPoint: this.prevOut, durationFrames: this.prevDuration };
    });
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  describe(): string {
    return `Trim clip [${this.newInPoint}–${this.newOutPoint}]`;
  }
}

export class AddTrackCommand implements Command {
  readonly name = 'addTrack';
  constructor(private track: Track, private scopeId: TimelineScopeId = null) {}

  execute(project: Project): Project {
    if (!scopeTimelineExists(project, this.scopeId)) return project;
    const timeline = scopeTimeline(project, this.scopeId);
    return {
      ...replaceScopeTimeline(project, this.scopeId, {
        ...timeline,
        tracks: [...timeline.tracks, this.track],
      }),
      updatedAt: new Date().toISOString(),
    };
  }

  undo(project: Project): Project {
    if (!scopeTimelineExists(project, this.scopeId)) return project;
    const timeline = scopeTimeline(project, this.scopeId);
    return {
      ...replaceScopeTimeline(project, this.scopeId, {
        ...timeline,
        tracks: timeline.tracks.filter((t) => t.id !== this.track.id),
      }),
      updatedAt: new Date().toISOString(),
    };
  }

  describe(): string {
    return `Add track "${this.track.name}"`;
  }
}

/**
 * Apply a pre-resolved set of clip replacements in one undoable step.
 *
 * This is the single command behind every clip-property edit — blend mode,
 * opacity, fades — whether the edit targets one clip or a whole selection.
 * Windows translation of upstream PR #419 ("batch bulk clip property
 * mutations"): the caller resolves each target clip once, then execute/undo
 * touch the clip array in a single pass instead of running one linear search
 * per clip per property.
 *
 * Clips outside the edit are passed through by reference, so restyling three
 * clips does not invalidate every other clip for React consumers.
 */
export class SetClipPropertiesCommand implements Command {
  readonly name = 'setClipProperties';
  private previousClips = new Map<string, Clip>();
  private captured = false;

  constructor(
    private nextClips: Map<string, Clip>,
    private label: string,
    private scopeId: TimelineScopeId = null,
  ) {}

  execute(project: Project): Project {
    if (!scopeTimelineExists(project, this.scopeId)) return project;
    const timeline = scopeTimeline(project, this.scopeId);
    if (!this.captured) {
      for (const clip of timeline.clips) {
        if (this.nextClips.has(clip.id)) this.previousClips.set(clip.id, clip);
      }
      this.captured = true;
    }
    return this.replace(project, this.nextClips);
  }

  undo(project: Project): Project {
    if (!scopeTimelineExists(project, this.scopeId)) return project;
    return this.replace(project, this.previousClips);
  }

  private replace(project: Project, source: Map<string, Clip>): Project {
    const timeline = scopeTimeline(project, this.scopeId);
    const clips = timeline.clips.map((clip) => source.get(clip.id) ?? clip);
    return {
      ...replaceScopeTimeline(project, this.scopeId, { ...timeline, clips }),
      updatedAt: new Date().toISOString(),
    };
  }

  describe(): string {
    return this.label;
  }
}





/**
 * Replace the entire timeline clip array in one undoable step.
 * Used for complex multi-clip transforms (ripple, silence removal) where
 * tracking individual deltas is error-prone; snapshotting the clips array is
 * simple and correct, and the arrays are small.
 */
/**
 * Several commands presented as one history entry, so a batch tool call is
 * one undo step. Sub-commands keep their captured state from the live run;
 * undo replays them in reverse, redo re-executes them in order.
 */
export class CompositeCommand implements Command {
  readonly name = 'composite';

  constructor(
    private readonly commands: Command[],
    private readonly label: string,
  ) {}

  execute(project: Project): Project {
    return this.commands.reduce((state, command) => command.execute(state), project);
  }

  undo(project: Project): Project {
    return [...this.commands].reverse().reduce((state, command) => command.undo(state), project);
  }

  describe(): string {
    return this.label;
  }
}

export class ReplaceClipsCommand implements Command {
  readonly name = 'replaceClips';
  private previousClips: Clip[] = [];
  private captured = false;

  constructor(
    private nextClips: Clip[],
    private label: string,
    private scopeId: TimelineScopeId = null,
  ) {}

  execute(project: Project): Project {
    if (!scopeTimelineExists(project, this.scopeId)) return project;
    if (!this.captured) {
      this.previousClips = scopeTimeline(project, this.scopeId).clips;
      this.captured = true;
    }
    const timeline = scopeTimeline(project, this.scopeId);
    return {
      ...replaceScopeTimeline(project, this.scopeId, { ...timeline, clips: this.nextClips }),
      updatedAt: new Date().toISOString(),
    };
  }

  undo(project: Project): Project {
    if (!scopeTimelineExists(project, this.scopeId)) return project;
    const timeline = scopeTimeline(project, this.scopeId);
    return {
      ...replaceScopeTimeline(project, this.scopeId, { ...timeline, clips: this.previousClips }),
      updatedAt: new Date().toISOString(),
    };
  }

  describe(): string {
    return this.label;
  }
}

/**
 * Replace the track array in one undoable step. Track header toggles use the
 * same command history as timeline edits, so UI, Agent, and MCP state cannot
 * diverge.
 */
export class ReplaceTracksCommand implements Command {  readonly name = 'replaceTracks';
  private previousTracks: Track[] = [];
  private captured = false;

  constructor(
    private nextTracks: Track[],
    private label: string,
    private scopeId: TimelineScopeId = null,
  ) {}

  execute(project: Project): Project {
    if (!scopeTimelineExists(project, this.scopeId)) return project;
    if (!this.captured) {
      this.previousTracks = scopeTimeline(project, this.scopeId).tracks;
      this.captured = true;
    }
    const timeline = scopeTimeline(project, this.scopeId);
    return {
      ...replaceScopeTimeline(project, this.scopeId, { ...timeline, tracks: this.nextTracks }),
      updatedAt: new Date().toISOString(),
    };
  }

  undo(project: Project): Project {
    if (!scopeTimelineExists(project, this.scopeId)) return project;
    const timeline = scopeTimeline(project, this.scopeId);
    return {
      ...replaceScopeTimeline(project, this.scopeId, { ...timeline, tracks: this.previousTracks }),
      updatedAt: new Date().toISOString(),
    };
  }

  describe(): string {
    return this.label;
  }
}


/**
 * Replace the entire project in one undoable step. Used when the renderer
 * adopts an edit produced by the AI agent / MCP server (which runs against
 * the main-process controller), so agent edits appear as a single reversible
 * action in the UI's undo history.
 */
export class ReplaceProjectCommand implements Command {
  readonly name = 'replaceProject';
  private previousProject: Project | null = null;

  constructor(
    private nextProject: Project,
    private label: string,
  ) {}

  execute(project: Project): Project {
    if (this.previousProject === null) {
      this.previousProject = project;
    }
    return this.nextProject;
  }

  undo(_project: Project): Project {
    return this.previousProject!;
  }

  describe(): string {
    return this.label;
  }
}

/**
 * Replace one media asset entry in one undoable step — the offline-relink
 * primitive (upstream EditorViewModel+Relink): only the repointed asset's
 * path-bearing entry changes; every other asset passes through by reference.
 */
export class ReplaceMediaCommand implements Command {
  readonly name = 'replaceMedia';
  private previousAsset: MediaAsset | null = null;
  private captured = false;

  constructor(
    private nextAsset: MediaAsset,
    private label: string,
  ) {}

  execute(project: Project): Project {
    if (!this.captured) {
      this.previousAsset =
        project.media.find((asset) => asset.id === this.nextAsset.id) ?? null;
      this.captured = true;
    }
    return {
      ...project,
      media: project.media.map((asset) =>
        asset.id === this.nextAsset.id ? this.nextAsset : asset,
      ),
      updatedAt: new Date().toISOString(),
    };
  }

  undo(project: Project): Project {
    if (!this.previousAsset) return project;
    return {
      ...project,
      media: project.media.map((asset) =>
        asset.id === this.previousAsset!.id ? this.previousAsset! : asset,
      ),
      updatedAt: new Date().toISOString(),
    };
  }

  describe(): string {
    return this.label;
  }
}

/**
 * Replace the timeline marker array in one undoable step
 * (upstream PR #542). Snapshotting the whole array mirrors upstream's
 * `registerTimelineMarkerSwap`: markers are few, and whole-array swap makes
 * create/update/delete mixes trivially reversible.
 */
export class ReplaceMarkersCommand implements Command {
  readonly name = 'replaceMarkers';
  private previousMarkers: TimelineMarker[] | undefined;
  private captured = false;

  constructor(
    private nextMarkers: TimelineMarker[],
    private label: string,
    private scopeId: TimelineScopeId = null,
  ) {}

  execute(project: Project): Project {
    if (!scopeTimelineExists(project, this.scopeId)) return project;
    const timeline = scopeTimeline(project, this.scopeId);
    if (!this.captured) {
      this.previousMarkers = timeline.markers;
      this.captured = true;
    }
    return {
      ...replaceScopeTimeline(project, this.scopeId, { ...timeline, markers: this.nextMarkers }),
      updatedAt: new Date().toISOString(),
    };
  }

  undo(project: Project): Project {
    if (!scopeTimelineExists(project, this.scopeId)) return project;
    const timeline: Timeline = { ...scopeTimeline(project, this.scopeId), markers: this.previousMarkers };
    if (this.previousMarkers === undefined) delete timeline.markers;
    return {
      ...replaceScopeTimeline(project, this.scopeId, timeline),
      updatedAt: new Date().toISOString(),
    };
  }

  describe(): string {
    return this.label;
  }
}


