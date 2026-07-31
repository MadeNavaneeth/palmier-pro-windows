/**
 * Regression coverage for the persisted workspace layout preset (upstream PR #430).
 *
 * The preset is the coarse arrangement — where media, preview, inspector and
 * timeline sit — and it has to survive a restart for the same reason the panel
 * toggles do: someone who edits vertical video works in that arrangement all day,
 * and re-picking it on every launch makes the feature not worth having. Upstream
 * persists it to UserDefaults and validates on read; the equivalent here is
 * localStorage plus narrowing, since the stored file is user-writable and may have
 * been written by a build with a different set of presets.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const STORAGE_KEY = 'palmier.layout.preset';

/** Minimal localStorage stand-in; the store only needs get/set. */
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

/** Fresh module instance, so the initializer re-reads storage. */
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

describe('layout preset switching', () => {
  it('starts on the default arrangement', async () => {
    installStorage();
    const useUiStore = await loadStore();

    expect(useUiStore.getState().layout).toBe('default');
  });

  it('switches to each preset', async () => {
    installStorage();
    const useUiStore = await loadStore();

    for (const preset of ['media', 'vertical', 'default'] as const) {
      useUiStore.getState().setLayout(preset);
      expect(useUiStore.getState().layout).toBe(preset);
    }
  });

  it('leaves the panel toggles alone', async () => {
    // The preset decides the arrangement, the toggles decide what is in it. A
    // preset that silently reopened a panel someone closed would be the kind of
    // hidden coupling that makes a layout control feel unpredictable.
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().togglePanel('media');
    useUiStore.getState().togglePanel('agent');
    const panels = useUiStore.getState().panels;

    useUiStore.getState().setLayout('vertical');

    expect(useUiStore.getState().panels).toBe(panels);
  });

  it('ignores a value that is not a preset', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().setLayout('media');
    // Reaches the store from an untyped edge — a stale IPC payload or a caller
    // compiled against a different preset list.
    useUiStore.getState().setLayout('grid' as never);

    expect(useUiStore.getState().layout).toBe('media');
  });
});

describe('layout persistence', () => {
  it('writes the preset back to storage', async () => {
    const storage = installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().setLayout('vertical');

    expect(storage.get(STORAGE_KEY)).toBe('vertical');
  });

  it('does not persist a rejected value', async () => {
    const storage = installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().setLayout('grid' as never);

    expect(storage.has(STORAGE_KEY)).toBe(false);
  });

  it('restores a saved preset', async () => {
    installStorage({ [STORAGE_KEY]: 'media' });
    const useUiStore = await loadStore();

    expect(useUiStore.getState().layout).toBe('media');
  });

  it('falls back to the default for an unrecognized stored preset', async () => {
    // What a layout saved by a build with a preset this one no longer has looks
    // like; the app has to start in something it can actually render.
    for (const raw of ['grid', 'Default', 'DEFAULT', '', 'null', '{}']) {
      installStorage({ [STORAGE_KEY]: raw });
      const useUiStore = await loadStore();
      expect(useUiStore.getState().layout, raw).toBe('default');
    }
  });

  it('stays usable when storage is unavailable', async () => {
    // No window at all — the guard must not throw during module init.
    vi.stubGlobal('window', undefined);
    const useUiStore = await loadStore();

    expect(useUiStore.getState().layout).toBe('default');
    expect(() => useUiStore.getState().setLayout('media')).not.toThrow();
    expect(useUiStore.getState().layout).toBe('media');
  });

  it('keeps switching when a write is rejected', async () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      },
    });
    const useUiStore = await loadStore();

    expect(() => useUiStore.getState().setLayout('vertical')).not.toThrow();
    expect(useUiStore.getState().layout).toBe('vertical');
  });
});
