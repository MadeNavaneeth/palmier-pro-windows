/**
 * Context compaction (Track 2, L4c — see docs/AGENTIC_ROADMAP.md).
 *
 * The budget arithmetic is pinned in `context-budget.test.ts`; this file pins the
 * wiring: that compaction happens before the request is built, that the summary
 * replaces the backlog rather than joining it, that a failed summarization
 * degrades to a reset instead of failing the turn, and that the raw transcript
 * on disk records enough to audit what was dropped.
 *
 * The window is derived from a measured first turn rather than hard-coded, so
 * the tests do not silently stop exercising compaction when the tool schemas or
 * the system prompt grow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  /** Messages of every non-summarization request, in order. */
  sent: [] as unknown[],
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: (params: { system?: string; messages: unknown }, options?: unknown) => {
        if (typeof params.system === 'string' && params.system.includes('Compress the conversation')) {
          return mocks.create(params, options);
        }
        mocks.sent.push(params.messages);
        return mocks.create(params, options);
      },
    };
  },
}));

import { PalmierAgent, type StreamCallbacks, type AgentConfig } from './agent';
import { EditorController } from '../../shared/editor/controller';
import { SUMMARY_HEADER, shouldCompact } from '../../shared/ai/context-budget';

let tmpDir = '';
const CONFIG: AgentConfig = {
  provider: 'anthropic',
  apiKey: 'sk-ant-test',
  model: 'claude-sonnet-4-20250514',
};

beforeEach(async () => {
  mocks.create.mockReset();
  mocks.sent.length = 0;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-compact-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function recorder(): { callbacks: StreamCallbacks; log: { completed: string | null; error: string | null } } {
  const log = { completed: null as string | null, error: null as string | null };
  return {
    log,
    callbacks: {
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onComplete: (full) => { log.completed = full; },
      onError: (error) => { log.error = error; },
      onCancelled: () => {},
    },
  };
}

function textTurn(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

/** Flatten the first user turn in a sent payload to its text. */
function firstUserText(messages: unknown): string {
  const list = messages as { role: string; content: unknown }[];
  const user = list.find((entry) => entry.role === 'user');
  if (!user) return '';
  if (typeof user.content === 'string') return user.content;
  const blocks = user.content as { type?: string; text?: string }[];
  return blocks.map((block) => block.text ?? '').join('\n');
}

async function readTranscript(file: string): Promise<Record<string, unknown>[]> {
  const raw = await fs.readFile(file, 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('context compaction (L4c)', () => {
  it('does not spend a summarization call while the request fits', async () => {
    mocks.create.mockResolvedValue(textTurn('All set.'));
    const agent = new PalmierAgent(new EditorController());
    agent.configure({ ...CONFIG, contextWindow: 1_000_000 });

    const { callbacks, log } = recorder();
    await agent.chat('trim the intro', callbacks);

    expect(log.error).toBeNull();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.sent).toHaveLength(1);
  });

  it('replaces the backlog with a summary once the window is nearly full', async () => {
    // Turn 1 measures the real baseline; the window is then set so that the
    // measured request sits exactly at the threshold.
    mocks.create.mockResolvedValue(textTurn('All set.'));
    const agent = new PalmierAgent(new EditorController());
    agent.configure({ ...CONFIG, contextWindow: 1_000_000 });

    const first = recorder();
    await agent.chat(`trim the intro ${'x'.repeat(8_000)}`, first.callbacks);
    const baseline = agent.estimatedRequestTokens('now the head');

    mocks.create.mockImplementation(async (params: { system?: string }) => (
      typeof params.system === 'string' && params.system.includes('Compress the conversation')
        ? textTurn('NOTES: user wants the intro trimmed.')
        : textTurn('Second answer.')
    ));
    mocks.sent.length = 0;
    mocks.create.mockClear();
    agent.configure({ ...CONFIG, contextWindow: Math.floor(baseline / 0.9) - 1 });

    const second = recorder();
    await agent.chat('now the head', second.callbacks);

    expect(second.log.error).toBeNull();
    expect(second.log.completed).toBe('Second answer.');

    // The summarization call happened, and the request that followed carried
    // the summary instead of the old turns.
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.sent).toHaveLength(1);
    const sent = firstUserText(mocks.sent[0]);
    expect(sent).toContain(SUMMARY_HEADER);
    expect(sent).toContain('NOTES: user wants the intro trimmed.');
    expect(sent).not.toContain('x'.repeat(100));
  });

  it('falls back to a reset when summarization fails, and still answers', async () => {
    mocks.create.mockResolvedValue(textTurn('All set.'));
    const agent = new PalmierAgent(new EditorController());
    agent.configure({ ...CONFIG, contextWindow: 1_000_000 });

    const first = recorder();
    await agent.chat(`trim the intro ${'x'.repeat(8_000)}`, first.callbacks);
    const baseline = agent.estimatedRequestTokens('now the head');

    mocks.create.mockImplementation(async (params: { system?: string }) => {
      if (typeof params.system === 'string' && params.system.includes('Compress the conversation')) {
        throw new Error('summarizer unavailable');
      }
      return textTurn('Second answer.');
    });
    mocks.sent.length = 0;
    mocks.create.mockClear();
    agent.configure({ ...CONFIG, contextWindow: Math.floor(baseline / 0.9) - 1 });

    const second = recorder();
    await agent.chat('now the head', second.callbacks);

    expect(second.log.error).toBeNull();
    expect(second.log.completed).toBe('Second answer.');

    // Nothing of the old backlog survived, and no summary was invented.
    const sent = firstUserText(mocks.sent[0]);
    expect(sent).not.toContain(SUMMARY_HEADER);
    expect(sent).not.toContain('x'.repeat(100));
  });

  it('writes an auditable transcript including what compaction did', async () => {
    const transcriptPath = path.join(tmpDir, 'nested', 'transcript.jsonl');
    mocks.create.mockResolvedValue(textTurn('All set.'));
    const agent = new PalmierAgent(new EditorController());
    agent.configure({ ...CONFIG, contextWindow: 1_000_000, transcriptPath });

    const first = recorder();
    await agent.chat(`trim the intro ${'x'.repeat(8_000)}`, first.callbacks);
    const baseline = agent.estimatedRequestTokens('now the head');

    mocks.create.mockImplementation(async (params: { system?: string }) => (
      typeof params.system === 'string' && params.system.includes('Compress the conversation')
        ? textTurn('NOTES: keep it short.')
        : textTurn('Second answer.')
    ));
    mocks.sent.length = 0;
    mocks.create.mockClear();
    agent.configure({ ...CONFIG, contextWindow: Math.floor(baseline / 0.9) - 1, transcriptPath });

    const second = recorder();
    await agent.chat('now the head', second.callbacks);

    const entries = await readTranscript(transcriptPath);
    const events = entries.map((entry) => entry.event);
    expect(events).toContain('user');
    expect(events).toContain('assistant');
    expect(events).toContain('compaction-start');
    expect(events).toContain('compacted');
    for (const entry of entries) expect(typeof entry.ts).toBe('string');

    const start = entries.find((entry) => entry.event === 'compaction-start')!;
    expect(typeof start.estimatedTokens).toBe('number');
    expect(start.contextWindow).toBeGreaterThan(0);
  });

  it('ignores an unwritable transcript path instead of failing the turn', async () => {
    mocks.create.mockResolvedValue(textTurn('All set.'));
    const agent = new PalmierAgent(new EditorController());
    // A directory where the file should be: every append fails.
    agent.configure({ ...CONFIG, transcriptPath: tmpDir });

    const { callbacks, log } = recorder();
    await agent.chat('trim the intro', callbacks);

    expect(log.error).toBeNull();
    expect(log.completed).toBe('All set.');
  });

  it('thresholds on the same arithmetic the pure module defines', async () => {
    const agent = new PalmierAgent(new EditorController());
    agent.configure({ ...CONFIG, contextWindow: 1_000_000 });
    mocks.create.mockResolvedValue(textTurn('All set.'));
    const { callbacks } = recorder();
    await agent.chat('trim the intro', callbacks);
    expect(shouldCompact(agent.estimatedRequestTokens('trim the intro'), 1_000_000)).toBe(false);
  });
});
