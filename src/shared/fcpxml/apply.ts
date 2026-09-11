/**
 * Apply a parsed FCPXML plan (#154) onto an editor controller.
 *
 * Shared by future UI flows; the agent executor currently inlines its own
 * variant because it also owns offline reporting semantics. This module is
 * the canonical mapping and is unit-tested against exporter output.
 *
 * Contract: ADDITIVE only — fresh tracks are synthesized per lane so an
 * import never collides with existing content, mirroring the agent tool.
 */

import type { Project, Clip } from '../types/project';
import type { EditorController } from '../editor/controller';
import type { ParsedFcpxml } from './importer';
import { sanitizeCrop } from '../media/source-crop';
import {
  cropFromTrim,
  placementFromTransform,
  type FcpxmlTransform,
  type PlacementContext,
} from './geometry';

export type { PlacementContext };

export interface ApplyFcpxmlResult {
  placedClips: number;
  titles: number;
  tracksCreated: number;
  skippedOffline: number;
}

export interface ImportedClipFields {
  opacity?: number;
  volume?: number;
  muted?: boolean;
  cropTrim?: { left: number; top: number; right: number; bottom: number };
  transform?: FcpxmlTransform;
}

/**
 * One applyClipProperties callback carrying every imported adjustment, or
 * null when the plan clip carries none — so an untouched clip adds no undo
 * history. Shared by both materializers (this module and the agent
 * executor's inline variant) so the mapping cannot drift between them.
 */
export function importedClipPatch(
  clip: ImportedClipFields,
  ctx: PlacementContext,
): ((draft: Clip) => boolean) | null {
  const sets: Array<(draft: Clip) => void> = [];
  if (clip.opacity !== undefined) {
    const opacity = Math.min(1, Math.max(0, clip.opacity));
    sets.push((draft) => { draft.opacity = opacity; });
  }
  if (clip.volume !== undefined || clip.muted !== undefined) {
    const volume = clip.volume === undefined ? 1 : Math.min(1, Math.max(0, clip.volume));
    const muted = clip.muted ?? false;
    sets.push((draft) => { draft.volume = volume; draft.muted = muted; });
  }
  if (clip.cropTrim) {
    const crop = cropFromTrim(clip.cropTrim, ctx, sanitizeCrop);
    if (crop) sets.push((draft) => { draft.crop = crop; });
  }
  if (clip.transform) {
    // Canonical form: the fitted box carries the size, scale carries the
    // sign, the anchor resets — rendering matches by construction.
    const placement = placementFromTransform(clip.transform, ctx);
    sets.push((draft) => {
      draft.x = placement.x;
      draft.y = placement.y;
      draft.width = placement.width;
      draft.height = placement.height;
      draft.rotation = placement.rotation;
      draft.scaleX = placement.scaleX;
      draft.scaleY = placement.scaleY;
      draft.anchorX = 0;
      draft.anchorY = 0;
    });
  }
  if (sets.length === 0) return null;
  return (draft) => {
    for (const set of sets) set(draft);
    return true;
  };
}

/**
 * @param plan          Parsed plan (see importer).
 * @param assetIdByPath Library asset id per absolute asset path; entries the
 *                      caller could not add are treated as offline/skipped.
 * @param sourceDimsByPath Optional probed source dimensions per asset path,
 *                      for placing geometry and crop. Absent entries fall back
 *                      to the canvas (see geometry).
 */
export function applyFcpxmlPlan(
  editor: EditorController,
  plan: ParsedFcpxml,
  assetIdByPath: ReadonlyMap<string, string>,
  sourceDimsByPath: ReadonlyMap<string, { width?: number; height?: number }> = new Map(),
): ApplyFcpxmlResult {
  const projectFps = editor.getProject().settings.fps;
  const sourceFps = plan.fps ?? projectFps;
  const toFrames = (frames: number) => Math.round(frames * (projectFps / sourceFps));
  const canvasWidth = editor.getProject().settings.width;
  const canvasHeight = editor.getProject().settings.height;

  // Lanes materialize as fresh video/audio tracks.
  const videoLaneTrack = new Map<number, string>();
  const audioLaneTrack = new Map<number, string>();
  const maxVLane = Math.max(0, ...plan.clips.filter((c) => c.kind !== 'audio').map((c) => c.lane));
  for (let lane = 0; lane <= maxVLane; lane++) {
    videoLaneTrack.set(lane, editor.addTrack('video'));
  }
  const audioLanes = [...new Set(plan.clips.filter((c) => c.kind === 'audio').map((c) => c.lane))].sort((a, b) => a - b);
  for (const lane of audioLanes) {
    audioLaneTrack.set(lane, editor.addTrack('audio'));
  }

  let placedClips = 0;
  let titles = 0;
  let skippedOffline = 0;

  for (const clip of plan.clips) {
    const startFrame = toFrames(clip.startFrame);
    const durationFrames = Math.max(1, toFrames(clip.durationFrames));

    if (clip.kind === 'title') {
      const trackId = videoLaneTrack.get(clip.lane);
      if (!trackId) continue;
      const titleId = editor.addTitleClip({
        trackId,
        text: clip.text,
        startFrame,
        durationFrames,
      });
      editor.applyClipProperties([titleId], 'Import title style', (draft) => {
        if (clip.colorHex) draft.titleColor = clip.colorHex;
        if (clip.fontSizePx) draft.titleSizeRatio = clip.fontSizePx / settingsHeight(editor);
        if (clip.fontFamily) draft.titleFontFamily = clip.fontFamily;
        if (clip.alignment) draft.titleAlign = clip.alignment;
        return true;
      });
      titles += 1;
      continue;
    }

    const assetId = assetIdByPath.get(clip.assetPath);
    if (!assetId) {
      skippedOffline += 1;
      continue;
    }
    const trackId = clip.kind === 'audio'
      ? audioLaneTrack.get(clip.lane)
      : videoLaneTrack.get(clip.lane);
    if (!trackId) continue;

    const sourceIn = toFrames(clip.sourceInFrame);
    const clipId = editor.addClip({
      assetId,
      trackId,
      startFrame,
      durationFrames,
    });
    // Source trim is a follow-up edit: addClip has no In/Out params.
    // Source trim is a follow-up edit: addClip has no In/Out params.
    if (clip.sourceInFrame > 0) {
      editor.trimClip(clipId, sourceIn, sourceIn + durationFrames);
    }
    // Imported adjustments (opacity, volume, crop, geometry) ride one
    // undoable batch; a clip carrying none adds no history.
    const dims = sourceDimsByPath.get(clip.assetPath);
    const patch = importedClipPatch(clip, {
      canvasWidth,
      canvasHeight,
      sourceWidth: dims?.width,
      sourceHeight: dims?.height,
    });
    if (patch) editor.applyClipProperties([clipId], 'Import clip adjustments', patch);
    placedClips += 1;
  }

  return {
    placedClips,
    titles,
    tracksCreated: videoLaneTrack.size + audioLaneTrack.size,
    skippedOffline,
  };
}

function settingsHeight(editor: EditorController): number {
  return (editor.getProject() as Project).settings.height;
}
