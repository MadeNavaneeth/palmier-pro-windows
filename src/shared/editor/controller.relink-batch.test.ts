/**
 * Regression coverage for batch offline relink (upstream
 * EditorViewModel+Relink's folder flow): kind validation for every entry
 * before anything commits, and ONE undoable step for the whole mapping.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function controllerWithTwoOffline() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'asset-1', path: 'E:/old/a.mp4', filename: 'a.mp4', type: 'video',
    duration: 100, fileSize: 1, addedAt: new Date().toISOString(),
  });
  ctrl.addMedia({
    id: 'asset-2', path: 'E:/old/b.mp3', filename: 'b.mp3', type: 'audio',
    duration: 100, fileSize: 1, addedAt: new Date().toISOString(),
  });
  return ctrl;
}

describe('relinkAssetsBatch (folder-scan flow)', () => {
  it('relinks every entry in one undoable step', () => {
    const ctrl = controllerWithTwoOffline();
    const receipt = ctrl.relinkAssetsBatch({
      'asset-1': 'D:/new/a.mp4',
      'asset-2': 'D:/new/b.mp3',
    });
    expect(receipt.relinkedAssetIds.sort()).toEqual(['asset-1', 'asset-2']);
    expect(ctrl.getMedia().map((a) => a.path)).toEqual(['D:/new/a.mp4', 'D:/new/b.mp3']);

    ctrl.undo();
    expect(ctrl.getMedia().every((a) => a.path.startsWith('E:/old/'))).toBe(true);
  });

  it('refuses the whole mapping on any kind mismatch', () => {
    const ctrl = controllerWithTwoOffline();
    expect(() => ctrl.relinkAssetsBatch({
      'asset-1': 'D:/new/a.mp4',
      'asset-2': 'D:/new/wrong.mp4',
    })).toThrow(/requires audio media/i);
    // Nothing committed.
    expect(ctrl.getMedia()[0].path).toBe('E:/old/a.mp4');
  });

  it('returns empty for an empty mapping', () => {
    const ctrl = controllerWithTwoOffline();
    expect(ctrl.relinkAssetsBatch({}).relinkedAssetIds).toEqual([]);
  });
});
