/**
 * The provenance row of the Inspector (upstream PR #570) must show what a
 * generated clip was made from, and the reference image is part of that: a run
 * conditioned on a picture that shows no trace of it cannot be told apart from
 * a plain text-to-image run.
 *
 * Rendered to static markup because the row is display-only: the contract is the
 * text and the tooltip it prints, and the row must vanish entirely when the
 * asset has no reference.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MediaAsset } from '../../shared/types/project';

// The row reads its asset from the timeline store. A stand-in makes the asset
// the test's input instead of a whole seeded project.
const asset = vi.hoisted(() => ({ current: undefined as MediaAsset | undefined }));

vi.mock('../store/timeline', () => ({
  useTimelineStore: (selector: (state: unknown) => unknown) => selector({
    getScopeTimeline: () => ({ clips: [{ id: 'clip-1', assetId: 'asset-1' }] }),
    project: { media: asset.current ? [asset.current] : [] },
  }),
}));

const { GenerationInfo } = await import('./Inspector');

const BASE: MediaAsset = {
  id: 'asset-1',
  path: 'C:/library/generated/harbour.png',
  filename: 'harbour.png',
  type: 'image',
  duration: 0,
  fileSize: 1024,
  addedAt: '2026-01-01T00:00:00.000Z',
  generatedBy: { provider: 'fal', model: 'fal-ai/flux/dev' },
};

function renderProvenance(media: MediaAsset): string {
  asset.current = media;
  return renderToStaticMarkup(React.createElement(GenerationInfo, { clipId: 'clip-1' }));
}

afterEach(() => {
  asset.current = undefined;
});

describe('Inspector generation provenance', () => {
  it('names the reference image the run was conditioned on', () => {
    const html = renderProvenance({
      ...BASE,
      generatedBy: { ...BASE.generatedBy!, referenceImagePath: 'C:/library/stills/harbour-dusk.png' },
    });

    expect(html).toContain('ref harbour-dusk.png');
    // The full path is the provenance; the row keeps it reachable.
    expect(html).toContain('title="C:/library/stills/harbour-dusk.png"');
  });

  it('omits the line when the run had no reference', () => {
    const html = renderProvenance(BASE);

    expect(html).toContain('fal / fal-ai/flux/dev');
    expect(html).not.toContain('ref ');
    expect(html).not.toContain('title=');
  });

  it('omits the line for a blank reference and still shows the cost', () => {
    const html = renderProvenance({
      ...BASE,
      generatedBy: { ...BASE.generatedBy!, costCredits: 12.5, referenceImagePath: '   ' },
    });

    expect(html).toContain('12.5 cr');
    expect(html).not.toContain('ref ');
  });

  it('renders nothing for a clip whose asset was not generated', () => {
    asset.current = { ...BASE, generatedBy: undefined };
    expect(renderToStaticMarkup(React.createElement(GenerationInfo, { clipId: 'clip-1' }))).toBe('');
  });
});
