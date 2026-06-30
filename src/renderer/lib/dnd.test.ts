import { describe, it, expect } from 'vitest';
import {
  isAssetCompatibleWithTrack,
  setDraggingAsset,
  getDraggingAsset,
  ASSET_DND_MIME,
} from './dnd';

describe('media-bin drag-and-drop', () => {
  it('routes asset types to compatible tracks', () => {
    // Video tracks take visual media.
    expect(isAssetCompatibleWithTrack('video', 'video')).toBe(true);
    expect(isAssetCompatibleWithTrack('image', 'video')).toBe(true);
    expect(isAssetCompatibleWithTrack('audio', 'video')).toBe(false);
    // Audio tracks take audio only.
    expect(isAssetCompatibleWithTrack('audio', 'audio')).toBe(true);
    expect(isAssetCompatibleWithTrack('video', 'audio')).toBe(false);
    expect(isAssetCompatibleWithTrack('image', 'audio')).toBe(false);
  });

  it('tracks the asset currently being dragged', () => {
    expect(getDraggingAsset()).toBeNull();
    setDraggingAsset({ id: 'a1', type: 'video' });
    expect(getDraggingAsset()).toEqual({ id: 'a1', type: 'video' });
    setDraggingAsset(null);
    expect(getDraggingAsset()).toBeNull();
  });

  it('exposes a stable custom MIME type', () => {
    expect(ASSET_DND_MIME).toBe('application/x-palmier-asset');
  });
});
