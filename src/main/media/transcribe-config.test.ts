/**
 * Coverage for the persisted transcription endpoint override (#287):
 * narrowing on read, session persistence without Electron, and cache reset.
 * The electron import is a stub under vitest, so the store is unavailable —
 * that is exactly the fallback path real tests need to exercise.
 */
import { describe, it, expect } from 'vitest';
import {
  getTranscribeConfig,
  setTranscribeConfig,
  resetTranscribeConfigCache,
} from './transcribe-config';

describe('transcribe config (#287)', () => {
  beforeEach(() => {
    resetTranscribeConfigCache();
  });

  it('starts empty: use the AI provider runtime instead', () => {
    expect(getTranscribeConfig()).toEqual({});
  });

  it('keeps a partial override for the session', () => {
    setTranscribeConfig({ baseUrl: 'http://127.0.0.1:8080/v1' });
    expect(getTranscribeConfig()).toEqual({
      baseUrl: 'http://127.0.0.1:8080/v1',
    });
  });

  it('narrows hostile values on write', () => {
    setTranscribeConfig({
      baseUrl: 'ftp://not-http',
      apiKey: 'k',
      model: 'x'.repeat(100),
    });
    expect(getTranscribeConfig()).toEqual({ apiKey: 'k', model: 'x'.repeat(64) });
  });

  it('drops a stale cache after reset so fresh reads re-resolve', () => {
    setTranscribeConfig({ apiKey: 'k1' });
    resetTranscribeConfigCache();
    // Without an Electron store the next read starts from defaults.
    expect(getTranscribeConfig()).toEqual({});
  });
});
