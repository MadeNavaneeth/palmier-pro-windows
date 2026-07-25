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
  AddMediaAndClipsCommand,
  AddTrackCommand,
  SetBlendModeCommand,
  SetOpacityCommand,
  SetFadeCommand,
  ReplaceClipsCommand,
  ReplaceTracksCommand,
  ReplaceProjectCommand,
} from './commands';
import type { Command } from './commands';
import type { BlendMode } from '../types/blend-mode';
import type { ClipTransition } from './transition';
import { planSilenceRemoval, type FrameRange, type SilentRange } from '../audio/silence-detector';
import { hasEmbeddedAudio, isMediaCompatibleWithTrack, placementDuration } from './placement';
import { computeRippleShifts, type RippleRange } from './ripple';

export type StateChangeListener = (project: Project) => void;

export interface MediaPlacementResult {
  assetIds: string[];
  clipIds: string[];
}

export interface RippleDeleteReport {
  removedClipIds: string[];
  shiftedClipIds: string[];
}

export type TrimEdge = 'left' | 'right';

export interface RippleTrimReport {
  resizedClipIds: string[];
  shiftedClipIds: string[];
  durationDelta: Frame;
}

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

  expandLinkedClipIds(clipIds: Iterable<string>): string[] {
    const requested = new Set(clipIds);
    const groupIds = new Set(
      this.project.timeline.clips
        .filter((clip) => requested.has(clip.id) && clip.linkGroupId)
        .map((clip) => clip.linkGroupId!),
    );

    for (const clip of this.project.timeline.clips) {
      if (clip.linkGroupId && groupIds.has(clip.linkGroupId)) {
        requested.add(clip.id);
      }
    }
    return [...requested];
  }

  private canEditClipIds(clipIds: Iterable<string>): boolean {
    const ids = new Set(clipIds);
    const lockedTrackIds = new Set(
      this.project.timeline.tracks.filter((track) => track.locked).map((track) => track.id),
    );
    return this.project.timeline.clips
      .filter((clip) => ids.has(clip.id))
      .every((clip) => !lockedTrackIds.has(clip.trackId));
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
    const type = params.type || asset?.type || 'video';
    const track = this.project.timeline.tracks.find((candidate) => candidate.id === params.trackId);

    if (asset) {
      const tracks: Track[] = [];
      const linkGroupId = type === 'video'
        && track?.type === 'video'
        && hasEmbeddedAudio(asset)
        ? nanoid()
        : undefined;
      const clip = this.createPlacedClip(
        asset,
        type,
        params.trackId,
        startFrame,
        duration,
        linkGroupId,
      );
      const clips = [clip];

      if (linkGroupId) {
        const audioTrack = this.resolveAudioPlacementTrack(startFrame, duration, clips, tracks);
        clips.push(
          this.createPlacedClip(asset, 'audio', audioTrack.id, startFrame, duration, linkGroupId),
        );
      }

      this.execute(new AddMediaAndClipsCommand([], clips, 'Add clip', tracks));
      return clip.id;
    }

    const clip = this.createPlacedClip(
      {
        id: params.assetId,
        path: '',
        filename: params.assetId,
        type: type === 'audio' || type === 'image' ? type : 'video',
        duration,
        fileSize: 0,
        addedAt: new Date().toISOString(),
      },
      type,
      params.trackId,
      startFrame,
      duration,
    );
    this.execute(new AddClipCommand(clip));
    return clip.id;
  }

  removeClip(clipId: string): boolean {
    return this.removeClips([clipId]);
  }

  removeClips(clipIds: Iterable<string>, includeLinked = true): boolean {
    const requested = [...clipIds];
    const ids = new Set(includeLinked ? this.expandLinkedClipIds(requested) : requested);
    if (!this.project.timeline.clips.some((clip) => ids.has(clip.id))) return false;
    if (!this.canEditClipIds(ids)) return false;
    this.execute(
      new ReplaceClipsCommand(
        this.project.timeline.clips.filter((clip) => !ids.has(clip.id)),
        ids.size > 1 ? 'Remove linked clips' : 'Remove clip',
      ),
    );
    return true;
  }

  rippleDeleteClips(clipIds: Iterable<string>): RippleDeleteReport | null {
    const ids = new Set(this.expandLinkedClipIds(clipIds));
    const selected = this.project.timeline.clips.filter((clip) => ids.has(clip.id));
    if (selected.length === 0 || !this.canEditClipIds(ids)) return null;

    const globalRanges: RippleRange[] = selected.map((clip) => ({
      start: clip.startFrame,
      end: clip.startFrame + clip.durationFrames,
    }));
    const shifts = new Map<string, Frame>();

    for (const track of this.project.timeline.tracks) {
      if (track.locked) continue;

      const removedOnTrack = selected.filter((clip) => clip.trackId === track.id);
      const ranges = removedOnTrack.length > 0
        ? removedOnTrack.map((clip) => ({
            start: clip.startFrame,
            end: clip.startFrame + clip.durationFrames,
          }))
        : track.syncLocked !== false
          ? globalRanges
          : [];
      if (ranges.length === 0) continue;

      const remaining = this.project.timeline.clips.filter(
        (clip) => clip.trackId === track.id && !ids.has(clip.id),
      );
      for (const shift of computeRippleShifts(remaining, ranges)) {
        shifts.set(shift.clipId, shift.startFrame);
      }
    }

    const clips = this.project.timeline.clips
      .filter((clip) => !ids.has(clip.id))
      .map((clip) => {
        const startFrame = shifts.get(clip.id);
        return startFrame === undefined ? clip : { ...clip, startFrame };
      });
    this.execute(new ReplaceClipsCommand(clips, 'Ripple delete clips'));

    return {
      removedClipIds: selected.map((clip) => clip.id),
      shiftedClipIds: [...shifts.keys()],
    };
  }

  rippleDeleteGap(trackId: string, range: RippleRange): RippleDeleteReport | null {
    const track = this.project.timeline.tracks.find((candidate) => candidate.id === trackId);
    const start = asValidFrame(range.start);
    const end = asValidFrame(range.end);
    if (!track || track.locked || start === null || end === null || end <= start) return null;

    const anchorClips = this.project.timeline.clips.filter((clip) => clip.trackId === trackId);
    if (anchorClips.some((clip) =>
      clip.startFrame < end && clip.startFrame + clip.durationFrames > start
    )) {
      return null;
    }

    const shifts = new Map<string, Frame>();
    for (const candidate of this.project.timeline.tracks) {
      if (candidate.locked || (candidate.id !== trackId && candidate.syncLocked === false)) continue;
      const clips = this.project.timeline.clips.filter((clip) => clip.trackId === candidate.id);
      const moving = clips.filter((clip) => clip.startFrame >= end);
      if (moving.length === 0) continue;

      const shift = end - start;
      const stationaryEnd = clips
        .filter((clip) => clip.startFrame < end)
        .reduce((latest, clip) => Math.max(latest, clip.startFrame + clip.durationFrames), 0);
      const firstMovingStart = Math.min(...moving.map((clip) => clip.startFrame));
      if (firstMovingStart - shift < stationaryEnd) return null;

      for (const clip of moving) shifts.set(clip.id, clip.startFrame - shift);
    }

    if (shifts.size === 0) return null;
    const clips = this.project.timeline.clips.map((clip) => {
      const startFrame = shifts.get(clip.id);
      return startFrame === undefined ? clip : { ...clip, startFrame };
    });
    this.execute(new ReplaceClipsCommand(clips, 'Ripple delete gap'));
    return { removedClipIds: [], shiftedClipIds: [...shifts.keys()] };
  }

  moveClip(clipId: string, newStartFrame: Frame, newTrackId?: string): void {
    const clip = this.project.timeline.clips.find((candidate) => candidate.id === clipId);
    if (!clip) return;

    const targetFrame = clampFrame(newStartFrame);
    const delta = targetFrame - clip.startFrame;
    const linkedIds = new Set(this.expandLinkedClipIds([clipId]));
    if (!this.canEditClipIds(linkedIds)) return;
    if (newTrackId && this.project.timeline.tracks.find((track) => track.id === newTrackId)?.locked) {
      return;
    }
    const clips = this.project.timeline.clips.map((candidate) => {
      if (!linkedIds.has(candidate.id)) return candidate;
      return {
        ...candidate,
        startFrame: clampFrame(candidate.startFrame + delta),
        trackId: candidate.id === clipId && newTrackId ? newTrackId : candidate.trackId,
      };
    });
    this.execute(new ReplaceClipsCommand(clips, linkedIds.size > 1 ? 'Move linked clips' : 'Move clip'));
  }

  trimClip(clipId: string, newInPoint: Frame, newOutPoint: Frame): void {
    // Reject non-finite/out-of-range points outright; clamp ordering so
    // outPoint is always strictly greater than inPoint.
    const inPoint = clampFrame(newInPoint);
    const outPoint = clampFrame(newOutPoint, inPoint + 1);
    const linkedIds = new Set(this.expandLinkedClipIds([clipId]));
    if (!linkedIds.has(clipId) || !this.project.timeline.clips.some((clip) => clip.id === clipId)) {
      return;
    }
    if (!this.canEditClipIds(linkedIds)) return;
    const clips = this.project.timeline.clips.map((clip) =>
      linkedIds.has(clip.id)
        ? {
            ...clip,
            inPoint,
            outPoint,
            durationFrames: outPoint - inPoint,
          }
        : clip,
    );
    this.execute(new ReplaceClipsCommand(clips, linkedIds.size > 1 ? 'Trim linked clips' : 'Trim clip'));
  }

  trimClipEdge(
    clipId: string,
    edge: TrimEdge,
    deltaFrames: Frame,
    ripple = false,
  ): RippleTrimReport | null {
    const lead = this.project.timeline.clips.find((clip) => clip.id === clipId);
    const requestedDelta = Math.round(deltaFrames);
    if (!lead || !Number.isFinite(requestedDelta) || requestedDelta === 0) return null;

    const targetIds = new Set(this.expandLinkedClipIds([clipId]));
    if (!this.canEditClipIds(targetIds)) return null;
    const targets = this.project.timeline.clips.filter((clip) => targetIds.has(clip.id));
    const durationDeltaRequested = edge === 'right' ? requestedDelta : -requestedDelta;

    let minDurationDelta = Math.max(...targets.map((clip) => -(clip.durationFrames - 1)));
    let maxDurationDelta = Math.min(...targets.map((clip) => {
      if (edge === 'left') {
        return ripple ? clip.inPoint : Math.min(clip.inPoint, clip.startFrame);
      }
      const asset = this.project.media.find((candidate) => candidate.id === clip.assetId);
      return asset && asset.duration > 0
        ? Math.max(0, asset.duration - clip.outPoint)
        : Number.POSITIVE_INFINITY;
    }));

    const targetTrackIds = new Set(targets.map((clip) => clip.trackId));
    const leadEnd = lead.startFrame + lead.durationFrames;
    if (ripple && durationDeltaRequested < 0) {
      for (const track of this.project.timeline.tracks) {
        if (
          track.locked
          || targetTrackIds.has(track.id)
          || track.syncLocked === false
        ) {
          continue;
        }
        const clips = this.project.timeline.clips.filter((clip) => clip.trackId === track.id);
        const followers = clips.filter((clip) => clip.startFrame >= leadEnd);
        if (followers.length === 0) continue;
        const firstFollower = Math.min(...followers.map((clip) => clip.startFrame));
        const stationaryEnd = clips
          .filter((clip) => clip.startFrame < leadEnd)
          .reduce((latest, clip) => Math.max(latest, clip.startFrame + clip.durationFrames), 0);
        minDurationDelta = Math.max(minDurationDelta, -(firstFollower - stationaryEnd));
      }
    }

    const durationDelta = Math.min(
      maxDurationDelta,
      Math.max(minDurationDelta, durationDeltaRequested),
    );
    if (!Number.isFinite(durationDelta) || durationDelta === 0) return null;

    const shifts = new Map<string, Frame>();
    if (ripple) {
      for (const track of this.project.timeline.tracks) {
        if (track.locked || (track.syncLocked === false && !targetTrackIds.has(track.id))) continue;
        const trackTarget = targets.find((clip) => clip.trackId === track.id);
        const shiftPoint = trackTarget
          ? trackTarget.startFrame + trackTarget.durationFrames
          : leadEnd;
        for (const clip of this.project.timeline.clips) {
          if (
            clip.trackId === track.id
            && !targetIds.has(clip.id)
            && clip.startFrame >= shiftPoint
          ) {
            shifts.set(clip.id, Math.max(0, clip.startFrame + durationDelta));
          }
        }
      }
    }

    const clips = this.project.timeline.clips.map((clip) => {
      if (targetIds.has(clip.id)) {
        if (edge === 'right') {
          return {
            ...clip,
            durationFrames: clip.durationFrames + durationDelta,
            outPoint: clip.outPoint + durationDelta,
          };
        }
        return {
          ...clip,
          startFrame: ripple ? clip.startFrame : clip.startFrame - durationDelta,
          durationFrames: clip.durationFrames + durationDelta,
          inPoint: clip.inPoint - durationDelta,
        };
      }
      const startFrame = shifts.get(clip.id);
      return startFrame === undefined ? clip : { ...clip, startFrame };
    });
    this.execute(new ReplaceClipsCommand(
      clips,
      ripple ? 'Ripple trim clips' : targetIds.size > 1 ? 'Trim linked clips' : 'Trim clip',
    ));
    return {
      resizedClipIds: targets.map((clip) => clip.id),
      shiftedClipIds: [...shifts.keys()],
      durationDelta,
    };
  }

  splitClip(clipId: string, atFrame: Frame): string | null {
    const clip = this.project.timeline.clips.find((c) => c.id === clipId);
    if (!clip) return null;

    // Validate the split frame before any arithmetic; null = reject.
    const frame = asValidFrame(atFrame);
    if (frame === null) return null;

    const relativeFrame = frame - clip.startFrame;
    if (relativeFrame <= 0 || relativeFrame >= clip.durationFrames) return null;

    const linkedIds = new Set(this.expandLinkedClipIds([clipId]));
    const splitTargets = this.project.timeline.clips.filter((candidate) =>
      linkedIds.has(candidate.id)
      && frame > candidate.startFrame
      && frame < candidate.startFrame + candidate.durationFrames,
    );
    if (splitTargets.length === 0) return null;
    if (!this.canEditClipIds(splitTargets.map((target) => target.id))) return null;

    const rightLinkGroupId = splitTargets.length > 1 ? nanoid() : undefined;
    const rightIds = new Map<string, string>();
    const clips = this.project.timeline.clips.flatMap((candidate) => {
      if (!splitTargets.some((target) => target.id === candidate.id)) return [candidate];

      const relativeFrame = frame - candidate.startFrame;
      const rightId = nanoid();
      rightIds.set(candidate.id, rightId);
      return [
        {
          ...candidate,
          durationFrames: relativeFrame,
          outPoint: candidate.inPoint + relativeFrame,
        },
        {
          ...candidate,
          id: rightId,
          linkGroupId: rightLinkGroupId,
          startFrame: frame,
          durationFrames: candidate.durationFrames - relativeFrame,
          inPoint: candidate.inPoint + relativeFrame,
        },
      ];
    });

    this.execute(new ReplaceClipsCommand(clips, splitTargets.length > 1 ? 'Split linked clips' : 'Split clip'));
    return rightIds.get(clipId) || null;
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
      syncLocked: true,
      order: this.project.timeline.tracks.length,
    };
    this.execute(new AddTrackCommand(track));
    return track.id;
  }

  setTrackLocked(trackId: string, locked: boolean): boolean {
    return this.updateTrack(trackId, { locked }, locked ? 'Lock track' : 'Unlock track');
  }

  setTrackVisible(trackId: string, visible: boolean): boolean {
    return this.updateTrack(
      trackId,
      { visible },
      visible ? 'Show track' : 'Hide track',
    );
  }

  setTrackSyncLocked(trackId: string, syncLocked: boolean): boolean {
    return this.updateTrack(
      trackId,
      { syncLocked },
      syncLocked ? 'Enable sync lock' : 'Disable sync lock',
    );
  }

  private updateTrack(trackId: string, patch: Partial<Track>, label: string): boolean {
    const track = this.project.timeline.tracks.find((candidate) => candidate.id === trackId);
    if (!track) return false;
    this.execute(
      new ReplaceTracksCommand(
        this.project.timeline.tracks.map((candidate) =>
          candidate.id === trackId ? { ...candidate, ...patch } : candidate,
        ),
        label,
      ),
    );
    return true;
  }

  setPlayhead(frame: Frame): void {
    this.project = {
      ...this.project,
      timeline: {
        ...this.project.timeline,
        playheadFrame: clampFrame(frame),
      },
    };
    this.notify();
  }

  importMediaAssets(assets: MediaAsset[]): string[] {
    if (assets.length === 0) return [];
    this.execute(new AddMediaAndClipsCommand(assets, [], 'Import media'));
    return assets.map((asset) => asset.id);
  }

  placeMediaAssets(
    assetIds: string[],
    trackId: string,
    startFrame: Frame,
  ): MediaPlacementResult {
    return this.addMediaAndClips([], assetIds, trackId, startFrame, 'Place media');
  }

  importAndPlaceMedia(
    assets: MediaAsset[],
    trackId: string,
    startFrame: Frame,
  ): MediaPlacementResult {
    return this.addMediaAndClips(
      assets,
      assets.map((asset) => asset.id),
      trackId,
      startFrame,
      'Import and place media',
    );
  }

  private addMediaAndClips(
    importedAssets: MediaAsset[],
    assetIds: string[],
    trackId: string,
    startFrame: Frame,
    label: string,
  ): MediaPlacementResult {
    const track = this.project.timeline.tracks.find((candidate) => candidate.id === trackId);
    const importedById = new Map(importedAssets.map((asset) => [asset.id, asset]));
    const allAssets = new Map(this.project.media.map((asset) => [asset.id, asset]));
    for (const asset of importedAssets) allAssets.set(asset.id, asset);

    const clips: Clip[] = [];
    const tracks: Track[] = [];
    let cursor = clampFrame(startFrame);

    if (track && !track.locked) {
      for (const assetId of assetIds) {
        const asset = allAssets.get(assetId);
        if (!asset || !isMediaCompatibleWithTrack(asset.type, track.type)) continue;

        const duration = placementDuration(asset, this.project.settings.fps);
        const linkGroupId = hasEmbeddedAudio(asset) && track.type === 'video'
          ? nanoid()
          : undefined;
        clips.push(this.createPlacedClip(asset, asset.type, track.id, cursor, duration, linkGroupId));

        if (linkGroupId) {
          const audioTrack = this.resolveAudioPlacementTrack(cursor, duration, clips, tracks);
          clips.push(
            this.createPlacedClip(asset, 'audio', audioTrack.id, cursor, duration, linkGroupId),
          );
        }
        cursor = clampFrame(cursor + duration);
      }
    }

    const media = importedAssets.filter((asset) => importedById.has(asset.id));
    if (media.length === 0 && clips.length === 0) {
      return { assetIds: [], clipIds: [] };
    }

    this.execute(new AddMediaAndClipsCommand(media, clips, label, tracks));
    return {
      assetIds: media.map((asset) => asset.id),
      clipIds: clips.map((clip) => clip.id),
    };
  }

  private createPlacedClip(
    asset: MediaAsset,
    type: ClipType,
    trackId: string,
    startFrame: Frame,
    durationFrames: Frame,
    linkGroupId?: string,
  ): Clip {
    return {
      id: nanoid(),
      assetId: asset.id,
      type,
      trackId,
      linkGroupId,
      startFrame,
      durationFrames,
      inPoint: 0,
      outPoint: durationFrames,
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
      label: asset.filename,
    };
  }

  private resolveAudioPlacementTrack(
    startFrame: Frame,
    durationFrames: Frame,
    plannedClips: Clip[],
    plannedTracks: Track[],
  ): Track {
    const endFrame = startFrame + durationFrames;
    const candidates = [...this.project.timeline.tracks, ...plannedTracks]
      .filter((track) => track.type === 'audio' && !track.locked)
      .sort((left, right) => left.order - right.order);
    const allClips = [...this.project.timeline.clips, ...plannedClips];

    const available = candidates.find((track) =>
      allClips
        .filter((clip) => clip.trackId === track.id)
        .every((clip) => {
          const clipEnd = clip.startFrame + clip.durationFrames;
          return clipEnd <= startFrame || clip.startFrame >= endFrame;
        }),
    );
    if (available) return available;

    const track: Track = {
      id: nanoid(),
      name: `Audio ${
        this.project.timeline.tracks.filter((candidate) => candidate.type === 'audio').length
        + plannedTracks.filter((candidate) => candidate.type === 'audio').length
        + 1
      }`,
      type: 'audio',
      locked: false,
      visible: true,
      syncLocked: true,
      order: this.project.timeline.tracks.length + plannedTracks.length,
    };
    plannedTracks.push(track);
    return track;
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
