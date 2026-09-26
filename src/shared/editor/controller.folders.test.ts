/**
 * Media-library folders (upstream issue #156 slice) on EditorController:
 * one undo step per operation, no-op and refused calls add no history, and
 * deleting a folder NEVER deletes media — member assets move to the library
 * root (deliberate divergence from upstream's cascade-delete in
 * EditorViewModel+Folders.deleteFolders).
 */

import { describe, expect, it } from 'vitest';
import { EditorController } from './controller';
import { createEmptyProject, type MediaAsset, type Project } from '../types/project';

function asset(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    path: `C:\\media\\${id}.mp4`,
    filename: `${id}.mp4`,
    type: 'video',
    duration: 1000,
    fileSize: 1,
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** a1, a2 in folder f1; a3 at the root; folders f1 (B-roll) and f2 (Music). */
function baseProject(): Project {
  const project = createEmptyProject();
  project.media = [
    asset('a1', { folderId: 'f1' }),
    asset('a2', { folderId: 'f1' }),
    asset('a3'),
  ];
  project.mediaFolders = [
    { id: 'f1', name: 'B-roll' },
    { id: 'f2', name: 'Music' },
  ];
  return project;
}

function freshController(): EditorController {
  return new EditorController(baseProject());
}

describe('createMediaFolder', () => {
  it('creates a sanitized folder as one undo step', () => {
    const ctrl = new EditorController();
    expect(ctrl.canUndo()).toBe(false);

    const folder = ctrl.createMediaFolder('  Sunset rides  ');
    expect(folder.name).toBe('Sunset rides');
    expect(folder.id).toBeTruthy();
    expect(ctrl.getMediaFolders()).toEqual([folder]);
    expect(ctrl.canUndo()).toBe(true);

    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getMediaFolders()).toEqual([]);
    expect(ctrl.canUndo()).toBe(false);
  });

  it('refuses invalid and duplicate names without adding history', () => {
    const ctrl = new EditorController();
    ctrl.createMediaFolder('B-roll');

    expect(() => ctrl.createMediaFolder('   ')).toThrow(/Folder name is required/);
    expect(() => ctrl.createMediaFolder('b-roll')).toThrow(/already exists/);
    expect(() => ctrl.createMediaFolder(null as unknown as string)).toThrow(/Folder name is required/);
    expect(ctrl.getMediaFolders()).toHaveLength(1);

    // Exactly one history entry: the refusal attempts added nothing.
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getMediaFolders()).toEqual([]);
    expect(ctrl.canUndo()).toBe(false);
  });
});

describe('renameMediaFolder', () => {
  it('renames as one undo step', () => {
    const ctrl = freshController();
    const renamed = ctrl.renameMediaFolder('f1', 'Sunset');
    expect(renamed).toEqual({ id: 'f1', name: 'Sunset' });
    expect(ctrl.canUndo()).toBe(true);

    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getMediaFolders().find((f) => f.id === 'f1')?.name).toBe('B-roll');
    expect(ctrl.canUndo()).toBe(false);
  });

  it('treats an identical (case-insensitive) name as a no-op with no history', () => {
    const ctrl = freshController();
    expect(ctrl.renameMediaFolder('f1', 'B-roll')).toEqual({ id: 'f1', name: 'B-roll' });
    expect(ctrl.renameMediaFolder('f1', 'b-roll')).toEqual({ id: 'f1', name: 'B-roll' });
    expect(ctrl.canUndo()).toBe(false);
  });

  it('refuses unknown folders, blank names, and duplicate names', () => {
    const ctrl = freshController();
    expect(() => ctrl.renameMediaFolder('ghost', 'X')).toThrow(/Folder not found/);
    expect(() => ctrl.renameMediaFolder('f1', '  ')).toThrow(/Folder name is required/);
    expect(() => ctrl.renameMediaFolder('f1', 'MUSIC')).toThrow(/already exists/);
    expect(ctrl.getMediaFolders().find((f) => f.id === 'f1')?.name).toBe('B-roll');
    expect(ctrl.canUndo()).toBe(false);
  });
});

describe('deleteMediaFolder', () => {
  it('moves member assets to the root and NEVER deletes media or clips', () => {
    const ctrl = freshController();
    const clipId = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0 });

    const receipt = ctrl.deleteMediaFolder('f1');
    expect(receipt).toEqual({ deletedFolderId: 'f1', movedAssetIds: ['a1', 'a2'] });

    // Every asset survives, in the same order, just re-parented to root.
    const media = ctrl.getMedia();
    expect(media.map((m) => m.id)).toEqual(['a1', 'a2', 'a3']);
    expect(media[0].folderId).toBeUndefined();
    expect(media[1].folderId).toBeUndefined();
    expect(media[2].folderId).toBeUndefined();
    // Untouched folders keep their members.
    expect(ctrl.getMediaFolders().map((f) => f.id)).toEqual(['f2']);
    // Clips referencing folder members are untouched.
    expect(ctrl.getClips().find((c) => c.id === clipId)).toBeDefined();
  });

  it('restores the folder and memberships on a single undo', () => {
    const ctrl = freshController();
    ctrl.deleteMediaFolder('f1');
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getMediaFolders().map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(ctrl.getMedia()[0].folderId).toBe('f1');
    expect(ctrl.getMedia()[1].folderId).toBe('f1');
    expect(ctrl.canUndo()).toBe(false);
  });

  it('deletes an empty folder without touching media', () => {
    const ctrl = freshController();
    const before = ctrl.getProject().media;
    const receipt = ctrl.deleteMediaFolder('f2');
    expect(receipt).toEqual({ deletedFolderId: 'f2', movedAssetIds: [] });
    expect(ctrl.getProject().media).toEqual(before);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getMediaFolders().map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(ctrl.canUndo()).toBe(false);
  });

  it('refuses an unknown folder id', () => {
    const ctrl = freshController();
    expect(() => ctrl.deleteMediaFolder('ghost')).toThrow(/Folder not found/);
    expect(ctrl.getMediaFolders()).toHaveLength(2);
    expect(ctrl.canUndo()).toBe(false);
  });

  it('keeps asset ids and order stable so grid selection stays valid', () => {
    const ctrl = freshController();
    const selected = ['a1', 'a2'];
    ctrl.deleteMediaFolder('f1');

    // The media panel prunes selection against the visible id order; neither
    // changes when a folder disappears.
    const visibleIds = ctrl.getMedia().map((m) => m.id);
    expect(visibleIds).toEqual(['a1', 'a2', 'a3']);
    expect(selected.filter((id) => visibleIds.includes(id))).toEqual(selected);
  });
});

describe('moveAssetsToFolder', () => {
  it('moves assets as one undo step', () => {
    const ctrl = freshController();
    const receipt = ctrl.moveAssetsToFolder(['a3'], 'f1');
    expect(receipt).toEqual({ movedAssetIds: ['a3'], folderId: 'f1' });
    expect(ctrl.getMedia()[2].folderId).toBe('f1');
    expect(ctrl.canUndo()).toBe(true);

    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getMedia()[2].folderId).toBeUndefined();
    expect(ctrl.canUndo()).toBe(false);
  });

  it('a request that changes nothing adds no history', () => {
    const ctrl = freshController();
    expect(ctrl.moveAssetsToFolder(['a1', 'a2'], 'f1'))
      .toEqual({ movedAssetIds: [], folderId: 'f1' });
    expect(ctrl.moveAssetsToFolder([], 'f1'))
      .toEqual({ movedAssetIds: [], folderId: 'f1' });
    expect(ctrl.canUndo()).toBe(false);
  });

  it('moves only the assets that need changing', () => {
    const ctrl = freshController();
    const receipt = ctrl.moveAssetsToFolder(['a1', 'a3'], 'f1');
    expect(receipt.movedAssetIds).toEqual(['a3']);
    expect(ctrl.canUndo()).toBe(true);
  });

  it('moves to the library root with folderId null, clearing the field', () => {
    const ctrl = freshController();
    const receipt = ctrl.moveAssetsToFolder(['a1'], null);
    expect(receipt).toEqual({ movedAssetIds: ['a1'], folderId: null });
    expect(ctrl.getMedia()[0].folderId).toBeUndefined();
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getMedia()[0].folderId).toBe('f1');
    expect(ctrl.canUndo()).toBe(false);
  });

  it('refuses unknown folders and unknown asset ids without history', () => {
    const ctrl = freshController();
    expect(() => ctrl.moveAssetsToFolder(['a1'], 'ghost')).toThrow(/Folder not found/);
    expect(() => ctrl.moveAssetsToFolder(['ghost'], 'f1')).toThrow(/Media not found/);
    expect(ctrl.getMedia()[0].folderId).toBe('f1');
    expect(ctrl.canUndo()).toBe(false);
  });
});

describe('folder load narrowing (hostile projects)', () => {
  it('degrades null mediaFolders and dangling folderIds on construction', () => {
    const hostile = baseProject();
    (hostile as { mediaFolders: unknown }).mediaFolders = null;
    hostile.media[0] = asset('a1', { folderId: 'ghost' });

    const ctrl = new EditorController(hostile);
    expect(ctrl.getMediaFolders()).toEqual([]);
    expect(ctrl.getMedia()[0].folderId).toBeUndefined();
  });

  it('degrades a hostile document loaded through loadProject', () => {
    const hostile = JSON.parse(
      '{"version":2,"name":"Evil","media":[{"id":"a1","path":"C:\\\\a.mp4","filename":"a.mp4",'
      + '"type":"video","duration":10,"fileSize":1,"addedAt":"2026-01-01T00:00:00.000Z","folderId":"gone"}],'
      + '"mediaFolders":[{"id":"","name":"bad"},{"id":"ok","name":"   "}],'
      + '"settings":{"fps":30,"width":1920,"height":1080},'
      + '"timeline":{"tracks":[],"clips":[],"playheadFrame":0},'
      + '"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
    ) as Project;

    const ctrl = new EditorController();
    ctrl.loadProject(hostile);
    expect(ctrl.getMediaFolders()).toEqual([]);
    expect(ctrl.getMedia()[0].folderId).toBeUndefined();
    expect(ctrl.canUndo()).toBe(false);
  });
});
