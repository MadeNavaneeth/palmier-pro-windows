/**
 * Materialize caption cues (#91 planner output) onto an editor controller
 * as title clips on ONE fresh video track. Shared by the agent executor and
 * the Captions-tab UI flow so both place identically.
 *
 * The placement contract lives here rather than at the call sites, and the
 * SRT/VTT importer places through the same `placeCaptionCue` math, so one
 * rule covers every surface that puts text on the timeline:
 *
 * 1. ANCHOR. A cue's seconds are relative to the SOURCE it was transcribed
 *    from, never to the timeline, so cues are laid out from a base frame:
 *    the source asset's own position on the timeline when it is there, else
 *    the playhead (the importer's default). Without the base, every cue of a
 *    clip that does not begin at frame 0 lands exactly as many frames early
 *    as that clip sits late — 900 frames / 30s for a podcast placed at 30s.
 * 2. CLAMP. The range is clamped into [0, MAX_FRAME] and the duration is
 *    truncated to the room that is left, so a cue can never write a frame
 *    index the rest of the editor cannot represent — including when a
 *    transcription provider reports absurd timings.
 * 3. SANITIZE. Cue text goes through the title sanitizer and a cue that does
 *    not survive is skipped, exactly as the importer skips it; a skipped cue
 *    is not counted.
 *
 * The whole placement — the new track and every cue — is ONE undo step.
 */

import type { EditorController } from '../editor/controller';
import { sanitizeTitleText } from '../editor/title';
import type { Frame } from '../types/project';
import { clampFrame, MAX_FRAME } from '../utils/safe-number';
import type { CaptionCue } from './planner';

export interface AppliedCaptions {
  trackId: string;
  /** Clips actually created; a cue refused by sanitization is not counted. */
  count: number;
}

/** One cue resolved to a clip range on the timeline. */
export interface CaptionPlacement {
  startFrame: Frame;
  durationFrames: Frame;
}

/**
 * Resolve one cue to the clip range it occupies, laid out from `base` and
 * clamped into representable frames. Pure, so the transcriber path and the
 * SRT/VTT importer cannot drift apart.
 */
export function placeCaptionCue(
  base: Frame,
  cue: { startSec: number; endSec: number },
  fps: number,
): CaptionPlacement {
  const startOffset = Math.round(cue.startSec * fps);
  const endOffset = Math.round(cue.endSec * fps);
  // One frame of headroom below the ceiling, so a duration truncated to the
  // remaining room is still at least one frame and the END stays <= MAX_FRAME.
  const startFrame = Math.min(clampFrame(base + startOffset), MAX_FRAME - 1);
  const durationFrames = clampFrame(
    Math.max(1, Math.min(endOffset - startOffset, MAX_FRAME - startFrame)),
    1,
  );
  return { startFrame, durationFrames };
}

/**
 * The frame a cue list for `assetId` is laid out from: the asset's earliest
 * position on the active timeline, or the playhead when the asset is not on
 * it. Earliest is the moment the source's audio first plays, and it stays
 * deterministic when one source is used more than once.
 */
function captionBaseFrame(editor: EditorController, assetId?: string): Frame {
  if (assetId) {
    let earliest: Frame | null = null;
    for (const clip of editor.getClips()) {
      if (clip.assetId !== assetId) continue;
      if (earliest === null || clip.startFrame < earliest) earliest = clip.startFrame;
    }
    if (earliest !== null) return clampFrame(earliest);
  }
  return clampFrame(editor.getPlayhead());
}

export interface ApplyCaptionCuesOptions {
  /**
   * Library asset the cues describe. Anchors the cues over that asset's own
   * timeline position; omit it when the source is not on the timeline and
   * the playhead is the intended base.
   */
  assetId?: string;
}

export function applyCaptionCues(
  editor: EditorController,
  cues: readonly CaptionCue[],
  options: ApplyCaptionCuesOptions = {},
): AppliedCaptions {
  const fps = editor.getProject().settings.fps;
  const base = captionBaseFrame(editor, options.assetId);

  return editor.transaction(cues.length === 1 ? 'Add caption' : `Add ${cues.length} captions`, (): AppliedCaptions => {
    const trackId = editor.addTrack('video');
    let placed = 0;

    for (const cue of cues) {
      const text = sanitizeTitleText(cue.text);
      if (!text) continue;
      const { startFrame, durationFrames } = placeCaptionCue(base, cue, fps);
      // addTitleClip re-validates; count only what it actually created, so the
      // reported total can never claim a clip that is not on the timeline.
      if (editor.addTitleClip({ trackId, text, startFrame, durationFrames })) placed += 1;
    }

    return { trackId, count: placed };
  });
}
