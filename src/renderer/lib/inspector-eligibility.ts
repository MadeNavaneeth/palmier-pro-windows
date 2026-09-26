import type { ClipType } from '../../shared/types/project';

/**
 * Whether the Inspector's decoded-media adjustment controls are meaningful.
 *
 * Preview and export apply grade, effects, chroma, and edge stages to decoded
 * video/image frames. Title, shape, and compound clips use separate render
 * paths (and audio has no visual frame), so showing those controls would be a
 * silent no-op. Generated clips still use the decoded-media path and remain
 * eligible here; the Agent's narrower rule is a separate concern.
 */
export function supportsMediaAdjustmentControls(type: ClipType): boolean {
  return type === 'video' || type === 'image' || type === 'generated';
}
