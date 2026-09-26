/**
 * The system prompt may only recommend models the providers actually expose.
 *
 * The catalog is read from the live adapter classes rather than restated here,
 * so removing or renaming a model in a provider fails this test instead of
 * leaving the prompt recommending something unselectable.
 */
import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_PROMPT } from './agent';
import { FalProvider } from '../generation/provider-fal';
import { ReplicateProvider } from '../generation/provider-replicate';
import { HiggsFieldProvider } from '../generation/provider-higgsfield';

vi.mock('electron', () => ({ app: undefined }));

const TYPES = ['image', 'video', 'audio'] as const;

/** Every model id the built-in providers currently expose. */
function liveCatalog(): Set<string> {
  const providers = [new FalProvider(), new ReplicateProvider(), new HiggsFieldProvider()];
  return new Set(providers.flatMap((provider) => TYPES.flatMap((type) => provider.getModels(type))));
}

/** The recommendation block only: from its heading to the next blank line. */
function recommendations(): string {
  const start = SYSTEM_PROMPT.indexOf('**Model recommendations');
  expect(start).toBeGreaterThan(-1);
  const end = SYSTEM_PROMPT.indexOf('\n\n', start);
  return SYSTEM_PROMPT.slice(start, end === -1 ? undefined : end);
}

/** Ids carry at least one slash; the quoted span is the prompt's convention. */
function modelIdsIn(text: string): string[] {
  const slashed = text.match(/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._:/-]+)+/g) ?? [];
  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  return [...new Set([...slashed, ...quoted])];
}

describe('agent model recommendations match the live catalog', () => {
  it('names only models the providers expose', () => {
    const catalog = liveCatalog();
    expect(catalog.size).toBeGreaterThan(5);

    const named = modelIdsIn(recommendations());
    // Guard against a vacuous pass if the block ever loses its model list.
    expect(named.length).toBeGreaterThanOrEqual(8);

    for (const id of named) {
      expect(catalog.has(id), `${id} is not in any provider catalog`).toBe(true);
    }
  });

  it('names no model brand the catalog cannot show an id for', () => {
    // A brand name ("Seedream", "MiniMax H3") carries no id punctuation, so the
    // catalog scan above cannot see it. Anything capitalized mid-sentence is
    // either a section label or a provider name; anything else is a model
    // recommendation the catalog would have to contain.
    const allowed = new Set([
      'Model', 'Images', 'Video', 'Audio',
      new FalProvider().name, new ReplicateProvider().name, new HiggsFieldProvider().name,
    ]);
    const brands = recommendations()
      .split(/(?<=[.!?:])\s+/)
      .map((sentence) => sentence.split(/\s+/).slice(1).join(' '))
      .join(' ')
      .match(/\b[A-Z][A-Za-z0-9]*\b/g) ?? [];

    for (const brand of brands) {
      expect(allowed.has(brand), `${brand} is neither a section label nor a provider name`).toBe(true);
    }
  });

  it('documents the reference image as an image-only, optional argument', () => {
    expect(SYSTEM_PROMPT).toContain('referenceImagePath');
    expect(SYSTEM_PROMPT).toMatch(/refused for video and audio/);
  });
});
