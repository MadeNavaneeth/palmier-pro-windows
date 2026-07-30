/**
 * Long multi-step agent turns (upstream #58).
 *
 * #58 reports the app pinned at 100% CPU with MCP unresponsive during agent
 * multi-step edits. The structural mitigations live elsewhere — bounded pure
 * state operations, out-of-process decode and export, newest-wins frame
 * coalescing, a round cap — so what this file guards is the part that only shows
 * up over a long sequence:
 *
 *   - replayed history grows linearly in the number of rounds, not faster.
 *     Superlinear growth is the mechanism behind the reported symptom: every
 *     round re-sends the whole conversation, so duplicated turns compound token
 *     cost and latency until the app looks wedged;
 *   - the project stays structurally valid after dozens of mutations, rather
 *     than accumulating overlaps or dangling references that later operations
 *     then have to reason about;
 *   - every step stays individually undoable, so a long run can be walked back;
 *   - a failing tool never aborts the loop or escapes as an exception;
 *   - stopping mid-sequence leaves a consistent project.
 *
 * Driven through the Anthropic path because it is the default provider and the
 * one whose history is assembled from content blocks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  /** Per-round snapshot; the agent hands the SDK its live history array. */
  sent: [] as { role: string; content: unknown }[][],
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: (params: { messages: unknown }, options?: unknown) => {
        mocks.sent.push(JSON.parse(JSON.stringify(params.messages)));
        return mocks.create(params, options);
      },
    };
  },
}));

import { PalmierAgent, MAX_TOOL_ROUNDS, type StreamCallbacks } from './agent';
import { EditorController } from '../../shared/editor/controller';
import type { Project } from '../../shared/types/project';

const CONFIG = {
  provider: 'anthropic' as const,
  apiKey: 'sk-ant-test',
  model: 'claude-sonnet-4-20250514',
};

interface Recorded {
  toolCalls: string[];
  toolResults: { name: string; success: boolean }[];
  completed: string | null;
  error: string | null;
  cancelled: string | null;
}

function recorder(): { callbacks: StreamCallbacks; log: Recorded } {
  const log: Recorded = {
    toolCalls: [], toolResults: [], completed: null, error: null, cancelled: null,
  };
  return {
    log,
    callbacks: {
      onToken: () => {},
      onToolCall: (name) => log.toolCalls.push(name),
      onToolResult: (name, result) => {
        log.toolResults.push({ name, success: (result as { success?: boolean }).success === true });
      },
      onComplete: (full) => { log.completed = full; },
      onError: (error) => { log.error = error; },
      onCancelled: (partial) => { log.cancelled = partial; },
    },
  };
}

/** A project with four assets and eight clips spread over two video tracks. */
function harness() {
  const controller = new EditorController();
  for (let i = 0; i < 4; i += 1) {
    controller.addMedia({
      id: `asset${i}`,
      path: `C:\\media\\take${i}.mp4`,
      filename: `take${i}.mp4`,
      type: 'video',
      duration: 600,
      fileSize: 1024,
      addedAt: '2026-07-29T00:00:00.000Z',
    });
  }
  const secondTrack = controller.addTrack('video', 'Video 2');
  const trackIds = ['v1', secondTrack];
  const clipIds: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    clipIds.push(controller.addClip({
      assetId: `asset${i % 4}`,
      trackId: trackIds[i % 2],
      startFrame: i * 200,
      durationFrames: 150,
    }));
  }
  expect(clipIds.every((id) => id.length > 0), 'harness placements must succeed').toBe(true);

  // Reloading clears the undo history, so the turn under test starts from a
  // clean slate and undo depth measures the agent's own edits, not this setup.
  controller.loadProject(structuredClone(controller.getProject()));
  return {
    controller,
    clipIds,
    baseline: timelineShape(controller.getProject()),
    agent: new PalmierAgent(controller),
  };
}

/** Timeline structure, ignoring the playhead, which is not a document edit. */
function timelineShape(project: Project): string {
  const { tracks, clips } = project.timeline;
  return JSON.stringify({ tracks, clips });
}

/**
 * Structural faults in a project, as human-readable strings.
 *
 * Deliberately independent of the controller's own checks: the point is to
 * detect a state the controller allowed but should not have.
 */
function projectFaults(project: Project): string[] {
  const faults: string[] = [];
  const assetIds = new Set(project.media.map((asset) => asset.id));
  const trackIds = new Set(project.timeline.tracks.map((track) => track.id));
  const seen = new Set<string>();

  for (const clip of project.timeline.clips) {
    if (seen.has(clip.id)) faults.push(`duplicate clip id ${clip.id}`);
    seen.add(clip.id);
    if (!assetIds.has(clip.assetId)) faults.push(`${clip.id} references missing asset ${clip.assetId}`);
    if (!trackIds.has(clip.trackId)) faults.push(`${clip.id} sits on missing track ${clip.trackId}`);
    if (!Number.isInteger(clip.startFrame) || clip.startFrame < 0) {
      faults.push(`${clip.id} has start frame ${clip.startFrame}`);
    }
    if (!Number.isInteger(clip.durationFrames) || clip.durationFrames <= 0) {
      faults.push(`${clip.id} has duration ${clip.durationFrames}`);
    }
    if (clip.outPoint <= clip.inPoint) {
      faults.push(`${clip.id} has source range ${clip.inPoint}-${clip.outPoint}`);
    }
  }

  // Overlaps, per track. Two clips occupying the same frame on one track is the
  // state that makes later ripple and trim maths ambiguous.
  const byTrack = new Map<string, typeof project.timeline.clips>();
  for (const clip of project.timeline.clips) {
    const list = byTrack.get(clip.trackId) ?? [];
    list.push(clip);
    byTrack.set(clip.trackId, list);
  }
  for (const [trackId, clips] of byTrack) {
    const ordered = [...clips].sort((a, b) => a.startFrame - b.startFrame);
    for (let i = 1; i < ordered.length; i += 1) {
      const previousEnd = ordered[i - 1].startFrame + ordered[i - 1].durationFrames;
      if (ordered[i].startFrame < previousEnd) {
        faults.push(`${trackId}: ${ordered[i - 1].id} overlaps ${ordered[i].id}`);
      }
    }
  }
  return faults;
}

function toolTurn(calls: { id: string; name: string; input: unknown }[]) {
  return {
    content: calls.map((call) => ({
      type: 'tool_use', id: call.id, name: call.name, input: call.input,
    })),
    stop_reason: 'tool_use',
  };
}

function textTurn(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

/**
 * A plausible long edit: read the timeline, then move, trim, split and restyle
 * across every round until the model finally answers.
 */
function scriptLongEdit(clipIds: string[], rounds: number): void {
  for (let round = 0; round < rounds; round += 1) {
    const clipId = clipIds[round % clipIds.length];
    mocks.create.mockResolvedValueOnce(toolTurn([
      { id: `r${round}a`, name: 'get_clips', input: {} },
      { id: `r${round}b`, name: 'set_clip_opacity_unsupported', input: {} },
      { id: `r${round}c`, name: 'trim_clip', input: { clipId, newDurationFrames: 120 - (round % 20) } },
      { id: `r${round}d`, name: 'set_clip_fade', input: { clipId, fadeInSeconds: 0.5 } },
      { id: `r${round}e`, name: 'set_playhead', input: { frame: round * 5 } },
    ]));
  }
  mocks.create.mockResolvedValueOnce(textTurn('Finished the pass.'));
}

beforeEach(() => {
  mocks.create.mockReset();
  mocks.sent.length = 0;
});

describe('a long multi-step agent turn', () => {
  it('completes a full run of rounds and tool calls', async () => {
    const { agent, clipIds, controller } = harness();
    agent.configure(CONFIG);
    const rounds = MAX_TOOL_ROUNDS - 1;
    scriptLongEdit(clipIds, rounds);

    const { callbacks, log } = recorder();
    await agent.chat('tighten the whole sequence', callbacks);

    expect(log.error).toBeNull();
    expect(log.completed).toBe('Finished the pass.');
    expect(mocks.create).toHaveBeenCalledTimes(rounds + 1);
    // Five tools a round, every one of them reported back.
    expect(log.toolCalls).toHaveLength(rounds * 5);
    expect(log.toolResults).toHaveLength(rounds * 5);
    expect(projectFaults(controller.getProject())).toEqual([]);
  });

  it('grows the replayed history linearly in the number of rounds', async () => {
    const { agent, clipIds } = harness();
    agent.configure(CONFIG);
    const rounds = MAX_TOOL_ROUNDS - 1;
    scriptLongEdit(clipIds, rounds);

    await agent.chat('tighten the whole sequence', recorder().callbacks);

    // One assistant turn plus one results turn per round, on top of the opening
    // user message. Anything above this is a duplicated turn, and because every
    // round re-sends the whole conversation, duplication compounds — which is
    // how a long run turns into the stall #58 describes.
    const lengths = mocks.sent.map((messages) => messages.length);
    expect(lengths[0]).toBe(1);
    for (let round = 0; round < lengths.length; round += 1) {
      expect(lengths[round]).toBe(1 + round * 2);
    }

    // Stated as a bound as well, so a future regression fails on the shape of
    // the growth rather than only on an exact count.
    const last = lengths[lengths.length - 1];
    expect(last).toBeLessThanOrEqual(2 * rounds + 1);
  });

  it('never records a tool call the model cannot see answered', async () => {
    const { agent, clipIds } = harness();
    agent.configure(CONFIG);
    scriptLongEdit(clipIds, MAX_TOOL_ROUNDS - 1);

    await agent.chat('tighten the whole sequence', recorder().callbacks);

    for (const messages of mocks.sent) {
      for (let i = 0; i < messages.length; i += 1) {
        if (messages[i].role !== 'assistant') continue;
        const calls = (messages[i].content as { type: string; id?: string }[])
          .filter((block) => block.type === 'tool_use')
          .map((block) => block.id);
        if (calls.length === 0) continue;
        const answers = (messages[i + 1]?.content as { type: string; tool_use_id?: string }[])
          .filter((block) => block.type === 'tool_result')
          .map((block) => block.tool_use_id);
        expect(answers).toEqual(calls);
      }
    }
  });

  it('keeps every step undoable back to the starting project', async () => {
    const { agent, clipIds, controller, baseline } = harness();
    agent.configure(CONFIG);
    scriptLongEdit(clipIds, MAX_TOOL_ROUNDS - 1);

    await agent.chat('tighten the whole sequence', recorder().callbacks);
    expect(timelineShape(controller.getProject())).not.toBe(baseline);

    // Bounded so a controller that stopped recording history fails here rather
    // than spinning.
    let steps = 0;
    while (controller.canUndo() && steps < 500) {
      controller.undo();
      steps += 1;
    }
    expect(steps).toBeGreaterThan(0);
    expect(timelineShape(controller.getProject())).toBe(baseline);
  });

  it('reports a rejected tool without aborting the run or throwing', async () => {
    const { agent, controller } = harness();
    agent.configure(CONFIG);
    // Every call is invalid: an unknown tool, a missing clip, and out-of-range
    // numbers. None of these may escape as an exception.
    for (let round = 0; round < MAX_TOOL_ROUNDS - 1; round += 1) {
      mocks.create.mockResolvedValueOnce(toolTurn([
        { id: `x${round}a`, name: 'no_such_tool', input: {} },
        { id: `x${round}b`, name: 'trim_clip', input: { clipId: 'missing', newDurationFrames: 10 } },
        { id: `x${round}c`, name: 'set_playhead', input: { frame: Number.NaN } },
        { id: `x${round}d`, name: 'split_clip', input: { clipId: 'missing', atFrame: -5 } },
      ]));
    }
    mocks.create.mockResolvedValueOnce(textTurn('None of that worked.'));

    const { callbacks, log } = recorder();
    await agent.chat('do impossible things', callbacks);

    expect(log.error).toBeNull();
    expect(log.completed).toBe('None of that worked.');
    expect(log.toolResults.every((entry) => entry.success === false)).toBe(true);
    expect(projectFaults(controller.getProject())).toEqual([]);
    expect(controller.canUndo()).toBe(false);
  });

  it('leaves a consistent project when stopped part way through', async () => {
    const { agent, clipIds, controller } = harness();
    agent.configure(CONFIG);
    scriptLongEdit(clipIds, MAX_TOOL_ROUNDS - 1);

    const { callbacks, log } = recorder();
    let seen = 0;
    const record = callbacks.onToolResult;
    callbacks.onToolResult = (name, result) => {
      record(name, result);
      seen += 1;
      // Part way into the third round, mid tool batch.
      if (seen === 12) agent.cancel();
    };

    await agent.chat('tighten the whole sequence', callbacks);

    expect(log.cancelled).not.toBeNull();
    expect(log.error).toBeNull();
    expect(log.toolCalls).toHaveLength(12);
    expect(projectFaults(controller.getProject())).toEqual([]);
    expect(agent.isBusy()).toBe(false);

    // And the conversation is still usable afterwards. The queue is cleared
    // first, or the follow-up would be served the rounds the stopped turn left
    // behind rather than the reply scripted here.
    mocks.create.mockReset();
    mocks.create.mockResolvedValue(textTurn('Stopped there.'));
    const next = recorder();
    await agent.chat('leave it there', next.callbacks);
    expect(next.log.error).toBeNull();
    expect(next.log.completed).toBe('Stopped there.');
  });
});
