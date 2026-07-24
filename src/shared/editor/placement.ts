import type { MediaAsset, TrackType } from '../types/project';

export function hasEmbeddedAudio(asset: MediaAsset): boolean {
  return asset.type === 'video'
    && Boolean(asset.audioCodec || asset.channels || asset.sampleRate);
}

export function isMediaCompatibleWithTrack(
  mediaType: MediaAsset['type'],
  trackType: TrackType,
): boolean {
  if (trackType === 'audio') return mediaType === 'audio';
  return mediaType === 'video' || mediaType === 'image';
}

export function placementDuration(asset: MediaAsset, projectFps: number): number {
  if (asset.duration > 0) return asset.duration;
  return Math.max(1, Math.round(projectFps * 5));
}
