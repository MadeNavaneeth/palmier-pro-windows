/**
 * Fan-out gating eval (Track 2, L6 — see docs/AGENTIC_ROADMAP.md).
 *
 * L6 proposes investigator subagents for read-only audits, off by default
 * until evals show a win over the single-agent baseline. This is that eval,
 * model-free: three audit tasks with objective answers, run once through a
 * single executor in sequence (the baseline) and once as three isolated
 * workers on deep-cloned projects (the fan-out pattern), through the real
 * ToolExecutor in both arms.
 *
 * What it pins:
 * - correctness parity: the fan-out answers equal the baseline answers equal
 *   the domain ground truth (a fan-out that degrades answers is disqualified
 *   no matter what it costs);
 * - bounded per-worker context: each worker carries less than the baseline
 *   turn (the mechanism of the claimed win);
 * - overhead guardrail: the fan-out total stays within 4x the baseline (the
 *   research warns of ~15x blowups for parallel coding agents; read-only
 *   audits must never approach that class).
 *
 * What it cannot measure without a model: latency. Parallel workers should
 * finish faster wall-clock, but these tools resolve synchronously in-process,
 * so any timing here would be theater. The token arithmetic is the honest
 * half of the gate; latency is the half that needs a live trial.
 */
import { describe, it, expect } from 'vitest';
import { ToolExecutor } from '../executor';
import { EditorController } from '../../../shared/editor/controller';
import { toolsToJsonSchema } from '../tools';
import { SYSTEM_PROMPT } from '../agent';
import { estimateTokens } from '../../../shared/ai/context-budget';

const TOOLS_JSON = JSON.stringify(toolsToJsonSchema());
const LONG_CLIP_FRAMES = 90;

/** Project JSON with the wall-clock field removed (see editing.test.ts). */
function contentJson(editor: EditorController): string {
  return JSON.stringify(editor.getProject()).replace(/"updatedAt":"[^"]*"/, '"updatedAt":"x"');
}

function addMedia(editor: EditorController, id: string, type: 'video' | 'audio') {
  editor.addMedia({
    id,
    path: `C:/media/${id}.${type === 'audio' ? 'wav' : 'mp4'}`,
    filename: `${id}.${type === 'audio' ? 'wav' : 'mp4'}`,
    type,
    duration: 300,
    width: type === 'video' ? 1920 : undefined,
    height: type === 'video' ? 1080 : undefined,
    fileSize: 1,
    addedAt: '2026-07-29T00:00:00.000Z',
  });
}

interface AuditScene {
  editor: EditorController;
  executor: ToolExecutor;
}

/** Clips of mixed lengths, markers of every status, one overlapping pair. */
async function auditScene(): Promise<AuditScene> {
  const editor = new EditorController();
  const executor = new ToolExecutor(editor);
  addMedia(editor, 'v', 'video');
  addMedia(editor, 'a', 'audio');
  editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 30 });
  editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 30, durationFrames: 120 });
  editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 150, durationFrames: 45 });
  editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 195, durationFrames: 200 });
  editor.addClip({ assetId: 'a', trackId: 'a1', startFrame: 0, durationFrames: 60 });
  editor.addClip({ assetId: 'a', trackId: 'a1', startFrame: 60, durationFrames: 150 });
  // Overlapping pair: the defect the audit must find.
  editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 400, durationFrames: 100 });
  editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 450, durationFrames: 100 });
  // Long tail for the very-long audit.
  editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 600, durationFrames: 250 });
  for (const [name, startFrame, status] of [
    ['Pickup', 12, 'open'],
    ['Retake', 200, 'review'],
    ['Done', 480, 'resolved'],
  ] as const) {
    const created = await executor.execute('manage_markers', { action: 'create', name, startFrame, status });
    expect(created.success).toBe(true);
  }
  return { editor, executor };
}

/** An isolated worker over a deep clone: no shared mutable state. */
function spawnWorker(projectJson: string): AuditScene {
  const editor = new EditorController();
  editor.loadProject(JSON.parse(projectJson));
  return { editor, executor: new ToolExecutor(editor) };
}

interface ClipLike {
  id: string;
  type: string;
  trackId: string;
  startFrame: number;
  durationFrames: number;
}

function clipsOf(result: unknown): ClipLike[] {
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error('get_clips returned no clip list');
  return data as ClipLike[];
}

interface IssueLike {
  code: string;
  severity: string;
}

function issuesOf(result: unknown): IssueLike[] {
  const data = (result as { data?: { issues?: unknown } }).data;
  if (!Array.isArray(data?.issues)) throw new Error('verify_timeline returned no issues');
  return data.issues as IssueLike[];
}

interface TimelineLike {
  tracks: { id: string; locked?: boolean; visible?: boolean }[];
  clips: ClipLike[];
  markers?: { status?: string }[];
}

function timelineOf(result: unknown): TimelineLike {
  const data = (result as { data?: unknown }).data as TimelineLike;
  if (!Array.isArray(data?.tracks) || !Array.isArray(data?.clips)) {
    throw new Error('get_timeline returned no timeline');
  }
  return data;
}

/** Tokens a request of this shape costs, measured the way the agent measures. */
function requestTokens(prompt: string, observation: unknown): number {
  return estimateTokens(SYSTEM_PROMPT + TOOLS_JSON + prompt + JSON.stringify(observation));
}

describe('evals: fan-out audits (L6 gate)', () => {
  it('a single agent answers three audits correctly', async () => {
    const { editor, executor } = await auditScene();
    const before = contentJson(editor);

    const longClips = await executor.execute('get_clips', {});
    const audit = await executor.execute('verify_timeline', {});
    const timeline = await executor.execute('get_timeline', {});

    // Ground truth from domain state, never from the receipts alone.
    const expectedLong = editor
      .getClips()
      .filter((clip) => clip.durationFrames > LONG_CLIP_FRAMES)
      .map((clip) => clip.id)
      .sort();
    expect(
      clipsOf(longClips).filter((clip) => clip.durationFrames > LONG_CLIP_FRAMES).map((clip) => clip.id).sort(),
    ).toEqual(expectedLong);
    expect(expectedLong.length).toBeGreaterThan(0);

    const codes = issuesOf(audit).map((issue) => issue.code);
    expect(codes).toContain('overlapping-clips');

    const summary = timelineOf(timeline);
    expect(summary.tracks.length).toBe(editor.getTracks().length);
    expect(summary.clips.length).toBe(editor.getClips().length);

    // Read-only audits mutate nothing, including the undo stack depth.
    expect(contentJson(editor)).toBe(before);
  });

  it('isolated workers give the same answers at bounded per-worker cost', async () => {
    const scene = await auditScene();
    const projectJson = JSON.stringify(scene.editor.getProject());

    // Six independent audits: per-track long-clip lists, a global long-clip
    // list, the structural audit, the timeline summary, and the media
    // inventory. Each is one read-only tool call plus a small derivation —
    // the shape L6 proposes for investigator workers.
    const prompts = {
      longVideo: 'List every clip on v1 longer than 90 frames.',
      longAudio: 'List every clip on a1 longer than 90 frames.',
      veryLong: 'List every clip anywhere longer than 200 frames.',
      audit: 'Report every structural problem with this timeline.',
      summary: 'Summarize tracks, clip counts by type, and marker statuses.',
      media: 'Inventory the media library.',
    };
    const tasks = [
      { key: 'longVideo', tool: 'get_clips', args: { trackId: 'v1' }, prompt: prompts.longVideo },
      { key: 'longAudio', tool: 'get_clips', args: { trackId: 'a1' }, prompt: prompts.longAudio },
      { key: 'veryLong', tool: 'get_clips', args: {}, prompt: prompts.veryLong },
      { key: 'audit', tool: 'verify_timeline', args: {}, prompt: prompts.audit },
      { key: 'summary', tool: 'get_timeline', args: {}, prompt: prompts.summary },
      { key: 'media', tool: 'get_media', args: {}, prompt: prompts.media },
    ] as const;

    type Answer = unknown;
    const derive = (key: string, result: unknown): Answer => {
      switch (key) {
        case 'longVideo':
        case 'longAudio':
          return clipsOf(result).filter((c) => c.durationFrames > LONG_CLIP_FRAMES).map((c) => c.id).sort();
        case 'veryLong':
          return clipsOf(result).filter((c) => c.durationFrames > 200).map((c) => c.id).sort();
        case 'audit':
          return issuesOf(result).map((i) => i.code).sort();
        case 'summary':
          return summarize(timelineOf(result));
        case 'media':
          return mediaOf(result);
        default:
          throw new Error(`unknown audit ${key}`);
      }
    };

    // Baseline: one executor, six calls in sequence; context accumulates.
    const baselineAnswers: Record<string, Answer> = {};
    let baselineTokens = 0;
    for (const task of tasks) {
      const result = await scene.executor.execute(task.tool, task.args);
      baselineAnswers[task.key] = derive(task.key, result);
      baselineTokens += requestTokens(task.prompt, result);
    }

    // Ground truth from domain state, never from the receipts alone.
    const clips = scene.editor.getClips();
    const longVideo = clips.filter((c) => c.trackId === 'v1' && c.durationFrames > LONG_CLIP_FRAMES).map((c) => c.id).sort();
    const longAudio = clips.filter((c) => c.trackId === 'a1' && c.durationFrames > LONG_CLIP_FRAMES).map((c) => c.id).sort();
    const veryLong = clips.filter((c) => c.durationFrames > 200).map((c) => c.id).sort();
    expect(baselineAnswers.longVideo).toEqual(longVideo);
    expect(baselineAnswers.longAudio).toEqual(longAudio);
    expect(baselineAnswers.veryLong).toEqual(veryLong);
    expect(longVideo.length).toBeGreaterThan(0);
    expect(longAudio.length).toBeGreaterThan(0);
    expect(veryLong.length).toBeGreaterThan(0);
    expect(baselineAnswers.audit as string[]).toContain('overlapping-clips');

    // Fan-out: one isolated worker per audit, no shared mutable state.
    const workerTokens: number[] = [];
    const workerAnswers: Record<string, Answer> = {};
    for (const task of tasks) {
      const worker = spawnWorker(projectJson);
      const result = await worker.executor.execute(task.tool, task.args);
      workerTokens.push(requestTokens(task.prompt, result));
      workerAnswers[task.key] = derive(task.key, result);
      expect(contentJson(worker.editor)).toBe(contentJson(scene.editor));
    }

    // Correctness parity: the fan-out must not degrade a single answer.
    expect(workerAnswers).toEqual(baselineAnswers);

    // Bounded per-worker context: no worker carries the whole turn. With six
    // accumulated observations the baseline is several times any one worker.
    const workerMax = Math.max(...workerTokens);
    expect(workerMax).toBeLessThan(baselineTokens / 3);

    // The orchestrator sees only the derived answers, not the raw
    // observations — this small context is the mechanism of the claimed win.
    const orchestratorTokens = requestTokens('Merge these audit answers.', workerAnswers);
    expect(orchestratorTokens).toBeLessThan(baselineTokens / 2);

    // Overhead guardrail: workers plus the merge must stay far from the ~15x
    // blowups parallel coding agents are warned about.
    const fanoutTotal = workerTokens.reduce((sum, tokens) => sum + tokens, 0) + orchestratorTokens;
    expect(fanoutTotal).toBeLessThanOrEqual(4 * baselineTokens);
  });
});

function mediaOf(result: unknown): Record<string, unknown> {
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error('get_media returned no asset list');
  const assets = data as { id: string; fileSize?: number }[];
  return {
    count: assets.length,
    ids: assets.map((asset) => asset.id).sort(),
    totalBytes: assets.reduce((sum, asset) => sum + (asset.fileSize ?? 0), 0),
  };
}

function summarize(timeline: TimelineLike): Record<string, unknown> {
  const byType: Record<string, number> = {};
  for (const clip of timeline.clips) byType[clip.type] = (byType[clip.type] ?? 0) + 1;
  const byStatus: Record<string, number> = {};
  for (const marker of timeline.markers ?? []) {
    const status = marker.status ?? 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  return {
    tracks: timeline.tracks.length,
    clipsByType: byType,
    markersByStatus: byStatus,
  };
}
