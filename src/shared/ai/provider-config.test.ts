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
});
