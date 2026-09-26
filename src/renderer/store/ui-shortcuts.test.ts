/**
 * Regression coverage for the persisted keyboard preset (upstream #579).
 *
 * The preset is a per-machine preference: an editor coming from Final Cut Pro
 * expects their chords on every launch without touching the project, so the
 * choice rides localStorage like the layout preset and is narrowed on read. A
 * stale value written by a build with a different preset list must start the app
 * on the default table instead of an unknown one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const STORAGE_KEY = 'palmier.shortcuts.preset';

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

describe('shortcut preset switching', () => {
  it('starts on the default preset', async () => {
    installStorage();
    const useUiStore = await loadStore();

    expect(useUiStore.getState().shortcutPreset).toBe('default');
  });

  it('switches to the Final Cut Pro preset and back', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().setShortcutPreset('fcp');
    expect(useUiStore.getState().shortcutPreset).toBe('fcp');

    useUiStore.getState().setShortcutPreset('default');
    expect(useUiStore.getState().shortcutPreset).toBe('default');
  });

  it('ignores a value that is not a preset', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().setShortcutPreset('premiere' as never);

    expect(useUiStore.getState().shortcutPreset).toBe('default');
  });

  it('leaves the workspace and panels alone', async () => {
    // UI-only: switching presets must not move the layout or reopen panels.
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().setLayout('vertical');
    useUiStore.getState().togglePanel('media');
    const layout = useUiStore.getState().layout;
    const panels = useUiStore.getState().panels;

    useUiStore.getState().setShortcutPreset('fcp');

    expect(useUiStore.getState().layout).toBe(layout);
    expect(useUiStore.getState().panels).toBe(panels);
  });
});

describe('shortcut preset persistence', () => {
  it('writes the preset back to storage', async () => {
    const storage = installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().setShortcutPreset('fcp');

    expect(storage.get(STORAGE_KEY)).toBe('fcp');
  });

  it('does not persist a rejected value', async () => {
    const storage = installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().setShortcutPreset('premiere' as never);

    expect(storage.has(STORAGE_KEY)).toBe(false);
  });

  it('restores a saved preset', async () => {
    installStorage({ [STORAGE_KEY]: 'fcp' });
    const useUiStore = await loadStore();

    expect(useUiStore.getState().shortcutPreset).toBe('fcp');
  });

  it('falls back to the default for an unrecognized stored preset', async () => {
    // What a preset saved by a build with a different list looks like; the app
    // has to start on chords it can actually dispatch.
    for (const raw of ['premiere', 'FCP', 'fcp ', '', 'null', '{}']) {
      installStorage({ [STORAGE_KEY]: raw });
      const useUiStore = await loadStore();
      expect(useUiStore.getState().shortcutPreset, raw).toBe('default');
    }
  });

  it('stays usable when storage is unavailable', async () => {
    // No window at all — the guard must not throw during module init.
    vi.stubGlobal('window', undefined);
    const useUiStore = await loadStore();

    expect(useUiStore.getState().shortcutPreset).toBe('default');
    expect(() => useUiStore.getState().setShortcutPreset('fcp')).not.toThrow();
    expect(useUiStore.getState().shortcutPreset).toBe('fcp');
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

    expect(() => useUiStore.getState().setShortcutPreset('fcp')).not.toThrow();
    expect(useUiStore.getState().shortcutPreset).toBe('fcp');
  });
});
