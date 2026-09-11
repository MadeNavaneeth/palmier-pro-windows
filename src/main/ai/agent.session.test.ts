/**
 * Session hand-off for a detached chat (upstream #286).
 *
 * A detached agent window adopts the visible session on boot through
 * `ai:get-session`; these tests pin the main-process side of that contract:
 * the snapshot carries the structured history plus the current plan, it is a
 * deep copy the renderer cannot use to corrupt the live session, and clearing
 * the history clears the plan with it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: (params: unknown, options?: unknown) => mocks.create(params, options),
    };
  },
}));

import { PalmierAgent, type StreamCallbacks } from './agent';
import { EditorController } from '../../shared/editor/controller';

const CONFIG = { provider: 'anthropic' as const, apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' };

function callbacks(): StreamCallbacks {
  return {
    onToken: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onPlan: () => {},
    onComplete: () => {},
    onError: (error) => { throw new Error(`unexpected agent error: ${error}`); },
    onCancelled: () => {},
  };
}

function textTurn(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

function toolTurn(calls: { id: string; name: string; input: unknown }[]) {
  return {
    content: calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
    stop_reason: 'tool_use',
  };
}

beforeEach(() => {
  mocks.create.mockReset();
});

describe('agent session snapshot (#286)', () => {
  it('carries the history and the plan a late window needs', async () => {
    const controller = new EditorController();
    controller.addMedia({
      id: 'asset', path: 'C:\\media\\clip.mp4', filename: 'clip.mp4',
      type: 'video', duration: 300, fileSize: 100, addedAt: '2026-07-29T00:00:00.000Z',
    });
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);

    mocks.create
      .mockResolvedValueOnce(toolTurn([
        { id: 't1', name: 'update_plan', input: { steps: [{ step: 'Trim the intro', status: 'in_progress' }] } },
        { id: 't2', name: 'get_timeline', input: {} },
      ]))
      .mockResolvedValueOnce(textTurn('Trimmed.'));

    await agent.chat('trim the intro', callbacks());

    const snapshot = agent.getSessionSnapshot();
    const text = JSON.stringify(snapshot);
    expect(text).toContain('Trim the intro');
    expect(text).toContain('in_progress');
    expect(snapshot.plan).toEqual([{ step: 'Trim the intro', status: 'in_progress' }]);
    expect(snapshot.history.length).toBeGreaterThan(0);
  });

  it('hands out a copy, not a handle into the live session', async () => {
    const agent = new PalmierAgent(new EditorController());
    agent.configure(CONFIG);
    mocks.create.mockResolvedValue(textTurn('Done.'));
    await agent.chat('hello', callbacks());

    const snapshot = agent.getSessionSnapshot();
    (snapshot.history as { role?: unknown; content?: unknown }[]).push({ role: 'user', content: 'forged' });
    if (snapshot.plan) snapshot.plan.length = 0;

    const again = agent.getSessionSnapshot();
    expect(JSON.stringify(again)).not.toContain('forged');
    expect(again.history.length).toBe(snapshot.history.length - 1);
  });

  it('clears the plan with the history', async () => {
    const agent = new PalmierAgent(new EditorController());
    agent.configure(CONFIG);
    mocks.create
      .mockResolvedValueOnce(toolTurn([
        { id: 't1', name: 'update_plan', input: { steps: [{ step: 'Trim', status: 'pending' }] } },
      ]))
      .mockResolvedValueOnce(textTurn('Done.'));
    await agent.chat('plan something', callbacks());
    expect(agent.getSessionSnapshot().plan).toEqual([{ step: 'Trim', status: 'pending' }]);

    agent.clearHistory();

    expect(agent.getSessionSnapshot()).toEqual({ history: [], plan: null });
  });

  it('starts empty', () => {
    const agent = new PalmierAgent(new EditorController());
    expect(agent.getSessionSnapshot()).toEqual({ history: [], plan: null });
  });
});
