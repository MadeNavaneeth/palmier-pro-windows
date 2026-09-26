/**
 * Codex CLI completion backend (upstream issue #142).
 *
 * The provider registry from #17/#140 covers HTTP endpoints only. This module
 * adds the CLI-subprocess transport: the `codex` binary is spawned per tool
 * round, streamed as JSONL, and parsed back into the same completion shape the
 * HTTP providers share — so the agent loop, the ToolExecutor, and the undo
 * contract are identical whichever provider is configured.
 *
 * Integration choice: the CLI acts as a *completion backend* inside our
 * audited tool loop, NOT as its own agent. `codex exec` runs its own agentic
 * loop (shell/file/MCP tools) when left alone, which would edit outside the
 * ToolExecutor, outside undo, and outside the preview/export eligibility
 * rules — against the repo's agentic rules (one authoritative project owner,
 * one user action is one undo). It is therefore pinned to
 * `--sandbox read-only --ask-for-approval never`: it cannot touch the disk or
 * the network on its own behalf, and every edit flows through our tools.
 *
 * Verified CLI surface (openai/codex, main branch; no binary on this box, so
 * every flag below is pinned to source, not to observed behavior):
 * - `codex exec [OPTIONS] [PROMPT]` — non-interactive entry
 *   (`codex-rs/exec/src/cli.rs`, `override_usage`).
 * - `--json` (alias `--experimental-json`) — JSONL thread events on stdout
 *   (`cli.rs`); event/item shapes from `codex-rs/exec/src/exec_events.rs`:
 *   `thread.started`, `turn.started`, `turn.completed {usage}`,
 *   `turn.failed {error: {message}}`, `item.started|updated|completed`
 *   carrying `{item: {id, type, ...}}` with `agent_message {text}` /
 *   `reasoning {text}` payloads, and top-level `error {message}`.
 * - `-m/--model`, `-s/--sandbox read-only|workspace-write|danger-full-access`
 *   (`sandbox_mode_cli_arg.rs`), `--ask-for-approval` with `never`,
 *   `-C/--cd DIR`, `--add-dir DIR`, `-c/--config key=value`
 *   (`shared_options.rs` + CLI reference).
 * - `--skip-git-repo-check`, `--ephemeral` (no session rollout files),
 *   `--output-schema FILE` (final message validated against the schema —
 *   "a JSON string when structured output is requested", `exec_events.rs`),
 *   `-o/--output-last-message FILE` (final message to a file), `--color`
 *   (`cli.rs`).
 * - Prompt `-` reads instructions from stdin (`cli.rs` doc comment) — used
 *   here because a compacted conversation can exceed the Windows argv limit.
 * - Auth is the user's own login (ChatGPT sign-in or API key, cached under
 *   `~/.codex/auth.json`, `%USERPROFILE%\.codex` on Windows). This module
 *   never accepts, passes, logs, or persists credentials: the child inherits
 *   the environment untouched and no key material ever appears in argv,
 *   prompts, temp files, or error text.
 *
 * Deliberately NOT used: `--full-auto` (seen in older docs/threads but absent
 * from the current `cli.rs`, so its meaning is version-dependent) and
 * `--dangerously-bypass-approvals-and-sandbox` (removes the boundary this
 * module depends on).
 *
 * No numeric minimum CLI version is enforced: the flags above span several
 * releases and no single floor is verifiable from source. Availability means
 * the binary resolves and `codex --version` exits 0; anything else is a
 * precise refusal naming the cause.
 */

import { execFile, spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CancelledError } from './openai-compatible';

/** Bounded run, matching the HTTP transport's default ceiling. */
export const CODEX_DEFAULT_TIMEOUT_MS = 120_000;

/** Version probe timeout: `codex --version` is local and instant when healthy. */
export const CODEX_VERSION_TIMEOUT_MS = 10_000;

/** Cap on buffered child output; the stream is parsed incrementally. */
const MAX_BUFFERED_OUTPUT = 4_096_000;

/** Stderr tail kept for failure messages (paths and exit codes only). */
const STDERR_TAIL_CHARS = 32_768;

/** Stderr tail length echoed into a failure message. */
const ERROR_TAIL_CHARS = 500;

// ─── Completion shape (mirrors the HTTP providers) ──────────────────────────

export interface CodexToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments string; the caller parses it like the HTTP path. */
  argumentsJson: string;
}

export interface CodexCompletionResult {
  content: string;
  toolCalls: CodexToolCall[];
  wantsTools: boolean;
}

export interface CodexToolSchema {
  name: string;
  description: string;
}

// ─── Binary-path validation ─────────────────────────────────────────────────

/**
 * Shape check for an explicit binary override, shared with settings.
 *
 * Pure (no fs): existence is checked in the main process at resolve time.
 * The value must be an absolute file path — never a command line, so there is
 * nothing to interpret as a shell string at spawn time.
 */
export type BinaryPathValidation =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export function validateBinaryPathOverride(raw: unknown): BinaryPathValidation {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: 'Enter the full path to the codex binary.' };
  }
  const trimmed = raw.trim();
  if (trimmed.includes('\0')) {
    return { ok: false, reason: 'The binary path contains an invalid character.' };
  }
  const absolute = path.win32.isAbsolute(trimmed) || path.posix.isAbsolute(trimmed);
  if (!absolute) {
    return { ok: false, reason: 'The binary path must be absolute, e.g. C:\\Tools\\codex.exe.' };
  }
  return { ok: true, path: trimmed };
}

// ─── Working-directory sandbox ──────────────────────────────────────────────

/**
 * Resolve the CLI working directory (`-C`) inside an allowed scope.
 *
 * The caller (IPC) supplies the project/media roots; anything outside them is
 * refused rather than clamped, so a misconfiguration surfaces instead of
 * silently running the agent somewhere unintended. `requested` is currently
 * always undefined — there is no user setting for it — but the seam keeps the
 * containment check in one place when one arrives.
 */
export type WorkingDirValidation =
  | { ok: true; dir: string }
  | { ok: false; reason: string };

export function resolveCodexWorkingDir(
  requested: string | undefined,
  allowedRoots: readonly string[],
): WorkingDirValidation {
  const roots = allowedRoots
    .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
    .map((root) => path.resolve(root));
  if (roots.length === 0) {
    return { ok: false, reason: 'Codex CLI has no working directory scope to run in.' };
  }
  if (requested !== undefined) {
    const candidate = path.resolve(requested);
    const contained = roots.some((root) => {
      if (candidate === root) return true;
      const rel = path.relative(root, candidate);
      // `path.relative` returns an absolute path when the roots span drives
      // on Windows, which is also "outside".
      return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (!contained) {
      return { ok: false, reason: 'The Codex working directory must stay inside the project or media folders.' };
    }
    return { ok: true, dir: candidate };
  }
  // Default scope: the first allowed root (the caller orders them —
  // project/media directories first, app data last).
  return { ok: true, dir: roots[0]! };
}

// ─── Arg building ───────────────────────────────────────────────────────────

export interface CodexArgsOptions {
  /** Model override (`-m`); omitted when the CLI default should apply. */
  model?: string;
  /** Sandboxed working root (`-C`). Must already be resolved. */
  workingDir: string;
  /** Strict JSON Schema file the final message must match. */
  schemaPath: string;
  /** File the final message is written to. */
  outputPath: string;
}

/**
 * Exact argv for one non-interactive run. Array form only — spawned with
 * `shell: false`, so no element is ever interpreted as a command line.
 * The prompt travels on stdin (positional `-`); see `buildCodexPrompt`.
 */
export function buildCodexArgs(options: CodexArgsOptions): string[] {
  const args = [
    'exec',
    '--json',
    '--sandbox', 'read-only',
    '--ask-for-approval', 'never',
    '-C', options.workingDir,
    '--skip-git-repo-check',
    '--ephemeral',
  ];
  const model = options.model?.trim();
  if (model) args.push('-m', model);
  args.push('--output-schema', options.schemaPath, '-o', options.outputPath, '-');
  return args;
}

// ─── Prompt and envelope schema ─────────────────────────────────────────────

const ENVELOPE_INSTRUCTION = [
  'Reply with a single JSON object and nothing else, matching this shape:',
  '{"content": "assistant text for the user", "tool_calls": [{"name": "tool_name", "arguments": "{\\"arg\\": value}"}]}',
  'Rules: content holds any prose for the user (may be empty when you call tools).',
  'To call tools, list them in tool_calls with arguments as a JSON-encoded string; omit tool_calls or use [] for a final answer.',
  'Only use the tools below. Never invent tool names.',
].join('\n');

/**
 * Strict JSON Schema (additionalProperties false throughout, all fields
 * required) constraining the final message to the tool-loop envelope.
 * `arguments` stays a JSON-encoded *string* so per-tool argument shapes do
 * not have to be enumerated — the existing parse-then-validate path handles
 * them, including the #471 null-drop.
 */
export function codexEnvelopeSchema(tools: readonly CodexToolSchema[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      content: { type: 'string' },
      tool_calls: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: tools.length > 0
              ? { type: 'string', enum: tools.map((tool) => tool.name) }
              : { type: 'string' },
            arguments: { type: 'string' },
          },
          required: ['name', 'arguments'],
          additionalProperties: false,
        },
      },
    },
    required: ['content', 'tool_calls'],
    additionalProperties: false,
  };
}

/**
 * Prior turns as plain text for the prompt.
 *
 * Same filtering as the OpenAI path's history: only user/assistant prose
 * carries across (provider-internal tool blocks do not), read out of block
 * arrays as well as plain strings.
 */
export function renderCodexHistory(entries: readonly unknown[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { role?: unknown; content?: unknown };
    const role = record.role === 'assistant' ? 'Assistant' : record.role === 'user' ? 'User' : null;
    if (!role) continue;
    const text = historyTextOf(record.content);
    if (text.length === 0) continue;
    lines.push(`${role}: ${text}`);
  }
  return lines.join('\n\n');
}

function historyTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => {
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate?.type === 'text' && typeof candidate.text === 'string';
    })
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** One prompt carrying system contract, tools, history, and the new message. */
export function buildCodexPrompt(input: {
  system: string;
  history: string;
  userMessage: string;
  tools: readonly CodexToolSchema[];
}): string {  const catalog = input.tools.length > 0
    ? input.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')
    : '(no tools available — answer directly)';
  return [
    input.system,
    '',
    '## Tools',
    catalog,
    '',
    ENVELOPE_INSTRUCTION,
    input.history ? `\n## Conversation so far\n${input.history}` : '',
    `\n## User\n${input.userMessage}`,
  ].join('\n');
}

// ─── JSONL streaming parse ──────────────────────────────────────────────────

export type CodexStreamEvent =
  | { kind: 'token'; text: string }
  | { kind: 'turn-error'; message: string }
  | { kind: 'ignored' }
  | { kind: 'malformed' };

/**
 * Classify one JSONL line by the upstream `ThreadEvent` schema
 * (`codex-rs/exec/src/exec_events.rs`). Unknown `type` values and unknown
 * item shapes are ignored, not errors: the schema is version-dependent, and
 * the authoritative answer comes from the `-o` file, not the stream.
 */
export function parseCodexEventLine(line: string): CodexStreamEvent {
  if (line.trim().length === 0) return { kind: 'ignored' };
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return { kind: 'malformed' };
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return { kind: 'malformed' };
  const record = event as { type?: unknown; item?: unknown; error?: unknown; message?: unknown };
  if (record.type === 'error') {
    const message = errorMessageOf(record);
    return { kind: 'turn-error', message: message || 'Codex CLI reported an error.' };
  }
  if (record.type === 'turn.failed') {
    const message = errorMessageOf(record.error) || errorMessageOf(record);
    return { kind: 'turn-error', message: message || 'The Codex turn failed.' };
  }
  if (record.type === 'item.started' || record.type === 'item.updated' || record.type === 'item.completed') {
    const text = agentMessageTextOf(record.item);
    return text !== null ? { kind: 'token', text } : { kind: 'ignored' };
  }
  return { kind: 'ignored' };
}

function errorMessageOf(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value !== 'object' || value === null) return null;
  const message = (value as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : null;
}

/** Text of an `agent_message` item; every other item kind carries no prose. */
function agentMessageTextOf(item: unknown): string | null {
  if (typeof item !== 'object' || item === null) return null;
  const details = item as { type?: unknown; text?: unknown };
  if (details.type !== 'agent_message') return null;
  return typeof details.text === 'string' && details.text.length > 0 ? details.text : null;
}

/**
 * Incremental consumer of the `--json` stream.
 *
 * `item.updated` replays the whole message-so-far rather than a delta, so
 * only the unseen extension past the longest forwarded prefix is emitted —
 * otherwise every progress event would duplicate the transcript. A text that
 * does not extend the prefix resets it (a new message started).
 */
export class CodexStreamAccumulator {
  private buffer = '';
  private forwardedPrefix = '';
  readonly tokens: string[] = [];
  turnError: string | null = null;
  malformedLines = 0;
  sawTurnCompleted = false;
  /** Latest full agent message, backing the `-o` fallback. */
  lastAgentText = '';

  pushChunk(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFERED_OUTPUT) {
      this.buffer = this.buffer.slice(-MAX_BUFFERED_OUTPUT);
    }
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      this.pushLine(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
    }
  }

  /** Classify any trailing partial line at process end. */
  flush(): void {
    if (this.buffer.trim().length > 0) this.pushLine(this.buffer);
    this.buffer = '';
  }

  private pushLine(line: string): void {
    const event = parseCodexEventLine(line);
    if (event.kind === 'malformed') {
      this.malformedLines += 1;
      return;
    }
    if (event.kind === 'turn-error' && this.turnError === null) {
      this.turnError = event.message;
      return;
    }
    if (event.kind !== 'token') {
      if (line.includes('"turn.completed"')) this.sawTurnCompleted = true;
      return;
    }
    this.lastAgentText = event.text;
    if (event.text.startsWith(this.forwardedPrefix)) {
      const extension = event.text.slice(this.forwardedPrefix.length);
      this.forwardedPrefix = event.text;
      if (extension.length > 0) this.tokens.push(extension);
    } else {
      this.forwardedPrefix = event.text;
      this.tokens.push(event.text);
    }
  }
}

// ─── Envelope parse ─────────────────────────────────────────────────────────

export interface CodexEnvelope {
  content: string;
  /** Ids are assigned in call order, never trusted from the CLI. */
  toolCalls: { id: string; name: string; argumentsJson: string }[];
}

export type EnvelopeValidation =
  | { ok: true; envelope: CodexEnvelope }
  | { ok: false; reason: string };

/**
 * Read the final message (the `-o` file, or the streamed agent text as
 * fallback) as the tool-loop envelope. Shape-checked because the CLI is an
 * external process whose output is untrusted input; unknown tool names are
 * kept — the executor refuses those, same as the HTTP path.
 */
export function parseCodexEnvelope(text: string, idPrefix = 'codex'): EnvelopeValidation {
  if (text.trim().length === 0) {
    return { ok: false, reason: 'Codex CLI returned an empty final message.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'Codex CLI returned a final message that is not JSON. Try again.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'Codex CLI returned a final message with an unexpected shape.' };
  }
  const record = parsed as { content?: unknown; tool_calls?: unknown };
  if (typeof record.content !== 'string') {
    return { ok: false, reason: 'Codex CLI returned a final message without text content.' };
  }
  const rawCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
  const toolCalls: { name: string; argumentsJson: string }[] = [];
  for (const raw of rawCalls) {
    const call = raw as { name?: unknown; arguments?: unknown };
    if (typeof call.name !== 'string' || call.name.length === 0) continue;
    let argumentsJson = '';
    if (typeof call.arguments === 'string') {
      argumentsJson = call.arguments;
    } else if (typeof call.arguments === 'object' && call.arguments !== null) {
      try {
        argumentsJson = JSON.stringify(call.arguments);
      } catch {
        argumentsJson = '';
      }
    }
    toolCalls.push({ name: call.name, argumentsJson });
  }
  // Ids are assigned here (not trusted from the CLI) in call order.
  const withIds = toolCalls.map((call, index) => ({
    id: `${idPrefix}_${index}`,
    name: call.name,
    argumentsJson: call.argumentsJson,
  }));
  return { ok: true, envelope: { content: record.content, toolCalls: withIds } };
}

// ─── Binary discovery ───────────────────────────────────────────────────────

export interface CodexDeps {
  findOnPath?: () => Promise<string | null>;
  runVersion?: (binary: string) => Promise<{ exitCode: number; stdout: string }>;
  isFile?: (candidate: string) => Promise<boolean>;
  spawnFn?: (cmd: string, args: string[], options: { cwd: string }) => SpawnedProcess;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  readFile?: (filePath: string) => Promise<string>;
  removeFile?: (filePath: string) => Promise<void>;
  makeTempDir?: () => Promise<string>;
  dirExists?: (dir: string) => Promise<boolean>;
}

/** Minimal child handle; argv form makes a shell string structurally impossible. */
export interface SpawnedProcess {
  stdin?: { write(chunk: string): void; end(): void };
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void };
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void };
  on(event: 'error' | 'close', cb: (a?: unknown, b?: unknown) => void): void;
  kill(signal?: string): boolean;
  killed: boolean;
}

async function defaultFindOnPath(): Promise<string | null> {
  // Same seam as the whisper binary probe: `where` on Windows, `which`
  // elsewhere, argv form, no shell.
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(locator, ['codex'], (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

function defaultRunVersion(binary: string): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: CODEX_VERSION_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve({ exitCode: typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code : 1, stdout: String(stdout ?? '') });
        return;
      }
      resolve({ exitCode: 0, stdout: String(stdout ?? '') });
    });
  });
}

async function defaultIsFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

function defaultSpawnFn(cmd: string, args: string[], options: { cwd: string }): SpawnedProcess {
  // windowsHide keeps a console window from flashing on Windows; stdio pipes
  // carry the prompt in and the JSONL stream out. No `shell` — argv only.
  return spawn(cmd, args, {
    windowsHide: true,
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as SpawnedProcess;
}

export interface CodexBinary {
  available: boolean;
  binaryPath: string | null;
  /** Raw `codex --version` output, when the probe succeeded. */
  version: string | null;
  /** Precise refusal when unavailable: install hint, never a stack trace. */
  reason: string | null;
}

const INSTALL_HINT = 'Install it from https://github.com/openai/codex (npm: npm install -g @openai/codex), '
  + 'make sure `codex` is on PATH, and complete the login the CLI asks for — '
  + 'Palmier uses your own Codex sign-in and never sees its credentials.';

/**
 * Resolve the binary: an explicit override wins when it is a real file,
 * otherwise PATH. An override pointing nowhere is a refusal naming the path,
 * not a silent fallthrough to PATH — falling through would run a different
 * binary than the user pointed at.
 */
export async function resolveCodexBinary(
  override: string | undefined,
  deps: CodexDeps = {},
): Promise<CodexBinary> {
  const isFile = deps.isFile ?? defaultIsFile;
  if (typeof override === 'string' && override.trim().length > 0) {
    const checked = validateBinaryPathOverride(override);
    if (!checked.ok) {
      return { available: false, binaryPath: null, version: null, reason: checked.reason };
    }
    if (!(await isFile(checked.path))) {
      return {
        available: false,
        binaryPath: null,
        version: null,
        reason: `The configured Codex binary was not found at "${checked.path}". Fix the path in AI settings or clear it to use PATH.`,
      };
    }
    return checkCodexVersion(checked.path, deps);
  }
  const onPath = await (deps.findOnPath ?? defaultFindOnPath)();
  if (!onPath) {
    return {
      available: false,
      binaryPath: null,
      version: null,
      reason: `Codex CLI was not found on PATH. ${INSTALL_HINT}`,
    };
  }
  return checkCodexVersion(onPath, deps);
}

async function checkCodexVersion(binary: string, deps: CodexDeps): Promise<CodexBinary> {
  let probe: { exitCode: number; stdout: string };
  try {
    probe = await (deps.runVersion ?? defaultRunVersion)(binary);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      binaryPath: null,
      version: null,
      reason: `Could not run "${binary} --version": ${detail}`,
    };
  }
  if (probe.exitCode !== 0) {
    return {
      available: false,
      binaryPath: null,
      version: null,
      reason: `"${binary} --version" failed (exit ${probe.exitCode}). Reinstall the Codex CLI: ${INSTALL_HINT}`,
    };
  }
  const version = probe.stdout.trim();
  if (version.length === 0) {
    return {
      available: false,
      binaryPath: null,
      version: null,
      reason: `"${binary} --version" returned no version string. Reinstall the Codex CLI: ${INSTALL_HINT}`,
    };
  }
  return { available: true, binaryPath: binary, version, reason: null };
}

/** Availability snapshot for the settings UI and the pre-turn gate. */
export function checkCodexAvailability(
  override: string | undefined,
  deps: CodexDeps = {},
): Promise<CodexBinary> {
  return resolveCodexBinary(override, deps);
}

// ─── One completion round ───────────────────────────────────────────────────

export interface CodexCompletionRequest {
  binaryPath?: string;
  /** Explicit override; validated as a file path, never a shell string. */
  model?: string;
  /** Pre-resolved sandbox root for `-C`. */
  workingDir: string;
  system: string;
  history: string;
  userMessage: string;
  tools: readonly CodexToolSchema[];
  maxTokens?: number;
  timeoutMs?: number;
  /** User stop: kills the child, leaving no orphan. */
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}

function stderrTail(stderr: string): string {
  return stderr.slice(-STDERR_TAIL_CHARS).replace(/\s+/g, ' ').trim();
}

/**
 * Run one non-interactive completion: spawn, stream, parse.
 *
 * Returns the HTTP-shaped result so the agent loop needs no second code path.
 * Temp files (schema + final message) live under the OS temp dir and are
 * removed on every path, including timeout and cancellation.
 */
export async function runCodexCompletion(
  request: CodexCompletionRequest,
  deps: CodexDeps = {},
): Promise<CodexCompletionResult> {
  if (request.signal?.aborted) throw new CancelledError();

  const dirCheck = resolveCodexWorkingDir(request.workingDir, [request.workingDir]);
  if (!dirCheck.ok) throw new Error(dirCheck.reason);
  const dirExists = deps.dirExists ?? (async (dir: string) => {
    try {
      const stat = await fs.stat(dir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  });
  if (!(await dirExists(dirCheck.dir))) {
    throw new Error(`The Codex working directory "${dirCheck.dir}" does not exist.`);
  }

  const binary = await resolveCodexBinary(request.binaryPath, deps);
  if (!binary.available || !binary.binaryPath) {
    throw new Error(binary.reason ?? 'Codex CLI is not available.');
  }

  const writeFile = deps.writeFile ?? ((filePath: string, content: string) => fs.writeFile(filePath, content, 'utf8'));
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFile(filePath, 'utf8'));
  const removeFile = deps.removeFile ?? ((filePath: string) => fs.rm(filePath, { force: true }));
  const makeTempDir = deps.makeTempDir ?? (() => fs.mkdtemp(path.join(os.tmpdir(), 'palmier-codex-')));

  const tempDir = await makeTempDir();
  const schemaPath = path.join(tempDir, 'schema.json');
  const outputPath = path.join(tempDir, 'final-message.json');
  const cleanup = async (): Promise<void> => {
    await removeFile(schemaPath).catch(() => undefined);
    await removeFile(outputPath).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    await writeFile(schemaPath, JSON.stringify(codexEnvelopeSchema(request.tools)));
    const args = buildCodexArgs({
      model: request.model,
      workingDir: dirCheck.dir,
      schemaPath,
      outputPath,
    });

    let child: SpawnedProcess;
    try {
      child = (deps.spawnFn ?? defaultSpawnFn)(binary.binaryPath, args, { cwd: dirCheck.dir });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Codex CLI could not be started: ${detail}`);
    }

    const prompt = buildCodexPrompt({
      system: request.system,
      history: request.history,
      userMessage: request.userMessage,
      tools: request.tools,
    });

    const stream = new CodexStreamAccumulator();
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const before = stream.tokens.length;
      stream.pushChunk(text);
      if (request.onToken) {
        for (let i = before; i < stream.tokens.length; i += 1) request.onToken(stream.tokens[i]!);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > STDERR_TAIL_CHARS) stderr = stderr.slice(-STDERR_TAIL_CHARS);
    });
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Codex CLI could not receive the prompt: ${detail}`);
    }

    const timeoutMs = request.timeoutMs ?? CODEX_DEFAULT_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };
      const kill = (): void => {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch { /* already gone */ }
      };
      const timer = setTimeout(() => {
        kill();
        done(new Error(
          `Codex CLI did not respond within ${Math.round(timeoutMs / 1000)}s.`,
        ));
      }, timeoutMs);
      timer.unref?.();
      const onAbort = (): void => {
        kill();
        done(new CancelledError());
      };
      // A settled race: an abort that lands after natural completion must not
      // overwrite the result, and `done` guards exactly that.
      if (request.signal?.aborted) {
        onAbort();
        return;
      }
      request.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (err: unknown) => {
        kill();
        const detail = err instanceof Error ? err.message : String(err);
        done(new Error(`Codex CLI could not be started: ${detail}`));
      });
      child.on('close', (code: unknown, signal: unknown) => {
        if (request.signal?.aborted) {
          done(new CancelledError());
          return;
        }
        if (code === 0) {
          done();
          return;
        }
        const tail = stderrTail(stderr);
        const cause = signal
          ? `killed by signal ${String(signal)}`
          : `exited with code ${String(code)}`;
        const streamed = stream.turnError ? ` ${stream.turnError}` : '';
        done(new Error(`Codex CLI failed (${cause}).${streamed}${tail ? ` ${tail.slice(0, ERROR_TAIL_CHARS)}` : ''}`.trim()));
      });
    }).finally(() => {
      // No orphan on any path: a child still alive here is killed, and a
      // completed child makes `kill` a no-op behind the `killed` guard.
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch { /* already gone */ }
    });

    if (request.signal?.aborted) throw new CancelledError();
    if (stream.turnError && !stream.sawTurnCompleted) {
      throw new Error(stream.turnError);
    }
    stream.flush();

    // The `-o` file is authoritative (schema-validated by the CLI); the
    // streamed agent text backs it up when the file is missing — e.g. an
    // older CLI that does not support `-o` combined with `--json`.
    let finalText = '';
    try {
      finalText = await readFile(outputPath);
    } catch {
      finalText = stream.lastAgentText;
    }
    if (finalText.trim().length === 0) finalText = stream.lastAgentText;
    const parsed = parseCodexEnvelope(finalText);
    if (!parsed.ok) throw new Error(parsed.reason);
    return {
      content: parsed.envelope.content,
      toolCalls: parsed.envelope.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        argumentsJson: call.argumentsJson,
      })),
      wantsTools: parsed.envelope.toolCalls.length > 0,
    };
  } finally {
    await cleanup();
  }
}

/** Import surface for the child_process default (kept narrow for tests). */
export type { ChildProcess };
