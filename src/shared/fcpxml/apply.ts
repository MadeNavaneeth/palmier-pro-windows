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

import type { Project } from '../types/project';
import type { EditorController } from '../editor/controller';
import type { ParsedFcpxml } from './importer';

export interface ApplyFcpxmlResult {
  placedClips: number;
  titles: number;
  tracksCreated: number;
  skippedOffline: number;
}

/**
 * @param plan          Parsed plan (see importer).
 * @param assetIdByPath Library asset id per absolute asset path; entries the
 *                      caller could not add are treated as offline/skipped.
 */
export function applyFcpxmlPlan(
  editor: EditorController,
  plan: ParsedFcpxml,
  assetIdByPath: ReadonlyMap<string, string>,
): ApplyFcpxmlResult {
  const projectFps = editor.getProject().settings.fps;
  const sourceFps = plan.fps ?? projectFps;
  const toFrames = (frames: number) => Math.round(frames * (projectFps / sourceFps));

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
    if (clip.sourceInFrame > 0) {
      editor.trimClip(clipId, sourceIn, sourceIn + durationFrames);
    }
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
