/**
 * Regression coverage for import path expansion (upstream issue #453).
 *
 * A dropped folder used to be refused as "not a supported media file",
 * importing none of the media inside; several skipped files reported only
 * the first. These tests pin folder recursion with its bounds, readable
 * failures for folders that cannot be listed, and the single-shot notices.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  expandImportPaths,
  IMPORT_MAX_DEPTH,
  IMPORT_MAX_FILES,
  type ImportExpansionIo,
} from './import-expansion';

let root = '';

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-import-'));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function touch(...segments: string[]): Promise<string> {
  const full = path.join(root, ...segments);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, '');
  return full;
}

/** Fake io where every readdir fails — models an unreadable folder. */
const sealedIo: ImportExpansionIo = {
  stat: async (_filePath) => ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }),
  readdir: async () => {
    throw new Error('EACCES');
  },
};

describe('expandImportPaths', () => {
  it('expands a dropped folder to its supported media files only', async () => {
    await touch('bin', 'a.mp4', );
    await touch('bin', 'sub', 'b.wav');
    await touch('bin', 'notes.txt');
    await touch('bin', '.hidden');

    const { files, errors } = await expandImportPaths([path.join(root, 'bin')]);

    expect(errors).toEqual([]);
    expect(files.map((f) => path.basename(f)).sort()).toEqual(['a.mp4', 'b.wav']);
  });

  it('keeps reporting top-level unsupported drops by name', async () => {
    const stray = await touch('stray.txt');
    const media = await touch('clip.mp4');

    const { files, errors } = await expandImportPaths([stray, media]);

    expect(files).toEqual([media]);
    expect(errors).toEqual(['stray.txt is not a supported media file']);
  });

  it('reports a readable failure when a folder cannot be listed', async () => {
    const { files, errors } = await expandImportPaths([path.join(root, 'locked')], sealedIo);

    expect(files).toEqual([]);
    expect(errors).toEqual(['Could not read folder locked']);
  });

  it('stops at the depth ceiling exactly, once', async () => {
    // Nest folders IMPORT_MAX_DEPTH + 2 levels; only the first
    // IMPORT_MAX_DEPTH levels of media may survive.
    const segments = Array.from({ length: IMPORT_MAX_DEPTH + 2 }, (_, i) => `d${i}`);
    const tooDeep = await touch(...segments, 'deep.mp4');
    const shallowSegments = segments.slice(0, IMPORT_MAX_DEPTH);
    const atLimit = await touch(...shallowSegments, 'limit.mp4');

    const { files, errors } = await expandImportPaths([root]);

    expect(files).toContain(atLimit);
    expect(files).not.toContain(tooDeep);
    expect(errors.filter((e) => e.includes('deeper'))).toHaveLength(1);
  });

  it('caps expanded files and says so once, while explicit picks still import', async () => {
    const entries = Array.from({ length: IMPORT_MAX_FILES + 10 }, (_, i) => ({ name: `${String(i).padStart(4, '0')}.mp4`, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }));
    const explicitName = 'picked.mp4';
    const io: ImportExpansionIo = {
      stat: async (filePath) => ({
        isDirectory: () => !filePath.endsWith(explicitName),
        isFile: () => filePath.endsWith(explicitName),
        isSymbolicLink: () => false,
      }),
      readdir: async () => entries,
    };
    const explicit = path.join(root, explicitName);

    const { files, errors } = await expandImportPaths(
      [path.join(root, 'huge'), explicit],
      io,
    );

    expect(files).toHaveLength(IMPORT_MAX_FILES + 1); // cap + the explicit pick
    expect(files).toContain(explicit);
    expect(errors).toEqual([`Folder import stopped after ${IMPORT_MAX_FILES} files`]);
  });

  it('never follows links out of a walked folder', async () => {
    await touch('src', 'v.mp4');
    const io: ImportExpansionIo = {
      stat: async () => ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }),
      readdir: async () => [
        { name: 'link.mp4', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => true },
        { name: 'sub', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => true },
      ],
    };

    const { files } = await expandImportPaths([path.join(root, 'src')], io);

    expect(files).toEqual([]);
  });

  it('deduplicates repeated paths like the previous Set-based pass did', async () => {
    const media = await touch('dup.mp4');
    const { files, errors } = await expandImportPaths([media, media]);

    expect(files).toEqual([media]);
    expect(errors).toEqual([]);
  });
});
