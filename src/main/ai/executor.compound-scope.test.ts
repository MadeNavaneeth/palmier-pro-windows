/**
 * Agent scope contract for nested timelines (upstream issue #155, slice 2).
 *
 * Reads are explicitly scoped and deterministic: an omitted scopeTimelineId
 * always means the MAIN timeline — never the UI's open nest — so agent
 * reasoning cannot silently shift scope. Mutations default to the ambient
 * open scope (the main-process mirror never opens one, so agent calls land
 * at the root), with an explicit scopeTimelineId selecting a nest.
 * verify_timeline audits every scope at once and needs no scope argument.
 */
import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

function harness() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'asset',
    path: 'C:\\media\\take.mp4',
    filename: 'take.mp4',
    type: 'video',
    duration: 300,
    fileSize: 1000,
    addedAt: '2026-07-29T00:00:00.000Z',
  });
  const first = editor.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 60 });
  const second = editor.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 60, durationFrames: 40 });
  return { editor, executor: new ToolExecutor(editor), first, second };
}

async function nestOnce(executor: ToolExecutor, clipIds: string[]) {
  const result = await executor.execute('nest_clips', { clipIds });
  expect(result.success).toBe(true);
  return result.data as { compoundClipId: string; timelineId: string; timelineName: string };
}

describe('agent scope reads', () => {
  it('get_timeline defaults to the main timeline even with a nest open', async () => {
    const { executor, editor, first, second } = harness();
    const nested = await nestOnce(executor, [first, second]);
    // A nest open on this same controller (as the UI would hold it) must
    // not move the agent's default read scope.
    editor.openCompoundClip(nested.compoundClipId);

    const result = await executor.execute('get_timeline', {});
    expect(result.success).toBe(true);
    const data = result.data as { clips: Array<{ id: string }>; scopeTimelineId: null };
    expect(data.clips.map((clip) => clip.id)).toEqual([nested.compoundClipId]);
    expect(data.scopeTimelineId).toBeNull();
  });

  it('get_timeline reads an explicit nested scope and lists nested timelines', async () => {
    const { executor, first, second } = harness();
    const nested = await nestOnce(executor, [first, second]);

    const scoped = await executor.execute('get_timeline', { scopeTimelineId: nested.timelineId });
    expect(scoped.success).toBe(true);
    const data = scoped.data as {
      clips: Array<{ id: string }>;
      scopeTimelineId: string;
      timelines: Array<{ id: string; name: string; clipCount: number }>;
    };
    expect(data.clips.map((clip) => clip.id).sort()).toEqual([first, second].sort());
    expect(data.scopeTimelineId).toBe(nested.timelineId);
    expect(data.timelines).toEqual([{ id: nested.timelineId, name: 'Compound 1', clipCount: 2 }]);
  });

  it('get_timeline without nests has no timelines key (legacy shape)', async () => {
    const { executor } = harness();
    const result = await executor.execute('get_timeline', {});
    expect(result.success).toBe(true);
    expect('timelines' in (result.data as Record<string, unknown>)).toBe(false);
    expect((result.data as { scopeTimelineId: null }).scopeTimelineId).toBeNull();
  });

  it('scope reads refuse dangling ids without mutating', async () => {
    const { executor, editor } = harness();
    const timeline = await executor.execute('get_timeline', { scopeTimelineId: 'ghost' });
    expect(timeline.success).toBe(false);
    expect(timeline.error).toContain('ghost');
    const clips = await executor.execute('get_clips', { scopeTimelineId: 'ghost' });
    expect(clips.success).toBe(false);
    expect(editor.getClips()).toHaveLength(2);
  });

  it('get_clips lists a nested scope and still filters by track', async () => {
    const { executor, first, second } = harness();
    const nested = await nestOnce(executor, [first, second]);
    const result = await executor.execute('get_clips', { scopeTimelineId: nested.timelineId, trackId: 'v1' });
    expect(result.success).toBe(true);
    expect((result.data as Array<{ id: string }>).map((clip) => clip.id).sort())
      .toEqual([first, second].sort());
  });

  it('verify_timeline reports nested-timeline problems with no scope argument', async () => {
    const { executor, editor } = harness();
    // Hand-place a dangling compound: render skips it, the audit names it.
    const project = editor.getProject();
    const dangling = {
      id: 'dangling', assetId: '__compound__', type: 'compound', trackId: 'v1',
      startFrame: 200, durationFrames: 10, inPoint: 0, outPoint: 10,
      x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
      opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
      compoundTimelineId: 'gone',
    } as never;
    editor.loadProject({
      ...project,
      timeline: { ...project.timeline, clips: [...project.timeline.clips, dangling] },
    });
    const result = await executor.execute('verify_timeline', {});
    expect(result.success).toBe(true);
    const data = result.data as { issues: Array<{ code: string; severity: string }> };
    expect(data.issues.some((issue) => issue.code === 'compound-invalid')).toBe(true);
  });
});

describe('agent scope mutations', () => {
  it('nest_clips without scope lands at the root even with a nest open', async () => {
    const { executor, editor, first, second } = harness();
    const nested = await nestOnce(executor, [first, second]);
    editor.openCompoundClip(nested.compoundClipId);
    // A third clip placed at root, then nested without a scope: the agent
    // mirror never opens scopes, so this must nest at the root.
    editor.navigateToScope(null);
    const third = editor.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 200, durationFrames: 20 });
    const result = await executor.execute('nest_clips', { clipIds: [third] });
    expect(result.success).toBe(true);
    expect((result.data as { scopeTimelineId: null }).scopeTimelineId).toBeNull();
    expect(editor.getProject().timeline.clips).toHaveLength(2);
  });

  it('nest_clips with an explicit scope nests inside the nest', async () => {
    const { executor, editor, first, second } = harness();
    const nested = await nestOnce(executor, [first, second]);
    const inner = await executor.execute('nest_clips', {
      clipIds: [first],
      scopeTimelineId: nested.timelineId,
    });
    expect(inner.success).toBe(true);
    const receipt = inner.data as { scopeTimelineId: string; compoundClipId: string };
    expect(receipt.scopeTimelineId).toBe(nested.timelineId);
    expect(editor.getProject().timelines?.[nested.timelineId]?.clips
      .some((clip) => clip.id === receipt.compoundClipId)).toBe(true);
  });

  it('flatten_compound with an explicit scope flattens inside the nest', async () => {
    const { executor, editor, first, second } = harness();
    const nested = await nestOnce(executor, [first, second]);
    const inner = await executor.execute('nest_clips', {
      clipIds: [first],
      scopeTimelineId: nested.timelineId,
    });
    const innerCompound = (inner.data as { compoundClipId: string }).compoundClipId;
    const flat = await executor.execute('flatten_compound', {
      clipId: innerCompound,
      scopeTimelineId: nested.timelineId,
    });
    expect(flat.success).toBe(true);
    expect((flat.data as { scopeTimelineId: string }).scopeTimelineId).toBe(nested.timelineId);
    expect(editor.getProject().timelines?.[nested.timelineId]?.clips
      .some((clip) => clip.id === first)).toBe(true);
  });

  it('scoped mutations refuse dangling scopes without mutating', async () => {
    const { executor, editor, first } = harness();
    const nest = await executor.execute('nest_clips', { clipIds: [first], scopeTimelineId: 'ghost' });
    expect(nest.success).toBe(false);
    expect(nest.error).toContain('ghost');
    const flat = await executor.execute('flatten_compound', { clipId: first, scopeTimelineId: 'ghost' });
    expect(flat.success).toBe(false);
    expect(editor.getClips()).toHaveLength(2);
  });
});
