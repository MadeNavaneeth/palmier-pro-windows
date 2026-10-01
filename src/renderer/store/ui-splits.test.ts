/**
 * Regression coverage for the persisted workspace divider positions
 * (upstream #286's resizable-splitters gap).
 *
 * Same contract as the panel flags beside it: the stored file is
 * user-writable and may come from a different build, so every value is
 * narrowed on read; a drag is clamped before it persists so the layout never
 * has to honor a position it cannot render.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SPLITS_DEFAULTS, SPLITS_LIMITS } from './ui';

const STORAGE_KEY = 'palmier.layout.splits';
const DEFAULTS = { mediaWidth: 480, inspectorWidth: 320, previewWidth: 608, timelineHeight: 350 };

function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
  });
  return store;
}

async function loadStore() {
  vi.resetModules();
  const module = await import('./ui');
  return module.useUiStore;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workspace splits (#286)', () => {
  it('starts at the recorded first-run geometry when nothing is stored', async () => {
    installStorage();
    const useUiStore = await loadStore();

    expect(useUiStore.getState().splits).toEqual(DEFAULTS);
  });

  it('persists a dragged position and reads it back', async () => {
    const storage = installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().setSplit('mediaWidth', 560);

    expect(useUiStore.getState().splits.mediaWidth).toBe(560);
    expect(JSON.parse(storage.get(STORAGE_KEY)!).mediaWidth).toBe(560);

    const reloaded = await loadStore();
    expect(reloaded.getState().splits.mediaWidth).toBe(560);
  });

  it('clamps a drag into range instead of persisting an unusable layout', async () => {
    const storage = installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().setSplit('timelineHeight', 5000);
    expect(useUiStore.getState().splits.timelineHeight).toBe(600);
    expect(JSON.parse(storage.get(STORAGE_KEY)!).timelineHeight).toBe(600);

    useUiStore.getState().setSplit('inspectorWidth', -80);
    expect(useUiStore.getState().splits.inspectorWidth).toBe(200);
  });

  it('narrows a corrupt or foreign stored payload back to defaults', async () => {
    installStorage({
      [STORAGE_KEY]: JSON.stringify({
        mediaWidth: 'wide',
        inspectorWidth: 99999,
        previewWidth: undefined,
        somethingElse: true,
      }),
    });
    const useUiStore = await loadStore();

    expect(useUiStore.getState().splits).toEqual({
      ...DEFAULTS,
      inspectorWidth: 560, // present but out of range -> clamped, not rejected
    });
  });

  it('falls back to defaults on unparseable storage rather than failing to start', async () => {
    installStorage({ [STORAGE_KEY]: '{not json' });
    const useUiStore = await loadStore();

    expect(useUiStore.getState().splits).toEqual(DEFAULTS);
  });

  it('restores every divider with resetSplits and persists that', async () => {
    const storage = installStorage();
    const useUiStore = await loadStore();
    useUiStore.getState().setSplit('mediaWidth', 700);

    useUiStore.getState().resetSplits();

    expect(useUiStore.getState().splits).toEqual(DEFAULTS);
    expect(JSON.parse(storage.get(STORAGE_KEY)!)).toEqual(DEFAULTS);
  });
});

/**
 * The floor invariant the workspace's shrink behaviour exists to protect (#574).
 *
 * The workspace row is `overflow-hidden`, so a column that cannot fit is clipped
 * rather than scrolled. `min-width` is a hard floor for a flex item, which means
 * the preview can never be squeezed under 300 px: a shortfall is pushed onto the
 * side panels instead, and they absorb it proportionally down to their own 200 px
 * floors. That is the behaviour App.tsx:401-407 documents, and it is why the
 * default set fits the minimum window width instead of overflowing it.
 *
 * These assertions reconstruct the row from the stored defaults and the floor
 * table rather than restating the numbers, so they fail if a floor is raised, a
 * default is widened past the row, or the narrowing on read stops guaranteeing a
 * floor-respecting set. The resolved values are the ones the Electron probe
 * measured in the real DOM, which is what makes the reconstruction falsifiable
 * rather than self-consistent.
 *
 * Not asserted here, honestly: rendered box geometry, and the shrink
 * configuration that produces it -- the floors as Tailwind classes and the
 * absence of `shrink-0` on the side panels. This suite runs in a node
 * environment with no DOM (vitest.config.ts) and `WorkspacePresetLayout` is not
 * exported from App.tsx, so the only layer that measures real boxes is
 * `npm run ui:probe`, under Electron.
 */

/** src/main/application.ts: the main window's hard width minimum. */
const MIN_WINDOW_WIDTH = 1024;
/** App.tsx:346: the workspace row's `p-[5px]`, applied to both sides. */
const ROW_PADDING_X = 10;
/** App.tsx:868 and the Divider strip: 5 px, twice in the default preset. */
const DIVIDER_W = 5;

interface Columns {
  media: number;
  preview: number;
  inspector: number;
}

/**
 * Resolve the default preset's three columns at `contentWidth`.
 *
 * `flex-1` on the preview is `1 1 0%`: it absorbs all slack from a zero basis,
 * while the side panels carry their stored width as the basis and keep flex's
 * default shrink of 1. So the preview takes everything the row has left after
 * the bases, is held at its min-width when that leaves it short, and the
 * resulting deficit is distributed across the shrinkable items in proportion to
 * their bases.
 */
function resolveColumns(contentWidth: number, media: number, inspector: number): Columns {
  const basisSum = media + inspector + DIVIDER_W * 2;
  const preview = Math.max(SPLITS_LIMITS.previewWidth.min, contentWidth - basisSum);
  const deficit = Math.max(0, basisSum + preview - contentWidth);
  return {
    media: media - (deficit * media) / (media + inspector),
    preview,
    inspector: inspector - (deficit * inspector) / (media + inspector),
  };
}

describe('workspace split floors at the minimum window width (#574)', () => {
  const available = MIN_WINDOW_WIDTH - ROW_PADDING_X;
  const floors = SPLITS_LIMITS.mediaWidth.min
    + DIVIDER_W + SPLITS_LIMITS.previewWidth.min
    + DIVIDER_W + SPLITS_LIMITS.inspectorWidth.min;

  it('satisfies every floor jointly at 1024, so the shortfall has somewhere to go', () => {
    // 1014 px of row behind the 5 px padding; 710 px of floors. While the floors
    // fit, the proportional shrink below can always absorb a deficit without
    // breaking one. This is the invariant the default layout depends on.
    expect(available).toBe(1014);
    expect(floors).toBe(710);
    expect(floors).toBeLessThanOrEqual(available);
  });

  it('absorbs the default shortfall in the side panels rather than clipping the row', () => {
    // The stored widths ask for 1110 px in a 1014 px row. That 96 px gap is real,
    // but it is taken from the two shrinkable panels in proportion to their
    // 480:320 bases, not from the preview and not by overflowing the row.
    const shortfall = SPLITS_DEFAULTS.mediaWidth
      + SPLITS_DEFAULTS.inspectorWidth
      + DIVIDER_W * 2
      + SPLITS_LIMITS.previewWidth.min
      - available;
    expect(shortfall).toBe(96);

    const columns = resolveColumns(available, SPLITS_DEFAULTS.mediaWidth, SPLITS_DEFAULTS.inspectorWidth);
    // Measured in the rendered DOM at 1024x680: media 422.4, preview 300, inspector 281.6.
    expect(columns.media).toBeCloseTo(422.4, 1);
    expect(columns.inspector).toBeCloseTo(281.6, 1);
    expect(columns.preview).toBe(SPLITS_LIMITS.previewWidth.min);
  });

  it('leaves every column at or above its floor and the row exactly filled', () => {
    const columns = resolveColumns(available, SPLITS_DEFAULTS.mediaWidth, SPLITS_DEFAULTS.inspectorWidth);

    expect(columns.media).toBeGreaterThanOrEqual(SPLITS_LIMITS.mediaWidth.min);
    expect(columns.preview).toBeGreaterThanOrEqual(SPLITS_LIMITS.previewWidth.min);
    expect(columns.inspector).toBeGreaterThanOrEqual(SPLITS_LIMITS.inspectorWidth.min);

    // Exactly filled is the claim the #574 row got wrong: zero overflow is what
    // leaves the `overflow-hidden` row with nothing to clip.
    expect(columns.media + DIVIDER_W + columns.preview + DIVIDER_W + columns.inspector)
      .toBeCloseTo(available, 6);
  });

  it('needs no shrink at 1120 and gives way only in the side panels below it', () => {
    // 1120 is the narrowest width at which the default set fits unwidened, and
    // the preview holds its floor at and below it rather than violating it.
    const narrowest = SPLITS_DEFAULTS.mediaWidth
      + SPLITS_DEFAULTS.inspectorWidth
      + DIVIDER_W * 2
      + SPLITS_LIMITS.previewWidth.min
      + ROW_PADDING_X;
    expect(narrowest).toBe(1120);

    const exact = resolveColumns(narrowest - ROW_PADDING_X, SPLITS_DEFAULTS.mediaWidth, SPLITS_DEFAULTS.inspectorWidth);
    expect(exact.media).toBe(SPLITS_DEFAULTS.mediaWidth);
    expect(exact.inspector).toBe(SPLITS_DEFAULTS.inspectorWidth);
    expect(exact.preview).toBe(SPLITS_LIMITS.previewWidth.min);

    const narrower = resolveColumns(narrowest - ROW_PADDING_X - 1, SPLITS_DEFAULTS.mediaWidth, SPLITS_DEFAULTS.inspectorWidth);
    expect(narrower.preview).toBe(SPLITS_LIMITS.previewWidth.min);
    expect(narrower.media).toBeLessThan(SPLITS_DEFAULTS.mediaWidth);
    expect(narrower.inspector).toBeLessThan(SPLITS_DEFAULTS.inspectorWidth);
  });
});
