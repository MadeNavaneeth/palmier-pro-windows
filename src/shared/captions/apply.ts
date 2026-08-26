/**
 * Materialize caption cues (#91 planner output) onto an editor controller
 * as title clips on ONE fresh video track. Shared by the agent executor and
 * the Captions-tab UI flow so both place identically.
 */

import type { EditorController } from '../editor/controller';
import type { CaptionCue } from './planner';

export interface AppliedCaptions {
  trackId: string;
  count: number;
}

export function applyCaptionCues(
  editor: EditorController,
  cues: readonly CaptionCue[],
): AppliedCaptions {
  const fps = editor.getProject().settings.fps;
  const trackId = editor.addTrack('video');
  let placed = 0;

  for (const cue of cues) {
    const startFrame = Math.max(0, Math.round(cue.startSec * fps));
    const durationFrames = Math.max(1, Math.round(cue.endSec * fps) - startFrame);
    editor.addTitleClip({
      trackId,
      text: cue.text,
      startFrame,
      durationFrames,
    });
    placed += 1;
  }

  return { trackId, count: placed };
}
