/**
 * Coverage for verify_timeline (Track 2, L2): the read-only audit finds
 * seeded structural defects, reports them with ids, and — critically for an
 * agent-visible tool — never mutates the project or opens an undo entry.
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project } from '../../shared/types/project';

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'a', type: 'video', trackId: 'v1',
    startFrame: 0, durationFrames: 30, inPoint: 0, outPoint: 30,
    x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...overrides,
  };
}

function defectiveProject(): Project {
  const project = createEmptyProject();
  project.media = [{
    id: 'a', path: 'C:/media/a.mp4', filename: 'a.mp4', type: 'video',
    duration: 100, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
  }];
  project.timeline.clips = [
    clip({ id: 'zero', durationFrames: 0 }),
    clip({ id: 'ghost-asset', assetId: 'nope' }),
  ];
  return project;
}

interface VerifyData {
  issues: Array<{ code: string; severity: string; clipId?: string }>;
  errorCount: number;
  warningCount: number;
  checked: { clips: number; markers: number; media: number };
}

describe('verify_timeline tool (L2)', () => {
  it('reports seeded defects with their owning clip ids', async () => {
    const editor = new EditorController(defectiveProject());
    const executor = new ToolExecutor(editor);

    const result = await executor.execute('verify_timeline', {});

    expect(result.success).toBe(true);
    const data = result.data as VerifyData;
    const codes = data.issues.map((issue) => issue.code);
    expect(codes).toContain('zero-length-clip');
    expect(codes).toContain('missing-media');
    expect(data.errorCount).toBeGreaterThanOrEqual(2);
    expect(data.issues.find((issue) => issue.code === 'zero-length-clip')?.clipId).toBe('zero');
    expect(data.checked.clips).toBe(2);
  });

  it('is read-only: no mutation, no undo entry', async () => {
    const editor = new EditorController(defectiveProject());
    const executor = new ToolExecutor(editor);
    const before = JSON.stringify(editor.getProject());
    const lastCommand = editor.getLastCommandDescription();

    await executor.execute('verify_timeline', { limit: 10 });

    expect(JSON.stringify(editor.getProject())).toBe(before);
    expect(editor.canUndo()).toBe(false);
    expect(editor.getLastCommandDescription()).toBe(lastCommand);
  });

  it('is quiet on a clean timeline and bounds the issue list', async () => {
    // The audit checks the disk for real, so the fixture path must exist.
    const real = path.join(os.tmpdir(), `palmier-verify-${Date.now()}.mp4`);
    await fs.writeFile(real, 'fixture');
    try {
      const editor = new EditorController();
      editor.addMedia({
        id: 'a', path: real, filename: 'a.mp4', type: 'video',
        duration: 100, fileSize: 7, addedAt: '2026-01-01T00:00:00.000Z',
      });
      editor.addClip({ assetId: 'a', trackId: 'v1', startFrame: 0, durationFrames: 30 });
      const executor = new ToolExecutor(editor);

      const clean = await executor.execute('verify_timeline', {});
      expect(clean.success).toBe(true);
      expect((clean.data as VerifyData).issues).toEqual([]);
    } finally {
      await fs.rm(real, { force: true });
    }

    const capped = await new ToolExecutor(new EditorController(defectiveProject()))
      .execute('verify_timeline', { limit: 1 });
    expect((capped.data as VerifyData).issues).toHaveLength(1);
  });
});
