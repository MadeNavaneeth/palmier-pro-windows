/**
 * Regression coverage for the Codex CLI transport (upstream #142).
 *
 * Every run below uses stubbed processes — no real CLI, no network. The fake
 * child mirrors the whisper-local stub pattern: handlers registered by the
 * runner, output emitted by the test, close driven explicitly.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  CODEX_DEFAULT_TIMEOUT_MS,
  CodexStreamAccumulator,
  buildCodexArgs,
  buildCodexPrompt,
  checkCodexAvailability,
  codexEnvelopeSchema,
  parseCodexEnvelope,
  parseCodexEventLine,
  renderCodexHistory,
  resolveCodexBinary,
  resolveCodexWorkingDir,
  runCodexCompletion,
  validateBinaryPathOverride,
  type CodexDeps,
  type SpawnedProcess,
} from './codex-cli';
import { CancelledError } from './openai-compatible';

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Arg building ───────────────────────────────────────────────────────────

describe('buildCodexArgs', () => {
  const base = { workingDir: 'C:\\media', schemaPath: 'C:\\tmp\\schema.json', outputPath: 'C:\\tmp\\out.json' };

  it('pins the non-interactive, read-only, non-approving invocation', () => {
    expect(buildCodexArgs(base)).toEqual([
      'exec',
      '--json',
      '--sandbox', 'read-only',
      '--ask-for-approval', 'never',
      '-C', 'C:\\media',
      '--skip-git-repo-check',
      '--ephemeral',
      '--output-schema', 'C:\\tmp\\schema.json',
      '-o', 'C:\\tmp\\out.json',
      '-',
    ]);
  });

  it('passes the model only when one is configured', () => {
    expect(buildCodexArgs({ ...base, model: 'gpt-5-codex' })).toContain('gpt-5-codex');
    const blank = buildCodexArgs({ ...base, model: '   ' });
    expect(blank).not.toContain('-m');
    expect(buildCodexArgs(base)).not.toContain('-m');
  });

  it('reads the prompt from stdin so long conversations fit in argv', () => {
    // `-` is the documented stdin marker (cli.rs); a compacted conversation
    // can exceed the Windows argv limit, so the prompt must never be argv.
    const args = buildCodexArgs(base);
    expect(args[args.length - 1]).toBe('-');
  });

  it('returns argv only — never a shell string', () => {
    // Spawn takes (cmd, args[]) with no shell; a single command line would be
    // the injection surface this transport must not have.
    const args = buildCodexArgs({ ...base, model: 'm' });
    expect(Array.isArray(args)).toBe(true);
    for (const arg of args) expect(typeof arg).toBe('string');
    expect(args.join(' ')).not.toMatch(/[|&;`$]/);
  });
});

// ─── Working-directory sandbox ──────────────────────────────────────────────

describe('resolveCodexWorkingDir', () => {
  it('defaults to the first allowed root', () => {
    expect(resolveCodexWorkingDir(undefined, ['C:\\media', 'C:\\data'])).toEqual({
      ok: true,
      dir: 'C:\\media',
    });
  });

  it('accepts a requested dir inside the scope', () => {
    const result = resolveCodexWorkingDir('C:\\media\\takes\\..\\takes2', ['C:\\media']);
    expect(result.ok).toBe(true);
  });

  it('refuses a requested dir outside the scope', () => {
    const result = resolveCodexWorkingDir('C:\\Windows\\System32', ['C:\\media']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/project or media/i);
  });

  it('refuses a sibling that only shares a name prefix', () => {
    const result = resolveCodexWorkingDir('C:\\media-evil', ['C:\\media']);
    expect(result.ok).toBe(false);
  });

  it('refuses when there is no scope at all', () => {
    expect(resolveCodexWorkingDir(undefined, []).ok).toBe(false);
  });
});

// ─── Binary-path validation ─────────────────────────────────────────────────

describe('validateBinaryPathOverride', () => {
  it('accepts absolute paths', () => {
    expect(validateBinaryPathOverride('C:\\Tools\\codex.exe')).toEqual({
      ok: true,
      path: 'C:\\Tools\\codex.exe',
    });
    expect(validateBinaryPathOverride('  /usr/local/bin/codex  ').ok).toBe(true);
  });

  it('refuses relative paths, blanks, and NUL bytes', () => {
    for (const raw of ['codex', '.\\codex.exe', '', '   ', 'C:\\bin\0codex']) {
      const result = validateBinaryPathOverride(raw);
      expect(result.ok, String(raw)).toBe(false);
    }
  });
});

// ─── JSONL streaming parse ──────────────────────────────────────────────────

function agentMessage(text: string): string {
  return JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } });
}

describe('parseCodexEventLine', () => {
  it('reads agent message text as stream tokens', () => {
    expect(parseCodexEventLine(agentMessage('hello'))).toEqual({ kind: 'token', text: 'hello' });
  });

  it('ignores non-prose items and lifecycle events', () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
      JSON.stringify({ type: 'item.started', item: { id: 'i', type: 'reasoning', text: 'hmm' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: 0, status: 'completed' } }),
      JSON.stringify({ type: 'whatever-new-in-v2', payload: 1 }),
      '',
      '   ',
    ];
    for (const line of lines) {
      expect(parseCodexEventLine(line), line).toEqual({ kind: 'ignored' });
    }
  });

  it('surfaces turn failures and stream errors with their message', () => {
    expect(parseCodexEventLine(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } })))
      .toEqual({ kind: 'turn-error', message: 'boom' });
    expect(parseCodexEventLine(JSON.stringify({ type: 'error', message: 'fatal' })))
      .toEqual({ kind: 'turn-error', message: 'fatal' });
  });

  it('counts malformed lines instead of throwing', () => {
    for (const line of ['not json', '{oops', '42', 'null', '[1]']) {
      expect(parseCodexEventLine(line), line).toEqual({ kind: 'malformed' });
    }
  });
});

describe('CodexStreamAccumulator', () => {
  it('emits only the unseen extension of replayed messages', () => {
    const stream = new CodexStreamAccumulator();
    stream.pushChunk(`${agentMessage('hello')}\n${agentMessage('hello world')}\n`);
    expect(stream.tokens).toEqual(['hello', ' world']);
    expect(stream.lastAgentText).toBe('hello world');
  });

  it('handles chunks split mid-line', () => {
    const stream = new CodexStreamAccumulator();
    const line = `${agentMessage('split me')}\n`;
    stream.pushChunk(line.slice(0, 10));
    stream.pushChunk(line.slice(10));
    expect(stream.tokens).toEqual(['split me']);
  });

  it('tolerates malformed lines and records a turn error', () => {
    const stream = new CodexStreamAccumulator();
    stream.pushChunk(`garbage\n${JSON.stringify({ type: 'turn.failed', error: { message: 'nope' } })}\n`);
    expect(stream.malformedLines).toBe(1);
    expect(stream.turnError).toBe('nope');
  });
});

// ─── Envelope ───────────────────────────────────────────────────────────────

describe('codexEnvelopeSchema', () => {
  it('constrains the final message to the strict tool-loop envelope', () => {
    const schema = codexEnvelopeSchema([{ name: 'undo', description: 'Undo.' }]) as {
      properties: { tool_calls: { items: { properties: { name: { enum: string[] } } } } };
      required: string[];
    };
    expect(schema.required).toEqual(['content', 'tool_calls']);
    expect(schema.properties.tool_calls.items.properties.name.enum).toEqual(['undo']);
  });
});

describe('parseCodexEnvelope', () => {
  it('reads content and tool calls, assigning ids in order', () => {
    const parsed = parseCodexEnvelope(JSON.stringify({
      content: 'Let me look.',
      tool_calls: [
        { name: 'get_timeline', arguments: '{"a":1}' },
        { name: 'undo', arguments: { nested: true } },
      ],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.content).toBe('Let me look.');
    expect(parsed.envelope.toolCalls).toEqual([
      { id: 'codex_0', name: 'get_timeline', argumentsJson: '{"a":1}' },
      { id: 'codex_1', name: 'undo', argumentsJson: '{"nested":true}' },
    ]);
  });

  it('accepts a final answer with no tool calls', () => {
    const parsed = parseCodexEnvelope(JSON.stringify({ content: 'done', tool_calls: [] }));
    expect(parsed.ok && parsed.envelope.toolCalls).toEqual([]);
  });

  it('skips nameless calls and coerces missing arguments', () => {
    const parsed = parseCodexEnvelope(JSON.stringify({
      content: '',
      tool_calls: [{ name: '' }, {}, { name: 'undo' }],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.toolCalls).toEqual([
      { id: 'codex_0', name: 'undo', argumentsJson: '' },
    ]);
  });

  it('refuses empty, non-JSON, and shapeless finals', () => {
    for (const text of ['', '   ', 'plain prose', '[1,2]', '"str"', '{"nope":1}']) {
      expect(parseCodexEnvelope(text).ok, text).toBe(false);
    }
  });
});

describe('prompt building', () => {
  it('carries system, tools, history, and the message', () => {
    const prompt = buildCodexPrompt({
      system: 'SYS',
      history: 'User: hi',
      userMessage: 'do it',
      tools: [{ name: 'undo', description: 'Undo.' }],
    });
    expect(prompt).toContain('SYS');
    expect(prompt).toContain('undo: Undo.');
    expect(prompt).toContain('User: hi');
    expect(prompt).toContain('do it');
  });

  it('renders history as plain role lines, dropping tool blocks', () => {
    expect(renderCodexHistory([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_result', content: 'x' }] },
      { role: 'system', content: 'skip me' },
      { role: 'user', content: '' },
    ])).toBe('User: hi\n\nAssistant: ok');
    expect(renderCodexHistory([])).toBe('');
  });
});

// ─── Binary discovery ───────────────────────────────────────────────────────

describe('resolveCodexBinary', () => {
  it('refuses an override that is not a real file', async () => {
    const deps: CodexDeps = { isFile: async () => false };
    const result = await resolveCodexBinary('C:\\Tools\\codex.exe', deps);
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/C:\\Tools\\codex\.exe/);
  });

  it('refuses a malformed override without touching the filesystem', async () => {
    const isFile = vi.fn(async () => true);
    const result = await resolveCodexBinary('relative\\codex.exe', { isFile });
    expect(result.available).toBe(false);
    expect(isFile).not.toHaveBeenCalled();
  });

  it('reports the version when the binary answers', async () => {
    const deps: CodexDeps = {
      isFile: async () => true,
      runVersion: async () => ({ exitCode: 0, stdout: 'codex-cli 0.44.0\n' }),
    };
    const result = await resolveCodexBinary('C:\\Tools\\codex.exe', deps);
    expect(result).toMatchObject({ available: true, binaryPath: 'C:\\Tools\\codex.exe', version: 'codex-cli 0.44.0' });
  });

  it('refuses when the version probe fails or is empty', async () => {
    const isFile = async () => true;
    for (const runVersion of [
      async () => ({ exitCode: 1, stdout: '' }),
      async () => ({ exitCode: 0, stdout: '   \n' }),
      async () => { throw new Error('spawn ENOENT'); },
    ]) {
      const result = await resolveCodexBinary('C:\\Tools\\codex.exe', { isFile, runVersion });
      expect(result.available).toBe(false);
      expect(result.reason!.length).toBeGreaterThan(0);
    }
  });

  it('falls back to PATH, refusing precisely when absent', async () => {
    const missing = await checkCodexAvailability(undefined, { findOnPath: async () => null });
    expect(missing.available).toBe(false);
    expect(missing.reason).toMatch(/not found on PATH/i);
    expect(missing.reason).toMatch(/npm install/);

    const found = await checkCodexAvailability(undefined, {
      findOnPath: async () => 'C:\\bin\\codex.exe',
      runVersion: async () => ({ exitCode: 0, stdout: 'codex-cli 1.0.0' }),
    });
    expect(found).toMatchObject({ available: true, binaryPath: 'C:\\bin\\codex.exe' });
  });

  it('never mentions credentials in a refusal', async () => {
    const result = await checkCodexAvailability(undefined, { findOnPath: async () => null });
    expect(result.reason).not.toMatch(/sk-|key|token|secret/i);
  });
});

// ─── Run harness (stub process) ─────────────────────────────────────────────

class FakeStdin {
  written: string[] = [];
  ended = false;
  write(chunk: string): void {
    this.written.push(chunk);
  }
  end(): void {
    this.ended = true;
  }
}

class FakeEmitter {
  private handlers = new Map<string, ((chunk: string) => void)[]>();
  on(event: 'data', cb: (chunk: string) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  emit(chunk: string): void {
    for (const cb of this.handlers.get('data') ?? []) cb(chunk);
  }
}

class FakeProcess implements SpawnedProcess {
  readonly stdin = new FakeStdin();
  readonly stdout = new FakeEmitter();
  readonly stderr = new FakeEmitter();
  killed = false;
  private handlers = new Map<string, ((a?: unknown, b?: unknown) => void)[]>();
  armed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  on(event: 'error' | 'close', cb: (a?: unknown, b?: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    if (event === 'close') this.armed = true;
  }
  emitStdout(chunk: string): void {
    this.stdout.emit(chunk);
  }
  emitStderr(chunk: string): void {
    this.stderr.emit(chunk);
  }
  close(code: number): void {
    for (const cb of this.handlers.get('close') ?? []) cb(code, null);
  }
}

async function armed(fake: FakeProcess): Promise<void> {
  for (let i = 0; i < 200 && !fake.armed; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!fake.armed) throw new Error('stub process was never armed');
}

function successDeps(fake: FakeProcess, envelope: string) {
  const seen: { cmd: string; args: string[]; options: { cwd: string } }[] = [];
  const files = new Map<string, string>();
  const deps: CodexDeps = {
    isFile: async () => true,
    runVersion: async () => ({ exitCode: 0, stdout: 'codex-cli 1.0.0' }),
    dirExists: async () => true,
    spawnFn: (cmd, args, options) => {
      seen.push({ cmd, args, options });
      return fake;
    },
    writeFile: async (filePath, content) => {
      files.set(filePath, content);
    },
    readFile: async () => envelope,
    removeFile: async (filePath) => {
      files.delete(filePath);
    },
    makeTempDir: async () => 'C:\\tmp\\palmier-codex-test',
  };
  return { seen, files, deps };
}

const BASE_REQUEST = {
  // Every stub run resolves this override via the injected isFile — no test
  // below touches the real PATH unless it says so.
  binaryPath: 'C:\\Tools\\codex.exe',
  workingDir: 'C:\\media',
  system: 'SYS',
  history: '',
  userMessage: 'do it',
  tools: [{ name: 'undo', description: 'Undo.' }],
};

describe('runCodexCompletion (stub process)', () => {
  it('spawns argv-only in the sandbox dir and feeds the prompt on stdin', async () => {
    const fake = new FakeProcess();
    const { seen, deps } = successDeps(fake, JSON.stringify({ content: 'done', tool_calls: [] }));
    const pending = runCodexCompletion({ ...BASE_REQUEST, binaryPath: 'C:\\Tools\\codex.exe', model: 'gpt-x' }, deps);
    await armed(fake);
    fake.close(0);
    const result = await pending;
    expect(result).toEqual({ content: 'done', toolCalls: [], wantsTools: false });
    expect(seen).toHaveLength(1);
    // Binary and argv travel separately — no shell, no command line.
    expect(seen[0]!.cmd).toBe('C:\\Tools\\codex.exe');
    expect(seen[0]!.args).toContain('--sandbox');
    expect(seen[0]!.args).toContain('read-only');
    expect(seen[0]!.args).toContain('never');
    expect(seen[0]!.args).toContain('gpt-x');
    // No credentials travel with the child: only the working directory.
    expect(Object.keys(seen[0]!.options)).toEqual(['cwd']);
    expect(seen[0]!.options.cwd).toBe('C:\\media');
    const prompt = fake.stdin.written.join('');
    expect(prompt).toContain('SYS');
    expect(prompt).toContain('do it');
    expect(fake.stdin.ended).toBe(true);
  });

  it('streams stdout incrementally and returns tool calls', async () => {
    const fake = new FakeProcess();
    const envelope = JSON.stringify({
      content: 'Looking.',
      tool_calls: [{ name: 'get_timeline', arguments: '{}' }],
    });
    const { deps } = successDeps(fake, envelope);
    const tokens: string[] = [];
    const pending = runCodexCompletion({ ...BASE_REQUEST, onToken: (token) => tokens.push(token) }, deps);
    await armed(fake);
    fake.emitStdout(`${agentMessage('Look')}\n`);
    fake.emitStdout(`${agentMessage('Looking.')}\n`);
    fake.close(0);
    const result = await pending;
    // Only the unseen extension is forwarded per progress event.
    expect(tokens.join('')).toBe('Looking.');
    expect(result.wantsTools).toBe(true);
    expect(result.toolCalls).toEqual([
      { id: 'codex_0', name: 'get_timeline', argumentsJson: '{}' },
    ]);
  });

  it('falls back to streamed text when the output file is missing', async () => {
    const fake = new FakeProcess();
    const { deps } = successDeps(fake, '');
    deps.readFile = async () => { throw new Error('ENOENT'); };
    const pending = runCodexCompletion(BASE_REQUEST, deps);
    await armed(fake);
    // An older CLI without `-o`: the final agent message still carries JSON.
    fake.emitStdout(`${agentMessage(JSON.stringify({ content: 'fb', tool_calls: [] }))}\n`);
    fake.close(0);
    expect(await pending).toMatchObject({ content: 'fb' });
  });

  it('refuses before spawning when the binary is missing', async () => {
    const spawnFn = vi.fn(() => new FakeProcess());
    await expect(runCodexCompletion({ ...BASE_REQUEST, binaryPath: undefined }, {
      findOnPath: async () => null,
      dirExists: async () => true,
      spawnFn,
    })).rejects.toThrow(/not found on PATH/i);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('refuses before spawning when the working dir is gone', async () => {
    const spawnFn = vi.fn(() => new FakeProcess());
    await expect(runCodexCompletion(BASE_REQUEST, {
      isFile: async () => true,
      runVersion: async () => ({ exitCode: 0, stdout: 'v' }),
      dirExists: async () => false,
      spawnFn,
    })).rejects.toThrow(/working directory/i);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('reports a non-zero exit with the stderr tail, never the prompt', async () => {
    const fake = new FakeProcess();
    const { deps } = successDeps(fake, '');
    const pending = runCodexCompletion({ ...BASE_REQUEST, userMessage: 's3cr3t-plans' }, deps);
    await armed(fake);
    fake.emitStderr('config error: something failed\n');
    fake.close(1);
    const error: Error = await pending.then(
      () => new Error('expected rejection'),
      (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    );
    expect(error.message).toMatch(/exited with code 1/);
    expect(error.message).toContain('something failed');
    expect(error.message).not.toContain('s3cr3t-plans');
  });

  it('times out on a hung child, killing the stub', async () => {
    const fake = new FakeProcess();
    const { deps } = successDeps(fake, '');
    await expect(runCodexCompletion({ ...BASE_REQUEST, timeoutMs: 20 }, deps))
      .rejects.toThrow(/did not respond within/);
    expect(fake.killed).toBe(true);
  }, 10_000);

  it('cancellation kills the stub and reports distinctly', async () => {
    const fake = new FakeProcess();
    const { deps } = successDeps(fake, '');
    const controller = new AbortController();
    const pending = runCodexCompletion({ ...BASE_REQUEST, signal: controller.signal, timeoutMs: 60_000 }, deps);
    await armed(fake);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(fake.killed).toBe(true);
  });

  it('refuses an already-stopped request without spawning', async () => {
    const spawnFn = vi.fn(() => new FakeProcess());
    const controller = new AbortController();
    controller.abort();
    await expect(runCodexCompletion(
      { ...BASE_REQUEST, signal: controller.signal },
      { spawnFn },
    )).rejects.toBeInstanceOf(CancelledError);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('has a bounded default timeout', () => {
    expect(CODEX_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(CODEX_DEFAULT_TIMEOUT_MS)).toBe(true);
  });
});
