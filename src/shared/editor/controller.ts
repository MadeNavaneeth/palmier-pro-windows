/**
 * EditorController — the single command surface for all editing operations.
 *
 * The UI, the AI agent, and the MCP server all call these methods.
 * Every mutation goes through execute(), making it undoable and auditable.
 */

import { nanoid } from 'nanoid';
import type { Project, Clip, Track, Frame, MediaAsset, ClipType } from '../types/project';
import { createEmptyProject } from '../types/project';
import { clampFrame, asValidFrame } from '../utils/safe-number';
import {
  CommandHistory,
  AddClipCommand,
  RemoveClipCommand,
  MoveClipCommand,
  TrimClipCommand,
  SplitClipCommand,
  AddTrackCommand,
  SetPlayheadCommand,
  SetBlendModeCommand,
  SetOpacityCommand,
  SetFadeCommand,
  ReplaceClipsCommand,
  ReplaceProjectCommand,
} from './commands';
import type { Command } from './commands';
import type { BlendMode } from '../types/blend-mode';
import type { ClipTransition } from './transition';
import { planSilenceRemoval, type FrameRange, type SilentRange } from '../audio/silence-detector';

export type StateChangeListener = (project: Project) => void;

export class EditorController {
  private project: Project;
  private history: CommandHistory;
  private listeners: Set<StateChangeListener> = new Set();

  constructor(project?: Project) {
    this.project = project || createEmptyProject();
    this.history = new CommandHistory();
  }

  // ─── State access ──────────────────────────────────────────────────────────

  getProject(): Project {
    return this.project;
  }

  getTimeline() {
    return this.project.timeline;
  }

  getClips(): Clip[] {
    return this.project.timeline.clips;
  }

  getTracks(): Track[] {
    return this.project.timeline.tracks;
  }

  getMedia(): MediaAsset[] {
    return this.project.media;
  }

  getPlayhead(): Frame {
    return this.project.timeline.playheadFrame;
  }

  // ─── Command execution ─────────────────────────────────────────────────────

  execute(command: Command): void {
    this.project = this.history.execute(command, this.project);
    this.notify();
  }

  undo(): boolean {
    const result = this.history.undo(this.project);
    if (result) {
      this.project = result;
      this.notify();
      return true;
    }
    return false;
  }

  redo(): boolean {
    const result = this.history.redo(this.project);
    if (result) {
      this.project = result;
      this.notify();
      return true;
    }
    return false;
  }

  canUndo(): boolean {
    return this.history.canUndo();
  }

  canRedo(): boolean {
    return this.history.canRedo();
  }

  // ─── High-level editing API (used by UI, agent, MCP) ──────────────────────

  addClip(params: {
    assetId: string;
    trackId: string;
    startFrame: Frame;
    type?: ClipType;
    durationFrames?: Frame;
  }): string {
    const asset = this.project.media.find((m) => m.id === params.assetId);
    // Guard every numeric input: a non-finite or out-of-range frame/duration
    // would otherwise corrupt timeline math or downstream loop bounds (#200).
    const startFrame = clampFrame(params.startFrame);
    const duration = clampFrame(params.durationFrames || asset?.duration || 150, 1); // default 5s at 30fps

    const clip: Clip = {
      id: nanoid(),
      assetId: params.assetId,
      type: params.type || asset?.type || 'video',
      trackId: params.trackId,
      startFrame,
      durationFrames: duration,
      inPoint: 0,
      outPoint: duration,
      x: 0,
      y: 0,
      width: this.project.settings.width,
      height: this.project.settings.height,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      anchorX: 0,
      anchorY: 0,
      volume: 1,
      muted: false,
    };

    this.execute(new AddClipCommand(clip));
    return clip.id;
  }

  removeClip(clipId: string): void {
    this.execute(new RemoveClipCommand(clipId));
  }

  moveClip(clipId: string, newStartFrame: Frame, newTrackId?: string): void {
    this.execute(new MoveClipCommand(clipId, clampFrame(newStartFrame), newTrackId));
  }

  trimClip(clipId: string, newInPoint: Frame, newOutPoint: Frame): void {
    // Reject non-finite/out-of-range points outright; clamp ordering so
    // outPoint is always strictly greater than inPoint.
    const inPoint = clampFrame(newInPoint);
    const outPoint = clampFrame(newOutPoint, inPoint + 1);
    this.execute(new TrimClipCommand(clipId, inPoint, outPoint));
  }

  splitClip(clipId: string, atFrame: Frame): string | null {
    const clip = this.project.timeline.clips.find((c) => c.id === clipId);
    if (!clip) return null;

    // Validate the split frame before any arithmetic; null = reject.
    const frame = asValidFrame(atFrame);
    if (frame === null) return null;

    const relativeFrame = frame - clip.startFrame;
    if (relativeFrame <= 0 || relativeFrame >= clip.durationFrames) return null;

    let newId = '';
    const cmd = new SplitClipCommand(clipId, frame, () => {
      newId = nanoid();
      return newId;
    });
    this.execute(cmd);
    return newId;
  }

  addTrack(type: 'video' | 'audio', name?: string): string {
    const existing = this.project.timeline.tracks.filter((t) => t.type === type);
    const trackName = name || `${type === 'video' ? 'Video' : 'Audio'} ${existing.length + 1}`;
    const track: Track = {
      id: nanoid(),
      name: trackName,
      type,
      locked: false,
      visible: true,
      order: this.project.timeline.tracks.length,
    };
    this.execute(new AddTrackCommand(track));
    return track.id;
  }

  setPlayhead(frame: Frame): void {
    this.execute(new SetPlayheadCommand(clampFrame(frame)));
  }

  /**
   * Set a clip's layer blend mode. Only valid for visual clips —
   * audio clips have no compositing stage, so this is a no-op for them
   * (returns false), matching upstream behaviour (#203).
   */
  setClipBlendMode(clipId: string, blendMode: BlendMode): boolean {
    const clip = this.project.timeline.clips.find((c) => c.id === clipId);
    if (!clip) return false;
    if (clip.type === 'audio') return false;
    this.execute(new SetBlendModeCommand(clipId, blendMode));
    return true;
  }

  /** Set a clip's opacity (0–1). Valid for any visual clip. */
  setClipOpacity(clipId: string, opacity: number): boolean {
    const clip = this.project.timeline.clips.find((c) => c.id === clipId);
    if (!clip) return false;
    this.execute(new SetOpacityCommand(clipId, opacity));
    return true;
  }

  /** Set fade-in / fade-out lengths (frames). Either may be undefined to keep current. */
  setClipFade(clipId: string, fadeInFrames?: Frame, fadeOutFrames?: Frame): boolean {
    const clip = this.project.timeline.clips.find((c) => c.id === clipId);
    if (!clip) return false;
    const fin = fadeInFrames === undefined ? undefined : clampFrame(fadeInFrames, 0);
    const fout = fadeOutFrames === undefined ? undefined : clampFrame(fadeOutFrames, 0);
    this.execute(new SetFadeCommand(clipId, fin, fout));
    return true;
  }

  /**
   * Set or clear a geometric in-transition (wipe/slide) on a clip.
   * Pass `transition` as null to clear. Not undoable via a dedicated command —
   * uses a project replace so it's a single undo step.
   */
  setClipTransition(clipId: string, transition: ClipTransition | null): boolean {
    const clips = this.project.timeline.clips;
    const idx = clips.findIndex((c) => c.id === clipId);
    if (idx < 0) return false;
    const next = clips.map((c) => {
      if (c.id !== clipId) return c;
      const copy = { ...c };
      if (transition === null || transition.frames <= 0) {
        delete copy.transitionIn;
      } else {
        copy.transitionIn = {
          ...transition,
          frames: clampFrame(transition.frames, 1),
        };
      }
      return copy;
    });
    this.execute(new ReplaceClipsCommand(next, 'Set transition'));
    return true;
  }

  /**
   * Create a cross-dissolve between two adjacent clips on the same track.
   * `firstClipId` must be immediately followed by `secondClipId`. The second
   * clip (and everything after it on the track) shifts left by `durationFrames`
   * to overlap the first clip's tail; the first gets a matching fade-out and the
   * second a matching fade-in, so the overlap renders as a dissolve.
   * Returns false if the clips aren't adjacent or the overlap won't fit.
   */
  createCrossDissolve(firstClipId: string, secondClipId: string, durationFrames: Frame): boolean {
    const clips = this.project.timeline.clips;
    const first = clips.find((c) => c.id === firstClipId);
    const second = clips.find((c) => c.id === secondClipId);
    if (!first || !second) return false;
    if (first.trackId !== second.trackId) return false;

    const d = clampFrame(durationFrames, 1);
    const firstEnd = first.startFrame + first.durationFrames;
    // Require adjacency (second starts where first ends).
    if (second.startFrame !== firstEnd) return false;
    // The overlap must fit inside both clips.
    if (d >= first.durationFrames || d >= second.durationFrames) return false;

    const next: Clip[] = clips.map((c) => {
      if (c.id === firstClipId) {
        return { ...c, fadeOutFrames: d };
      }
      if (c.trackId === first.trackId && c.startFrame >= second.startFrame) {
        // Shift the second clip and everything after it left to create the overlap.
        const shifted = { ...c, startFrame: Math.max(0, c.startFrame - d) };
        if (c.id === secondClipId) shifted.fadeInFrames = d;
        return shifted;
      }
      return c;
    });

    this.execute(new ReplaceClipsCommand(next, 'Cross dissolve'));
    return true;
  }

  /**
   * Remove silent ranges from a clip and ripple-close the gaps (#175).
   *
   * `silentRangesSec` are silent spans in SOURCE seconds (from the detector).
   * They are converted to source frames at the project frame rate, intersected
   * with the clip, and the kept segments are placed contiguously; clips after
   * the original on the same track shift left by the removed amount.
   *
   * Returns the number of segments removed (0 = nothing changed).
   */
  removeSilence(clipId: string, silentRangesSec: SilentRange[]): number {
    const clip = this.project.timeline.clips.find((c) => c.id === clipId);
    if (!clip) return 0;

    const fps = this.project.settings.fps;
    const silentFrameRanges: FrameRange[] = silentRangesSec.map((r) => ({
      start: Math.round(r.startSec * fps),
      end: Math.round(r.endSec * fps),
    }));

    const plan = planSilenceRemoval(clip.inPoint, clip.outPoint, silentFrameRanges);
    if (plan.removedFrames <= 0 || plan.kept.length === 0) return 0;

    // Build replacement clips for the kept segments, placed contiguously
    // starting at the original clip's timeline position.
    const newClips: Clip[] = [];
    let cursorTimeline = clip.startFrame;
    for (const seg of plan.kept) {
      const segDuration = seg.outPoint - seg.inPoint;
      newClips.push({
        ...clip,
        id: nanoid(),
        startFrame: cursorTimeline,
        durationFrames: segDuration,
        inPoint: seg.inPoint,
        outPoint: seg.outPoint,
      });
      cursorTimeline += segDuration;
    }

    const originalEnd = clip.startFrame + clip.durationFrames;
    const totalKept = cursorTimeline - clip.startFrame;
    const rippleShift = clip.durationFrames - totalKept; // frames freed up

    // Assemble the new full clips array: drop the original, add segments,
    // and ripple clips that started at/after the original's end on this track.
    const nextClips: Clip[] = [];
    for (const c of this.project.timeline.clips) {
      if (c.id === clipId) continue;
      if (c.trackId === clip.trackId && c.startFrame >= originalEnd && rippleShift > 0) {
        nextClips.push({ ...c, startFrame: Math.max(0, c.startFrame - rippleShift) });
      } else {
        nextClips.push(c);
      }
    }
    nextClips.push(...newClips);

    this.execute(new ReplaceClipsCommand(nextClips, 'Remove silence'));
    return silentRangesSec.length;
  }

  // ─── Media management (not undoable — these mutate the asset library) ──────

  addMedia(asset: MediaAsset): void {
    this.project = {
      ...this.project,
      media: [...this.project.media, asset],
      updatedAt: new Date().toISOString(),
    };
    this.notify();
  }

  removeMedia(assetId: string): void {
    this.project = {
      ...this.project,
      media: this.project.media.filter((m) => m.id !== assetId),
      updatedAt: new Date().toISOString(),
    };
    this.notify();
  }

  // ─── Project lifecycle ─────────────────────────────────────────────────────

  loadProject(project: Project): void {
    this.project = project;
    this.history.clear();
    this.notify();
  }

  /**
   * Replace the project WITHOUT notifying subscribers or touching history.
   * Used by the main process to mirror the renderer's authoritative state
   * (renderer -> main sync) so MCP/agent reads see live data, without
   * triggering a sync echo back to the renderer.
   */
  setProjectSilent(project: Project): void {
    this.project = project;
  }

  /**
   * Adopt an externally-produced project (e.g. an AI agent edit) as a single
   * undoable step, so it is visible in the UI and reversible from the UI's
   * undo. Notifies subscribers.
   */
  adoptProject(project: Project, label = 'AI edit'): void {
    this.execute(new ReplaceProjectCommand(project, label));
  }

  reset(): void {
    this.project = createEmptyProject();
    this.history.clear();
    this.notify();
  }

  // ─── Subscriptions ─────────────────────────────────────────────────────────

  subscribe(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.project);
    }
  }

  // ─── Serialization ─────────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify(this.project, null, 2);
  }

  static deserialize(json: string): EditorController {
    const project: Project = JSON.parse(json);
    return new EditorController(project);
  }
}
