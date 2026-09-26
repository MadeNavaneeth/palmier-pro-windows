/**
 * Regression coverage for LLM provider configuration (upstream #17 and #140).
 *
 * The base URL is the security-relevant field: it decides where an API key and
 * the project's timeline structure get sent. Each rejection below is a case that
 * would otherwise leak credentials, exfiltrate project data over plaintext, or
 * turn a settings field into a local-file read.
 */

import { describe, it, expect } from 'vitest';
import {
  PROVIDER_PRESETS,
  endpointLeavesMachine,
  presetById,
  resolveEndpoint,
  validateBaseUrl,
  validateBinaryPathShape,
  validateProviderConfig,
} from './provider-config';

function expectRejected(raw: unknown): string {
  const result = validateBaseUrl(raw);
  expect(result.ok, `expected ${String(raw)} to be rejected`).toBe(false);
  return result.ok ? '' : result.reason;
}

function expectAccepted(raw: string): string {
  const result = validateBaseUrl(raw);
  expect(result.ok, `expected ${raw} to be accepted`).toBe(true);
  return result.ok ? result.url : '';
}

describe('validateBaseUrl', () => {
  it('accepts https endpoints and keeps the version path', () => {
    expect(expectAccepted('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(expectAccepted('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1');
    expect(expectAccepted('https://example.test')).toBe('https://example.test');
  });

  it('normalizes trailing slashes and surrounding whitespace', () => {
    expect(expectAccepted('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(expectAccepted('https://api.openai.com/v1///')).toBe('https://api.openai.com/v1');
    expect(expectAccepted('  https://api.openai.com/v1  ')).toBe('https://api.openai.com/v1');
  });

  it('keeps a non-default port', () => {
    expect(expectAccepted('https://gateway.internal.test:8443/v1'))
      .toBe('https://gateway.internal.test:8443/v1');
  });

  it('allows plain http only on loopback', () => {
    expect(expectAccepted('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1');
    expect(expectAccepted('http://localhost:1234/v1')).toBe('http://localhost:1234/v1');
    expect(expectAccepted('http://[::1]:1234/v1')).toBe('http://[::1]:1234/v1');
    // The whole 127.0.0.0/8 block is loopback, not just .0.1.
    expect(expectAccepted('http://127.9.9.9:8080')).toBe('http://127.9.9.9:8080');
  });

  it('refuses plaintext to any remote host', () => {
    // The request carries the API key and the project timeline.
    expect(expectRejected('http://api.openai.com/v1')).toMatch(/https/i);
    expect(expectRejected('http://192.168.1.50:11434/v1')).toMatch(/https/i);
    expect(expectRejected('http://10.0.0.5/v1')).toMatch(/https/i);
    // Not loopback despite looking similar.
    expect(expectRejected('http://127.0.0.1.evil.test/v1')).toMatch(/https/i);
    expect(expectRejected('http://notlocalhost/v1')).toMatch(/https/i);
  });

  it('refuses non-http schemes', () => {
    for (const raw of [
      'file:///C:/Windows/System32/drivers/etc/hosts',
      'data:text/plain,hello',
      'ftp://example.test/v1',
      'ws://localhost:1234',
      'javascript:alert(1)',
    ]) {
      expect(expectRejected(raw)).toMatch(/http/i);
    }
  });

  it('refuses credentials embedded in the URL', () => {
    // They would be written to the config store and echoed in error text.
    expect(expectRejected('https://user:secret@api.openai.com/v1')).toMatch(/password|api key/i);
    expect(expectRejected('https://user@api.openai.com/v1')).toMatch(/password|api key/i);
  });

  it('refuses a query string or fragment on a base URL', () => {
    expect(expectRejected('https://api.openai.com/v1?key=abc')).toMatch(/query|fragment/i);
    expect(expectRejected('https://api.openai.com/v1#frag')).toMatch(/query|fragment/i);
  });

  it('refuses empty, blank, and non-string input', () => {
    for (const raw of ['', '   ', undefined, null, 42, {}, [], true]) {
      expect(expectRejected(raw).length).toBeGreaterThan(0);
    }
  });

  it('refuses a bare host with no scheme', () => {
    expect(expectRejected('api.openai.com/v1')).toMatch(/valid URL|scheme/i);
    expect(expectRejected('//api.openai.com/v1')).toMatch(/valid URL|scheme/i);
  });
});

describe('resolveEndpoint', () => {
  it('joins without doubling or dropping a slash', () => {
    expect(resolveEndpoint('https://a.test/v1', '/chat/completions'))
      .toBe('https://a.test/v1/chat/completions');
    expect(resolveEndpoint('https://a.test/v1', 'chat/completions'))
      .toBe('https://a.test/v1/chat/completions');
    expect(resolveEndpoint('https://a.test/v1/', '/chat/completions'))
      .toBe('https://a.test/v1/chat/completions');
  });
});

describe('validateProviderConfig', () => {
  it('accepts Anthropic without a base URL', () => {
    const result = validateProviderConfig({ kind: 'anthropic', model: 'claude-sonnet-4-20250514' });
    expect(result).toEqual({
      ok: true,
      config: { kind: 'anthropic', model: 'claude-sonnet-4-20250514' },
    });
  });

  it('accepts an Anthropic gateway override', () => {
    const result = validateProviderConfig({
      kind: 'anthropic',
      baseUrl: 'https://gateway.test/anthropic/',
      model: 'claude-sonnet-4-20250514',
    });
    expect(result.ok && result.config.baseUrl).toBe('https://gateway.test/anthropic');
  });

  it('requires a base URL for an OpenAI-compatible provider', () => {
    const result = validateProviderConfig({ kind: 'openai-compatible', model: 'gpt-4o' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/base URL/i);
  });

  it('requires a model name', () => {
    for (const model of ['', '   ', undefined, 7]) {
      const result = validateProviderConfig({
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        model,
      });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(/model/i);
    }
  });

  it('rejects an absurdly long model name', () => {
    const result = validateProviderConfig({
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'x'.repeat(500),
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/too long/i);
  });

  it('trims the model name', () => {
    const result = validateProviderConfig({
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: '  gpt-4o  ',
    });
    expect(result.ok && result.config.model).toBe('gpt-4o');
  });

  it('rejects an unknown provider kind', () => {
    for (const kind of ['gemini', '', undefined, null, 3]) {
      const result = validateProviderConfig({ kind, model: 'x' });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(/provider type/i);
    }
  });

  it('propagates the base URL rejection reason', () => {
    const result = validateProviderConfig({
      kind: 'openai-compatible',
      baseUrl: 'http://api.openai.com/v1',
      model: 'gpt-4o',
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/https/i);
  });
});

describe('presets', () => {
  it('every preset carries a validatable base URL or none at all', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.baseUrl === undefined) continue;
      const result = validateBaseUrl(preset.baseUrl);
      expect(result.ok, `${preset.id}: ${result.ok ? '' : result.reason}`).toBe(true);
    }
  });

  it('every preset validates as a whole config once a model is set', () => {
    for (const preset of PROVIDER_PRESETS) {
      const model = preset.defaultModel || 'some-model';
      const result = validateProviderConfig({
        kind: preset.kind,
        baseUrl: preset.baseUrl,
        model,
      });
      // Only the custom preset lacks a URL while requiring one.
      if (preset.kind === 'openai-compatible' && !preset.baseUrl) {
        expect(result.ok, preset.id).toBe(false);
      } else {
        expect(result.ok, `${preset.id}: ${result.ok ? '' : result.reason}`).toBe(true);
      }
    }
  });

  it('has unique ids and is addressable by id', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(presetById('ollama')?.kind).toBe('openai-compatible');
    expect(presetById('anthropic')?.kind).toBe('anthropic');
    expect(presetById('nope')).toBeUndefined();
  });

  it('marks local runtimes as not requiring a key', () => {
    expect(presetById('ollama')?.requiresApiKey).toBe(false);
    expect(presetById('lmstudio')?.requiresApiKey).toBe(false);
    expect(presetById('openai')?.requiresApiKey).toBe(true);
  });

  it('offers zero-cost presets that still validate end to end', () => {
    for (const id of ['openrouter-free', 'gemini', 'mistral', 'cerebras']) {
      const preset = presetById(id);
      expect(preset?.kind).toBe('openai-compatible');
      expect(preset?.requiresApiKey).toBe(true);
      expect(preset?.defaultModel.length).toBeGreaterThan(0);
      const validated = validateProviderConfig({
        kind: preset!.kind,
        baseUrl: preset!.baseUrl,
        model: preset!.defaultModel,
      });
      expect(validated.ok, id).toBe(true);
    }
    // The free router picks the model per request, so there is no pinned
    // model id to rot.
    expect(presetById('openrouter-free')?.defaultModel).toBe('openrouter/free');
  });

  it('documents the cost contract wherever free is on offer', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (/free/i.test(preset.label)) {
        expect(preset.hint, preset.id).toMatch(/free/i);
      }
    }
    expect(presetById('groq')?.hint).toMatch(/free/i);
    expect(presetById('openrouter')?.hint).toMatch(/:free/);
    expect(presetById('ollama')?.hint).toMatch(/ollama pull/);
  });
});

describe('endpointLeavesMachine', () => {
  it('is false only for a loopback endpoint', () => {
    expect(endpointLeavesMachine({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' })).toBe(false);
    expect(endpointLeavesMachine({ kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'm' })).toBe(false);
    expect(endpointLeavesMachine({ kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'm' })).toBe(true);
  });

  it('assumes data leaves when no base URL is set', () => {
    // No URL means the SDK default, which is a hosted API.
    expect(endpointLeavesMachine({ kind: 'anthropic', model: 'm' })).toBe(true);
  });

  it('assumes data leaves when the URL is unusable', () => {
    expect(endpointLeavesMachine({ kind: 'anthropic', baseUrl: 'nonsense', model: 'm' })).toBe(true);
  });

  it('treats the Codex CLI as leaving the machine', () => {
    // The CLI answers through the user's own Codex account, not locally.
    expect(endpointLeavesMachine({ kind: 'codex-cli', model: '' })).toBe(true);
  });
});

describe('codex-cli provider (upstream #142)', () => {
  it('lists alongside the HTTP providers without altering them', () => {
    const codex = presetById('codex-cli');
    expect(codex?.kind).toBe('codex-cli');
    expect(codex?.requiresApiKey).toBe(false);
    expect(codex?.defaultModel).toBe('');

    // Pinned snapshot of every pre-existing preset: adding the CLI entry
    // must not change a single byte of the HTTP registry's behavior.
    expect(PROVIDER_PRESETS.filter((preset) => preset.id !== 'codex-cli').map((preset) => ({
      id: preset.id,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      defaultModel: preset.defaultModel,
      requiresApiKey: preset.requiresApiKey,
    }))).toEqual([
      { id: 'anthropic', kind: 'anthropic', baseUrl: undefined, defaultModel: 'claude-sonnet-4-20250514', requiresApiKey: true },
      { id: 'openai', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', requiresApiKey: true },
      { id: 'openrouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'anthropic/claude-sonnet-4', requiresApiKey: true },
      { id: 'openrouter-free', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/free', requiresApiKey: true },
      { id: 'groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', requiresApiKey: true },
      { id: 'together', kind: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', requiresApiKey: true },
      { id: 'gemini', kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', defaultModel: 'gemini-2.5-flash', requiresApiKey: true },
      { id: 'mistral', kind: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest', requiresApiKey: true },
      { id: 'cerebras', kind: 'openai-compatible', baseUrl: 'https://api.cerebras.ai/v1', defaultModel: 'llama-3.3-70b', requiresApiKey: true },
      { id: 'ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'llama3.1', requiresApiKey: false },
      { id: 'lmstudio', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', defaultModel: 'local-model', requiresApiKey: false },
      { id: 'custom', kind: 'openai-compatible', baseUrl: undefined, defaultModel: '', requiresApiKey: true },
    ]);
  });

  it('accepts an empty model — the CLI default applies', () => {
    expect(validateProviderConfig({ kind: 'codex-cli', model: '' })).toEqual({
      ok: true,
      config: { kind: 'codex-cli', model: '' },
    });
    expect(validateProviderConfig({ kind: 'codex-cli', model: '  gpt-5-codex  ' })).toEqual({
      ok: true,
      config: { kind: 'codex-cli', model: 'gpt-5-codex' },
    });
  });

  it('accepts a binary override only as an absolute path', () => {
    const ok = validateProviderConfig({ kind: 'codex-cli', model: '', binaryPath: 'C:\\Tools\\codex.exe' });
    expect(ok).toEqual({
      ok: true,
      config: { kind: 'codex-cli', model: '', binaryPath: 'C:\\Tools\\codex.exe' },
    });
    const bad = validateProviderConfig({ kind: 'codex-cli', model: '', binaryPath: 'codex' });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toMatch(/absolute/i);
  });

  it('still rejects an absurdly long model name', () => {
    const result = validateProviderConfig({ kind: 'codex-cli', model: 'x'.repeat(500) });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/too long/i);
  });

  it('ignores HTTP-only fields on a CLI config', () => {
    // A base URL on a CLI config is meaningless; it must not be carried
    // into the stored config where a reader could mistake it for an endpoint.
    const result = validateProviderConfig({
      kind: 'codex-cli',
      baseUrl: 'https://api.openai.com/v1',
      model: '',
    });
    expect(result).toEqual({ ok: true, config: { kind: 'codex-cli', model: '' } });
  });
});

describe('validateBinaryPathShape', () => {
  it('accepts absolute Windows and POSIX paths', () => {
    expect(validateBinaryPathShape('C:\\Tools\\codex.exe')).toEqual({ ok: true, path: 'C:\\Tools\\codex.exe' });
    expect(validateBinaryPathShape('  /usr/local/bin/codex  ')).toEqual({ ok: true, path: '/usr/local/bin/codex' });
    expect(validateBinaryPathShape('\\\\server\\share\\codex.exe').ok).toBe(true);
  });

  it('refuses relative paths, blanks, and NUL bytes', () => {
    for (const raw of ['codex', '.\\codex.exe', '', '   ', undefined, null, 42]) {
      const result = validateBinaryPathShape(raw);
      expect(result.ok, String(raw)).toBe(false);
    }
    expect(validateBinaryPathShape('C:\\bin\0codex').ok).toBe(false);
  });
});
