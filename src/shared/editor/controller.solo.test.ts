/**
 * Track solo (upstream PR #428): solo is UI-only derived state that never
 * creates an undo entry, never persists to the project file, and never
 * mutates `visible` or `locked`.
 *
 * When any track is soloed, only soloed tracks are active for preview,
 * export, and audio playback.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function project() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'av', path: '/v.mp4', filename: 'v.mp4', type: 'video',
    duration: 1000, fileSize: 1, audioCodec: 'aac', addedAt: new Date().toISOString(),
  });
  ctrl.addMedia({
    id: 'music', path: '/m.mp3', filename: 'm.mp3', type: 'audio',
    duration: 800, fileSize: 1, addedAt: new Date().toISOString(),
  });
  ctrl.addTrack('video', 'V2');
  ctrl.addTrack('audio', 'A2');
  ctrl.placeMediaAssets(['av'], 'v1', 0);
  ctrl.addClip({ assetId: 'music', trackId: 'a1', startFrame: 0, durationFrames: 200 });
  return ctrl;
}

describe('track solo (upstream PR #428)', () => {
  it('toggleTrackSolo toggles the soloed flag', () => {
    const ctrl = project();
    const tracks = ctrl.getTracks();
    expect(tracks[0].soloed).toBeFalsy();

    ctrl.toggleTrackSolo(tracks[0].id);
    expect(ctrl.getTracks()[0].soloed).toBe(true);

    ctrl.toggleTrackSolo(tracks[0].id);
    expect(ctrl.getTracks()[0].soloed).toBe(false);
  });

  it('solo is a no-op for a missing track id', () => {
    const ctrl = project();
    ctrl.toggleTrackSolo('nonexistent');
  });

  it('solo does NOT create an undo entry', () => {
    const ctrl = project();
    // project() setup creates undo entries; solo should not add another
    const before = ctrl.canUndo();
    ctrl.toggleTrackSolo(ctrl.getTracks()[0].id);
    expect(ctrl.canUndo()).toBe(before);
  });

  it('solo does NOT persist through serialization', () => {
    const ctrl = project();
    ctrl.toggleTrackSolo(ctrl.getTracks()[0].id);
    expect(ctrl.getTracks()[0].soloed).toBe(true);

    const json = ctrl.serialize();
    const restored = new EditorController(JSON.parse(json));
    // soloed is optional and must not survive serialization
    expect(restored.getTracks()[0].soloed).toBeFalsy();
  });

  it('activeTrackIds returns all visible tracks when none are soloed', () => {
    const ctrl = project();
    const active = ctrl.activeTrackIds();
    expect(active.size).toBe(ctrl.getTracks().length);
  });

  it('activeTrackIds returns only soloed tracks when any are soloed', () => {
    const ctrl = project();
    const tracks = ctrl.getTracks();
    ctrl.toggleTrackSolo(tracks[0].id);

    const active = ctrl.activeTrackIds();
    expect(active.size).toBe(1);
    expect(active.has(tracks[0].id)).toBe(true);
    expect(active.has(tracks[1].id)).toBe(false);
  });

  it('solo respects visible=false', () => {
    const ctrl = project();
    const tracks = ctrl.getTracks();
    ctrl.toggleTrackSolo(tracks[0].id);
    ctrl.setTrackVisible(tracks[0].id, false);

    const active = ctrl.activeTrackIds();
    expect(active.size).toBe(0);
  });

  it('clearing all solos restores all visible tracks as active', () => {
    const ctrl = project();
    const tracks = ctrl.getTracks();
    ctrl.toggleTrackSolo(tracks[0].id);
    expect(ctrl.activeTrackIds().size).toBe(1);

    ctrl.toggleTrackSolo(tracks[0].id);
    expect(ctrl.activeTrackIds().size).toBe(tracks.length);
  });

  it('multiple solos across tracks: all soloed tracks are active', () => {
    const ctrl = project();
    const tracks = ctrl.getTracks();
    ctrl.toggleTrackSolo(tracks[0].id);
    ctrl.toggleTrackSolo(tracks[2].id);

    const active = ctrl.activeTrackIds();
    expect(active.size).toBe(2);
    expect(active.has(tracks[0].id)).toBe(true);
    expect(active.has(tracks[2].id)).toBe(true);
  });
});
