/**
 * Loader + export-preflight coverage (upstream #157 LUT slice): boundary
 * validation refuses missing/invalid files with the reason, the preview
 * resolver degrades to null (ungraded stage, never a throw), successes are
 * cached, and the exporter strips missing LUTs with a visible warning.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEmptyProject, type Clip } from '../../shared/types/project';
import { clearLutCache, resolvePreviewLut, validateLutFile } from './lut-loader';
import { stripMissingLuts } from './exporter';

function tmpCube(name: string, text: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lut-')), name);
  fs.writeFileSync(file, text);
  return file;
}

const IDENTITY_3 = [
  'LUT_3D_SIZE 2',
  '0 0 0', '1 0 0', '0 1 0', '1 1 0',
  '0 0 1', '1 0 1', '0 1 1', '1 1 1',
].join('\n');

afterEach(() => {
  clearLutCache();
});

describe('validateLutFile', () => {
  it('accepts a valid .cube and records kind + size for the export builder', () => {
    const file = tmpCube('ok.cube', IDENTITY_3);
    const validation = validateLutFile(file, 0.5);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.ref).toEqual({ path: file, intensity: 0.5, kind: '3d', size: 2 });
  });

  it('refuses missing files, wrong extensions, and invalid content precisely', () => {
    const missing = validateLutFile(path.join(os.tmpdir(), 'lut-nope', 'gone.cube'));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/No file at path/);

    const ext = validateLutFile('C:\\luts\\warm.lut');
    expect(ext.ok).toBe(false);
    if (!ext.ok) expect(ext.error).toMatch(/\.cube extension/);

    const bad = tmpCube('bad.cube', 'LUT_3D_SIZE 2\n0 0 0');
    const invalid = validateLutFile(bad);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toMatch(/Not a valid \.cube LUT/);

    expect(validateLutFile(tmpCube('ok.cube', IDENTITY_3), 2).ok).toBe(false);
    expect(validateLutFile('').ok).toBe(false);
  });
});

describe('resolvePreviewLut', () => {
  it('resolves a table once and degrades missing files to null', () => {
    const file = tmpCube('preview.cube', IDENTITY_3);
    const first = resolvePreviewLut(file);
    expect(first?.kind).toBe('3d');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    // Cached: the table survives the file's deletion for this session.
    expect(resolvePreviewLut(file)).toBe(first);
    expect(resolvePreviewLut(path.join(os.tmpdir(), 'lut-nope', 'gone.cube'))).toBeNull();
    expect(resolvePreviewLut(undefined)).toBeNull();
  });
});

describe('stripMissingLuts', () => {
  function projectWith(clips: Partial<Clip>[]) {
    const project = createEmptyProject();
    const base: Clip = {
      id: 'c', assetId: 'a', type: 'video', trackId: 'v1',
      startFrame: 0, durationFrames: 10, inPoint: 0, outPoint: 10,
      x: 0, y: 0, width: 16, height: 9, rotation: 0, scaleX: 1, scaleY: 1,
      opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    };
    project.timeline.clips = clips.map((overrides, index) => ({ ...base, id: `c${index}`, ...overrides }));
    return project;
  }

  it('keeps valid LUTs and returns the project untouched', () => {
    const file = tmpCube('keep.cube', IDENTITY_3);
    const project = projectWith([{ lut: { path: file, intensity: 1, kind: '3d', size: 2 } }]);
    const warnings: string[] = [];
    expect(stripMissingLuts(project, warnings)).toBe(project);
    expect(warnings).toEqual([]);
  });

  it('strips missing LUTs with a visible warning, leaving other clips alone', () => {
    const file = tmpCube('keep.cube', IDENTITY_3);
    const project = projectWith([
      { lut: { path: path.join(os.tmpdir(), 'lut-nope', 'gone.cube'), intensity: 1, kind: '3d', size: 2 } },
      { lut: { path: file, intensity: 0.5, kind: '3d', size: 2 } },
      {},
    ]);
    const warnings: string[] = [];
    const stripped = stripMissingLuts(project, warnings);
    expect(stripped.timeline.clips[0]).not.toHaveProperty('lut');
    expect(stripped.timeline.clips[1].lut?.intensity).toBe(0.5);
    expect(stripped.timeline.clips[2]).not.toHaveProperty('lut');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('gone.cube');
  });
});
