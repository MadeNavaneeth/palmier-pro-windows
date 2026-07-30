/**
 * Regression coverage for the persisted panel layout (upstream #286).
 *
 * #286 asks to be able to restructure the workspace — to work with, say, only the
 * timeline and video in view. Hiding panels already worked; the part worth pinning
 * down is that the choice survives a restart, because a layout that resets on
 * every launch means re-hiding the same panels each time and the feature stops
 * being useful. Stored values are narrowed on read for the same reason the guide
 * set is: the file is user-writable and may come from a build with a different set
 * of panels.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const STORAGE_KEY = 'palmier.layout.panels';
const DEFAULTS = { media: true, inspector: true, agent: false };

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

describe('panel toggling', () => {
  it('starts on the first-run layout', async () => {
    installStorage();
    const useUiStore = await loadStore();

    expect(useUiStore.getState().panels).toEqual(DEFAULTS);
  });

  it('flips one panel and replaces the object so subscribers repaint', async () => {
    installStorage();
    const useUiStore = await loadStore();

    const before = useUiStore.getState().panels;
    useUiStore.getState().togglePanel('agent');
    const after = useUiStore.getState().panels;

    expect(after.agent).toBe(true);
    expect(after).not.toBe(before);
    expect(before.agent).toBe(false);
  });

  it('keeps the panels independent', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().togglePanel('media');
    useUiStore.getState().togglePanel('inspector');

    // The reduced layout #286 asks for: timeline and video only.
    expect(useUiStore.getState().panels).toEqual({
      media: false, inspector: false, agent: false,
    });

    useUiStore.getState().togglePanel('media');
    expect(useUiStore.getState().panels.media).toBe(true);
    expect(useUiStore.getState().panels.inspector).toBe(false);
  });

  it('restores the first-run layout on reset', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().togglePanel('media');
    useUiStore.getState().togglePanel('agent');
    useUiStore.getState().resetPanels();

    expect(useUiStore.getState().panels).toEqual(DEFAULTS);
  });
});

describe('panel persistence', () => {
  it('writes the layout back to storage', async () => {
    const storage = installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().togglePanel('agent');

    expect(JSON.parse(storage.get(STORAGE_KEY)!)).toEqual({
      media: true, inspector: true, agent: true,
    });
  });

  it('restores a saved layout', async () => {
    installStorage({
      [STORAGE_KEY]: JSON.stringify({ media: false, inspector: false, agent: true }),
    });
    const useUiStore = await loadStore();

    expect(useUiStore.getState().panels).toEqual({
      media: false, inspector: false, agent: true,
    });
  });

  it('fills in a panel the stored layout does not mention', async () => {
    // What a layout saved by an older build looks like.
    installStorage({ [STORAGE_KEY]: JSON.stringify({ media: false }) });
    const useUiStore = await loadStore();

    expect(useUiStore.getState().panels).toEqual({
      media: false, inspector: true, agent: false,
    });
  });

  it('ignores values that are not booleans', async () => {
    installStorage({
      [STORAGE_KEY]: JSON.stringify({ media: 'yes', inspector: 0, agent: true, ghost: true }),
    });
    const useUiStore = await loadStore();

    expect(useUiStore.getState().panels).toEqual({
      media: true, inspector: true, agent: true,
    });
    expect('ghost' in useUiStore.getState().panels).toBe(false);
  });

  it('falls back to the defaults for malformed stored data', async () => {
    for (const raw of ['not json', '[]', '"media"', 'null', '42', '']) {
      installStorage({ [STORAGE_KEY]: raw });
      const useUiStore = await loadStore();
      expect(useUiStore.getState().panels, raw).toEqual(DEFAULTS);
    }
  });

  it('stays usable when storage is unavailable', async () => {
    // No window at all — the guard must not throw during module init.
    vi.stubGlobal('window', undefined);
    const useUiStore = await loadStore();

    expect(useUiStore.getState().panels).toEqual(DEFAULTS);
    expect(() => useUiStore.getState().togglePanel('agent')).not.toThrow();
    expect(useUiStore.getState().panels.agent).toBe(true);
  });

  it('keeps toggling when a write is rejected', async () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      },
    });
    const useUiStore = await loadStore();

    expect(() => useUiStore.getState().togglePanel('media')).not.toThrow();
    expect(useUiStore.getState().panels.media).toBe(false);
  });
});
