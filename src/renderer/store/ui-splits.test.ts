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

const STORAGE_KEY = 'palmier.layout.splits';
const DEFAULTS = { mediaWidth: 480, inspectorWidth: 320, previewWidth: 608, timelineHeight: 270 };

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
