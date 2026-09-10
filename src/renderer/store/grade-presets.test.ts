/**
 * Regression coverage for the user-defined grade presets store (#157):
 * persistence round-trip, rejection of unusable names, and narrowing of a
 * corrupt stored payload. Follows the ui-splits pattern: stub localStorage,
 * reset modules, import the store fresh.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const STORAGE_KEY = 'palmier.grade.presets';

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
  const module = await import('./grade-presets');
  return module.useGradePresetsStore;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('grade preset store (#157)', () => {
  it('starts empty and saves a named look', async () => {
    const storage = installStorage();
    const store = await loadStore();

    expect(store.getState().presets).toEqual([]);

    const saved = store.getState().save('  Golden Hour ', { brightness: 0.1, saturation: 1.2 });
    expect(saved).toMatchObject({ label: 'Golden Hour', grade: { brightness: 0.1, saturation: 1.2 } });
    expect(store.getState().presets).toHaveLength(1);
    expect(JSON.parse(storage.get(STORAGE_KEY)!)).toHaveLength(1);
  });

  it('reads saved presets back on the next load', async () => {
    installStorage();
    const store = await loadStore();
    store.getState().save('My Look', { contrast: 1.4 });

    const reloaded = await loadStore();

    expect(reloaded.getState().presets).toHaveLength(1);
    expect(reloaded.getState().presets[0].label).toBe('My Look');
  });

  it('rejects an empty name without touching the stored list', async () => {
    installStorage();
    const store = await loadStore();
    store.getState().save('Keep', { brightness: 0.1 });

    expect(store.getState().save('   ', { contrast: 2 })).toBeNull();
    expect(store.getState().presets).toHaveLength(1);
    expect(store.getState().presets[0].label).toBe('Keep');
  });

  it('removes a preset and persists the removal', async () => {
    const storage = installStorage();
    const store = await loadStore();
    const saved = store.getState().save('Temp', { brightness: 0.1 })!;

    store.getState().remove(saved.id);

    expect(store.getState().presets).toEqual([]);
    expect(JSON.parse(storage.get(STORAGE_KEY)!)).toEqual([]);
  });

  it('narrows a corrupt or foreign stored payload back to none', async () => {
    installStorage({
      [STORAGE_KEY]: JSON.stringify([
        { id: 'bad id', label: 'X', grade: {} },
        { id: 'user-ok', label: 'Fine', grade: { saturation: 0.5 } },
      ]),
    });
    const store = await loadStore();

    expect(store.getState().presets).toEqual([
      { id: 'user-ok', label: 'Fine', grade: { saturation: 0.5 } },
    ]);

    vi.resetModules();
    installStorage({ [STORAGE_KEY]: '{not json' });
    const broken = await loadStore();
    expect(broken.getState().presets).toEqual([]);
  });
});
