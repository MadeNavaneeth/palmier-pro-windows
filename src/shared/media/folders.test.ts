/**
 * Media-library folders (upstream issue #156 slice): name sanitization,
 * load-time narrowing of hostile/hand-edited projects (the migration path —
 * every .vproj load runs through narrowMediaFolders), and membership counts.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyProject, type MediaAsset, type MediaFolder, type Project } from '../types/project';
import {
  MEDIA_FOLDER_NAME_MAX_LENGTH,
  filterLibraryAssets,
  folderAssetCount,
  folderNamesMatch,
  narrowMediaFolders,
  sanitizeFolderName,
  uniqueFolderName,
} from './folders';

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

function projectWith(overrides: Partial<Project>): Project {
  return { ...createEmptyProject(), ...overrides };
}

describe('sanitizeFolderName', () => {
  it('passes a plain name through', () => {
    expect(sanitizeFolderName('B-roll')).toBe('B-roll');
  });

  it('strips control characters and collapses whitespace runs', () => {
    expect(sanitizeFolderName('  Hero\u0000shots\n\nof\t the  sunset  ')).toBe(
      'Hero shots of the sunset',
    );
  });

  it('caps length at 60 chars and trims again after the cut', () => {
    const out = sanitizeFolderName(`${'x'.repeat(MEDIA_FOLDER_NAME_MAX_LENGTH + 40)}  `)!;
    expect(out).toHaveLength(MEDIA_FOLDER_NAME_MAX_LENGTH);
  });

  it('rejects blank input and non-strings', () => {
    expect(sanitizeFolderName('')).toBeNull();
    expect(sanitizeFolderName('   \t ')).toBeNull();
    expect(sanitizeFolderName('\u0000\u0001')).toBeNull();
    expect(sanitizeFolderName(null)).toBeNull();
    expect(sanitizeFolderName(undefined)).toBeNull();
    expect(sanitizeFolderName(42)).toBeNull();
    expect(sanitizeFolderName({ name: 'x' })).toBeNull();
  });
});

describe('folderNamesMatch', () => {
  it('matches case-insensitively', () => {
    expect(folderNamesMatch('B-roll', 'b-roll')).toBe(true);
    expect(folderNamesMatch('B-roll', 'B-Roll')).toBe(true);
  });

  it('distinguishes different names', () => {
    expect(folderNamesMatch('B-roll', 'Bloop')).toBe(false);
  });
});

describe('uniqueFolderName', () => {
  it('returns the sanitized base when nothing collides', () => {
    expect(uniqueFolderName('B-roll', ['Music'])).toBe('B-roll');
  });

  it('appends a counter until the name is free (case-insensitively)', () => {
    expect(uniqueFolderName('B-roll', ['B-roll'])).toBe('B-roll 2');
    expect(uniqueFolderName('B-roll', ['B-roll', 'b-roll 2'])).toBe('B-roll 3');
  });

  it('falls back to "Folder" for unusable bases', () => {
    expect(uniqueFolderName('   ', [])).toBe('Folder');
  });
});

describe('narrowMediaFolders (load-time migration)', () => {
  it('returns the same reference for a clean project', () => {
    const project = projectWith({
      mediaFolders: [{ id: 'f1', name: 'B-roll' }],
      media: [asset('a1', { folderId: 'f1' }), asset('a2')],
    });
    expect(narrowMediaFolders(project)).toBe(project);
  });

  it('returns the same reference for a pre-folders project', () => {
    const project = projectWith({ media: [asset('a1')] });
    expect(project.mediaFolders).toBeUndefined();
    expect(narrowMediaFolders(project)).toBe(project);
  });

  it('degrades a null mediaFolders to an empty list instead of throwing', () => {
    const project = projectWith({ media: [asset('a1')] });
    (project as { mediaFolders: unknown }).mediaFolders = null;
    const narrowed = narrowMediaFolders(project);
    expect(narrowed.mediaFolders).toEqual([]);
  });

  it('degrades non-array garbage (string, number, object) to an empty list', () => {
    for (const garbage of ['', 'not-an-array', 7, { f1: { name: 'x' } }] as unknown[]) {
      const project = projectWith({ media: [asset('a1')] });
      (project as { mediaFolders: unknown }).mediaFolders = garbage;
      expect(narrowMediaFolders(project).mediaFolders).toEqual([]);
    }
  });

  it('drops non-object, invalid-id, and blank-name entries', () => {
    const project = projectWith({
      media: [asset('a1')],
      mediaFolders: [
        null,
        42,
        'nope',
        { id: '', name: 'empty-id' },
        { id: 42, name: 'numeric-id' },
        { id: 'f-blank', name: '   ' },
        { id: 'f-ok', name: ' Keep me ' },
      ] as unknown as MediaFolder[],
    });
    const narrowed = narrowMediaFolders(project);
    expect(narrowed.mediaFolders).toEqual([{ id: 'f-ok', name: 'Keep me' }]);
  });

  it('keeps the first occurrence of a duplicate id', () => {
    const project = projectWith({
      media: [],
      mediaFolders: [
        { id: 'f1', name: 'First' },
        { id: 'f1', name: 'Second' },
        { id: 'f2', name: 'Other' },
      ],
    });
    expect(narrowMediaFolders(project).mediaFolders).toEqual([
      { id: 'f1', name: 'First' },
      { id: 'f2', name: 'Other' },
    ]);
  });

  it('sanitizes stored names (control chars, overlong) on load', () => {
    const project = projectWith({
      media: [],
      mediaFolders: [
        { id: 'f1', name: 'Bad\u0000name' },
        { id: 'f2', name: 'y'.repeat(MEDIA_FOLDER_NAME_MAX_LENGTH + 25) },
      ],
    });
    const folders = narrowMediaFolders(project).mediaFolders!;
    expect(folders[0].name).toBe('Bad name');
    expect(folders[1].name).toHaveLength(MEDIA_FOLDER_NAME_MAX_LENGTH);
  });

  it('clears dangling folderIds to root while keeping valid ones', () => {
    const project = projectWith({
      mediaFolders: [{ id: 'f1', name: 'B-roll' }],
      media: [
        asset('a1', { folderId: 'f1' }),
        asset('a2', { folderId: 'ghost' }),
        asset('a3'),
      ],
    });
    const narrowed = narrowMediaFolders(project);
    expect(narrowed.media[0].folderId).toBe('f1');
    expect(narrowed.media[1].folderId).toBeUndefined();
    expect(narrowed.media[2].folderId).toBeUndefined();
  });

  it('clears dangling folderIds even when mediaFolders is absent, without introducing the key', () => {
    const project = projectWith({ media: [asset('a1', { folderId: 'ghost' })] });
    const narrowed = narrowMediaFolders(project);
    expect(narrowed.media[0].folderId).toBeUndefined();
    expect('mediaFolders' in narrowed).toBe(false);
  });

  it('survives a JSON round-trip of a hostile document', () => {
    const hostile = JSON.parse(
      '{"version":2,"name":"Evil","media":[{"id":"a1","path":"C:\\\\a.mp4","filename":"a.mp4",'
      + '"type":"video","duration":10,"fileSize":1,"addedAt":"2026-01-01T00:00:00.000Z","folderId":"gone"}],'
      + '"mediaFolders":null,"settings":{"fps":30,"width":1920,"height":1080},'
      + '"timeline":{"tracks":[],"clips":[],"playheadFrame":0},"createdAt":"2026-01-01T00:00:00.000Z",'
      + '"updatedAt":"2026-01-01T00:00:00.000Z"}',
    ) as Project;
    const narrowed = narrowMediaFolders(hostile);
    expect(narrowed.mediaFolders).toEqual([]);
    expect(narrowed.media[0].folderId).toBeUndefined();
  });
});

describe('folderAssetCount', () => {
  it('counts members per folder and root assets for undefined', () => {
    const project = projectWith({
      mediaFolders: [
        { id: 'f1', name: 'B-roll' },
        { id: 'f2', name: 'Music' },
      ],
      media: [
        asset('a1', { folderId: 'f1' }),
        asset('a2', { folderId: 'f1' }),
        asset('a3', { folderId: 'f2' }),
        asset('a4'),
      ],
    });
    expect(folderAssetCount(project, 'f1')).toBe(2);
    expect(folderAssetCount(project, 'f2')).toBe(1);
    expect(folderAssetCount(project, 'ghost')).toBe(0);
    expect(folderAssetCount(project, undefined)).toBe(1);
  });
});

describe('filterLibraryAssets (bin folder layer)', () => {
  const media = [
    asset('loose-root'),
    asset('interview-a', { folderId: 'f1' }),
    asset('broll-b', { folderId: 'f2' }),
  ];

  it('scopes to the active folder when there is no query', () => {
    expect(filterLibraryAssets(media, '', null).map((a) => a.id)).toEqual(['loose-root']);
    expect(filterLibraryAssets(media, '', 'f1').map((a) => a.id)).toEqual(['interview-a']);
  });

  it('returns nothing for an empty or unknown folder', () => {
    expect(filterLibraryAssets(media, '', 'ghost')).toEqual([]);
    expect(filterLibraryAssets([], '', null)).toEqual([]);
  });

  it('searches globally across folders, ignoring the active folder', () => {
    // A root asset matches while a folder is active, and a folder asset
    // matches while root is active: search is never folder-scoped.
    expect(filterLibraryAssets(media, 'loose', 'f1').map((a) => a.id)).toEqual(['loose-root']);
    expect(filterLibraryAssets(media, 'interview', null).map((a) => a.id)).toEqual(['interview-a']);
    expect(filterLibraryAssets(media, 'broll', 'f1').map((a) => a.id)).toEqual(['broll-b']);
  });

  it('scopes on the empty string only — the caller trims, so raw spaces are just a non-matching needle', () => {
    expect(filterLibraryAssets(media, '', 'f1').map((a) => a.id)).toEqual(['interview-a']);
    expect(filterLibraryAssets(media, '   ', 'f1')).toEqual([]);
  });
});
