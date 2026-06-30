/**
 * Drag-and-drop helpers for dragging media assets from the bin onto the
 * timeline. Uses a custom MIME type plus a module-level record of the asset
 * currently being dragged — the latter lets drop targets know the asset TYPE
 * during `dragover` (where `dataTransfer.getData` is intentionally blocked by
 * the browser for security), so they can show a valid/invalid drop affordance.
 */

import type { MediaAsset } from '../../shared/types/project';

export const ASSET_DND_MIME = 'application/x-palmier-asset';

export interface DraggingAsset {
  id: string;
  type: MediaAsset['type'];
}

let dragging: DraggingAsset | null = null;

export function setDraggingAsset(asset: DraggingAsset | null): void {
  dragging = asset;
}

export function getDraggingAsset(): DraggingAsset | null {
  return dragging;
}

/**
 * Which asset types may land on which track type.
 * Audio tracks take audio only; video tracks take visual media.
 */
export function isAssetCompatibleWithTrack(
  assetType: MediaAsset['type'],
  trackType: 'video' | 'audio',
): boolean {
  if (trackType === 'audio') return assetType === 'audio';
  return assetType === 'video' || assetType === 'image';
}
