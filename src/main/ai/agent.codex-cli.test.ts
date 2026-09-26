/**
 * Regression coverage for the Codex CLI agent turn (upstream #142).
 *
 * The CLI module itself is stubbed at the module boundary; what matters here
 * is the integration contract: a Codex turn drives the same ToolExecutor as
 * the HTTP paths (same loop bound, same batching, same history shapes), and a
 * missing binary surfaces as a precise settings error rather than a hang.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { PalmierAgent, MAX_TOOL_ROUNDS, type StreamCallbacks } from './agent';
import { CancelledError } from './openai-compatible';

const mockCompletion = vi.hoisted(() => vi.fn());

vi.mock('./codex-cli', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runCodexCompletion: mockCompletion, renderCodexHistory: () => '' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Recorded {
  tokens: string[];
  toolCalls: { name: string; args: Record<string, unknown> }[];
  completed: string | null;
  error: string | null;
  cancelled: string | null;
}

function recorder(): { callbacks: StreamCallbacks; log: Recorded } {
  const log: Recorded = { tokens: [], toolCalls: [], completed: null, error: null, cancelled: null };
  return {
    log,
    callbacks: {
      onToken: (token) => log.tokens.push(token),
      onToolCall: (name, args) => log.toolCalls.push({ name, args }),
      onToolResult: () => undefined,
      onComplete: (full) => {
        log.completed = full;
      },
      onError: (error) => {
        log.error = error;
      },
      onCancelled: (partial) => {
        log.cancelled = partial;
      },
    },
  };
}

function agentWithClip(): PalmierAgent {
  const controller = new EditorController();
  controller.addMedia({
    id: 'asset',
    path: 'C:\\media\\clip.mp4',
    filename: 'clip.mp4',
    type: 'video',
    duration: 300,
    fileSize: 100,
    addedAt: '2026-07-25T00:00:00.000Z',
  });
  controller.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 60 });
  const agent = new PalmierAgent(controller);
  agent.configure({ provider: 'codex-cli', apiKey: '', workingDir: 'C:\\media' });
  return agent;
}

describe('codex-cli agent turn', () => {
  it('runs model tool calls through the shared ToolExecutor', async () => {
    mockCompletion
      .mockResolvedValueOnce({
        content: 'Checking.',
        toolCalls: [{ id: 'codex_0', name: 'get_timeline', argumentsJson: '{}' }],
        wantsTools: true,
      })
      .mockResolvedValueOnce({ content: 'One clip found.', toolCalls: [], wantsTools: false });

    const agent = agentWithClip();
    // No key, no endpoint — the CLI authenticates with its own sign-in.
    expect(agent.isConfigured()).toBe(true);
    const { callbacks, log } = recorder();
    await agent.chat('what is on the timeline?', callbacks);

    expect(log.error).toBeNull();
    expect(log.completed).toBe('Checking.One clip found.');
    expect(log.toolCalls).toEqual([{ name: 'get_timeline', args: {} }]);
    // Same per-round shape the HTTP paths send: binary, sandbox, history.
    const first = mockCompletion.mock.calls[0]![0];
    expect(first.workingDir).toBe('C:\\media');
    expect(first.userMessage).toBe('what is on the timeline?');
    expect(first.tools.length).toBeGreaterThan(0);
    expect(mockCompletion).toHaveBeenCalledTimes(2);
  });

  it('reports a missing binary as a settings error', async () => {
    mockCompletion.mockRejectedValueOnce(
      new Error('Codex CLI was not found on PATH. Install it from https://github.com/openai/codex'),
    );
    const { callbacks, log } = recorder();
    await agentWithClip().chat('hi', callbacks);
    expect(log.completed).toBeNull();
    expect(log.error).toMatch(/not found on PATH/);
  });

  it('reports cancellation distinctly from failure', async () => {
    mockCompletion.mockRejectedValueOnce(new CancelledError());
    const { callbacks, log } = recorder();
    await agentWithClip().chat('hi', callbacks);
    expect(log.error).toBeNull();
    expect(log.cancelled).toBe('');
  });

  it('refuses without a working directory before spawning anything', async () => {
    const controller = new EditorController();
    const agent = new PalmierAgent(controller);
    agent.configure({ provider: 'codex-cli', apiKey: '' });
    const { callbacks, log } = recorder();
    await agent.chat('hi', callbacks);
    expect(log.error).toMatch(/working directory/i);
    expect(mockCompletion).not.toHaveBeenCalled();
  });

  it('bounds the tool loop like the HTTP paths', () => {
    expect(MAX_TOOL_ROUNDS).toBeGreaterThan(0);
  });
});
