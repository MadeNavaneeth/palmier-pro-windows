/**
 * Regression coverage for the manage_media_folders agent tool (#156 slice):
 * per-action argument requirements, precise validation/domain errors surfaced
 * to the model, no-op receipts, one undo step per mutating call, and the
 * delete-never-deletes-media contract pinned at the tool boundary.
 */

import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';
import { createEmptyProject, type MediaAsset, type Project } from '../../shared/types/project';

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

/** a1, a2 in folder f1 (B-roll); a3 at the root. */
function baseProject(): Project {
  const project = createEmptyProject();
  project.media = [
    asset('a1', { folderId: 'f1' }),
    asset('a2', { folderId: 'f1' }),
    asset('a3'),
  ];
  project.mediaFolders = [{ id: 'f1', name: 'B-roll' }];
  return project;
}

function executorWithFolders() {
  const editor = new EditorController(baseProject());
  const executor = new ToolExecutor(editor);
  return { editor, executor };
}

describe('manage_media_folders tool (#156 slice)', () => {
  it('lists folders with asset counts plus the root count', async () => {
    const { executor } = executorWithFolders();
    const result = await executor.execute('manage_media_folders', { action: 'list' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      folders: [{ id: 'f1', name: 'B-roll', assetCount: 2 }],
      rootAssetCount: 1,
    });
  });

  it('creates a folder, reports it, and it appears in list', async () => {
    const { editor, executor } = executorWithFolders();
    const created = await executor.execute('manage_media_folders', {
      action: 'create',
      name: 'Music',
    });
    expect(created.success).toBe(true);
    const folder = (created.data as { folder: { id: string; name: string } }).folder;
    expect(folder.name).toBe('Music');

    const list = await executor.execute('manage_media_folders', { action: 'list' });
    expect((list.data as { folders: Array<{ name: string }> }).folders)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Music' })]));

    // One undoable step, reversible from the UI's undo.
    expect(editor.undo()).toBe(true);
    expect(editor.getMediaFolders().map((f) => f.name)).toEqual(['B-roll']);
  });

  it('requires action-specific arguments', async () => {
    const { executor } = executorWithFolders();
    expect((await executor.execute('manage_media_folders', { action: 'create' })).success)
      .toBe(false);
    expect((await executor.execute('manage_media_folders', { action: 'rename' })).success)
      .toBe(false);
    expect((await executor.execute('manage_media_folders', { action: 'rename', folderId: 'f1' }))
      .success).toBe(false);
    expect((await executor.execute('manage_media_folders', { action: 'delete' })).success)
      .toBe(false);
    expect((await executor.execute('manage_media_folders', { action: 'move_assets' })).success)
      .toBe(false);
    // Schema boundary: unknown action, empty assetIds, empty name.
    expect((await executor.execute('manage_media_folders', { action: 'nuke' })).success)
      .toBe(false);
    expect((await executor.execute('manage_media_folders', {
      action: 'move_assets',
      assetIds: [],
    })).success).toBe(false);
  });

  it('surfaces domain validation failures with the domain message', async () => {
    const { executor } = executorWithFolders();
    const dup = await executor.execute('manage_media_folders', {
      action: 'create',
      name: 'b-roll',
    });
    expect(dup.success).toBe(false);
    expect((dup as { error?: string }).error).toMatch(/already exists/);

    const blank = await executor.execute('manage_media_folders', {
      action: 'create',
      name: '   ',
    });
    expect(blank.success).toBe(false);
    expect((blank as { error?: string }).error).toMatch(/name is required/i);

    const ghostRename = await executor.execute('manage_media_folders', {
      action: 'rename',
      folderId: 'ghost',
      name: 'X',
    });
    expect(ghostRename.success).toBe(false);
    expect((ghostRename as { error?: string }).error).toMatch(/folder not found/i);

    const ghostMove = await executor.execute('manage_media_folders', {
      action: 'move_assets',
      assetIds: ['a1'],
      folderId: 'ghost',
    });
    expect(ghostMove.success).toBe(false);
    expect((ghostMove as { error?: string }).error).toMatch(/folder not found/i);

    const ghostAsset = await executor.execute('manage_media_folders', {
      action: 'move_assets',
      assetIds: ['nope'],
      folderId: 'f1',
    });
    expect(ghostAsset.success).toBe(false);
    expect((ghostAsset as { error?: string }).error).toMatch(/media not found/i);
  });

  it('renames and reports a no-op rename without pushing history', async () => {
    const { editor, executor } = executorWithFolders();

    const renamed = await executor.execute('manage_media_folders', {
      action: 'rename',
      folderId: 'f1',
      name: 'Sunset',
    });
    expect(renamed.success).toBe(true);
    expect((renamed.data as { folder: { name: string } }).folder.name).toBe('Sunset');
    expect(editor.undo()).toBe(true);
    expect(editor.getMediaFolders()[0].name).toBe('B-roll');

    const noOp = await executor.execute('manage_media_folders', {
      action: 'rename',
      folderId: 'f1',
      name: 'b-roll',
    });
    expect(noOp.success).toBe(true);
    expect(noOp.data).toEqual({ noOp: true });
    expect(editor.canUndo()).toBe(false);
  });

  it('deletes a folder: assets move to the root and never disappear', async () => {
    const { editor, executor } = executorWithFolders();
    const deleted = await executor.execute('manage_media_folders', {
      action: 'delete',
      folderId: 'f1',
    });
    expect(deleted.success).toBe(true);
    expect(deleted.data).toEqual({ deletedFolderId: 'f1', movedAssetIds: ['a1', 'a2'] });

    expect(editor.getMedia().map((m) => m.id)).toEqual(['a1', 'a2', 'a3']);
    expect(editor.getMedia().every((m) => m.folderId === undefined)).toBe(true);
    expect(editor.getMediaFolders()).toEqual([]);

    expect(editor.undo()).toBe(true);
    expect(editor.getMediaFolders()).toEqual([{ id: 'f1', name: 'B-roll' }]);
    expect(editor.getMedia()[0].folderId).toBe('f1');
  });

  it('moves assets and reports a no-op move without pushing history', async () => {
    const { editor, executor } = executorWithFolders();
    const moved = await executor.execute('manage_media_folders', {
      action: 'move_assets',
      assetIds: ['a3'],
      folderId: 'f1',
    });
    expect(moved.success).toBe(true);
    expect(moved.data).toEqual({ movedAssetIds: ['a3'], folderId: 'f1' });
    expect(editor.undo()).toBe(true);
    expect(editor.getMedia()[2].folderId).toBeUndefined();

    const noOp = await executor.execute('manage_media_folders', {
      action: 'move_assets',
      assetIds: ['a1'],
      folderId: 'f1',
    });
    expect(noOp.success).toBe(true);
    expect(noOp.data).toEqual({ noOp: true });
    expect(editor.canUndo()).toBe(false);
  });

  it('moves assets to the root when folderId is omitted', async () => {
    const { editor, executor } = executorWithFolders();
    const moved = await executor.execute('manage_media_folders', {
      action: 'move_assets',
      assetIds: ['a1', 'a2'],
    });
    expect(moved.success).toBe(true);
    expect(moved.data).toEqual({ movedAssetIds: ['a1', 'a2'], folderId: null });
    expect(editor.getMedia()[0].folderId).toBeUndefined();
    expect(editor.getMedia()[1].folderId).toBeUndefined();
  });
});
