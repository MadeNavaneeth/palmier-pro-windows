/**
 * Regression coverage for offline-media relink (upstream
 * EditorViewModel+Relink): kind validation from the new path's extension,
 * one undoable step per relink, unknown-id refusals, and the detach-audio
 * predicate used by the clip context menu.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { fileKindOf } from '../media/file-kind';

describe('fileKindOf', () => {
  it('classifies supported extensions case-insensitively', () => {
    expect(fileKindOf('C:/m/clip.MP4')).toBe('video');
    expect(fileKindOf('C:/m/song.FlAc')).toBe('audio');
    expect(fileKindOf('C:/m/still.PNG')).toBe('image');
    expect(fileKindOf('C:/m/noext')).toBeNull();
    expect(fileKindOf('C:/m/x.docx')).toBeNull();
  });
});

function controllerWithMedia() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'asset-v',
    path: 'E:/old-drive/interview.mp4',
    filename: 'interview.mp4',
    type: 'video',
    duration: 500,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  return ctrl;
}

describe('relinkAsset (offline media)', () => {
  it('repoints the asset path as one undoable step', () => {
    const ctrl = controllerWithMedia();
    expect(ctrl.relinkAsset('asset-v', 'D:/footage/2026/interview.mp4')).toBe(true);
    expect(ctrl.getMedia()[0].path).toBe('D:/footage/2026/interview.mp4');

    ctrl.undo();
    expect(ctrl.getMedia()[0].path).toBe('E:/old-drive/interview.mp4');
    ctrl.redo();
    expect(ctrl.getMedia()[0].path).toBe('D:/footage/2026/interview.mp4');
  });

  it('refuses kind mismatches and unsupported files by message', () => {
    const ctrl = controllerWithMedia();
    expect(() => ctrl.relinkAsset('asset-v', 'D:/music/wrong.mp3'))
      .toThrow(/requires video media/i);
    expect(() => ctrl.relinkAsset('asset-v', 'D:/docs/readme.txt'))
      .toThrow(/unsupported file type/i);
    // Nothing changed after refusals.
    expect(ctrl.getMedia()[0].path).toBe('E:/old-drive/interview.mp4');
  });

  it('refuses unknown asset ids', () => {
    const ctrl = controllerWithMedia();
    expect(() => ctrl.relinkAsset('ghost', 'D:/x/interview.mp4')).toThrow(/no media asset/i);
  });

  it('keeps every other asset field intact', () => {
    const ctrl = controllerWithMedia();
    ctrl.relinkAsset('asset-v', 'D:/new/interview.mp4');
    const asset = ctrl.getMedia()[0];
    expect(asset.filename).toBe('interview.mp4');
    expect(asset.duration).toBe(500);
    expect(asset.type).toBe('video');
  });
});

describe('canDetachAudio (#462 surface)', () => {
  it('is true only while a link group has another member', () => {
    const ctrl = controllerWithMedia();
    ctrl.addMedia({
      id: 'asset-av',
      path: '/test/av.mp4',
      filename: 'av.mp4',
      type: 'video',
      duration: 1000,
      fileSize: 1,
      audioCodec: 'aac',
      addedAt: new Date().toISOString(),
    });
    ctrl.placeMediaAssets(['asset-av'], 'v1', 0);
    const videoId = ctrl.getClips().find((c) => c.type === 'video')!.id;

    expect(ctrl.canDetachAudio(videoId)).toBe(true);
    ctrl.unlinkClips([videoId]);
    expect(ctrl.canDetachAudio(videoId)).toBe(false);
  });
});
