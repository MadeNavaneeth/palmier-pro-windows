/**
 * Regression coverage for viewer guide UI state (upstream issue #167).
 *
 * Two things are worth pinning down: the set is replaced rather than mutated, or
 * subscribers never repaint, and persisted preferences are narrowed on read so a
 * hand-edited or older stored value cannot inject an unknown guide kind.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { GuideKind } from '../../shared/preview/guides';

const STORAGE_KEY = 'palmier.preview.guides';

/** Minimal localStorage stand-in; the renderer store only needs get/set. */
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

describe('guide toggling', () => {
  it('adds and removes a kind, replacing the set each time', async () => {
    installStorage();
    const useUiStore = await loadStore();

    const before = useUiStore.getState().guides;
    useUiStore.getState().toggleGuide('thirds');
    const after = useUiStore.getState().guides;

    expect(after.has('thirds')).toBe(true);
    expect(after).not.toBe(before);
    expect(before.has('thirds')).toBe(false);

    useUiStore.getState().toggleGuide('thirds');
    expect(useUiStore.getState().guides.has('thirds')).toBe(false);
  });

  it('keeps independent kinds independent', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().toggleGuide('thirds');
    useUiStore.getState().toggleGuide('center');
    expect([...useUiStore.getState().guides].sort()).toEqual(['center', 'thirds']);

    useUiStore.getState().toggleGuide('thirds');
    expect([...useUiStore.getState().guides]).toEqual(['center']);
  });

  it('drives both safe areas together', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().setSafeAreaGuides(true);
    expect(useUiStore.getState().guides.has('actionSafe')).toBe(true);
    expect(useUiStore.getState().guides.has('titleSafe')).toBe(true);

    useUiStore.getState().setSafeAreaGuides(false);
    expect(useUiStore.getState().guides.has('actionSafe')).toBe(false);
    expect(useUiStore.getState().guides.has('titleSafe')).toBe(false);
  });

  it('leaves other guides alone when clearing safe areas', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().toggleGuide('thirds');
    useUiStore.getState().setSafeAreaGuides(true);
    useUiStore.getState().setSafeAreaGuides(false);
    expect([...useUiStore.getState().guides]).toEqual(['thirds']);
  });

  it('clears everything at once', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().toggleGuide('thirds');
    useUiStore.getState().toggleGuide('grid');
    useUiStore.getState().clearGuides();
    expect(useUiStore.getState().guides.size).toBe(0);
  });
});

describe('guide persistence', () => {
  it('writes the selection back to storage', async () => {
    const storage = installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().toggleGuide('titleSafe');
    expect(JSON.parse(storage.get(STORAGE_KEY)!)).toEqual(['titleSafe']);
  });

  it('restores a previously saved selection', async () => {
    installStorage({ [STORAGE_KEY]: JSON.stringify(['thirds', 'center']) });
    const useUiStore = await loadStore();

    expect([...useUiStore.getState().guides].sort()).toEqual(['center', 'thirds']);
  });

  it('discards unknown kinds but keeps valid ones', async () => {
    installStorage({
      [STORAGE_KEY]: JSON.stringify(['thirds', 'legacy-overlay', 42, null, 'grid']),
    });
    const useUiStore = await loadStore();

    expect([...useUiStore.getState().guides].sort()).toEqual(['grid', 'thirds']);
  });

  it('falls back to no guides for malformed or unexpected stored data', async () => {
    for (const raw of ['not json', '{"thirds":true}', '"thirds"', 'null', '']) {
      installStorage({ [STORAGE_KEY]: raw });
      const useUiStore = await loadStore();
      expect(useUiStore.getState().guides.size, raw).toBe(0);
    }
  });

  it('starts empty and stays usable when storage is unavailable', async () => {
    // No window at all — the guard must not throw during module init.
    vi.stubGlobal('window', undefined);
    const useUiStore = await loadStore();

    expect(useUiStore.getState().guides.size).toBe(0);
    expect(() => useUiStore.getState().toggleGuide('thirds')).not.toThrow();
    expect(useUiStore.getState().guides.has('thirds' as GuideKind)).toBe(true);
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

    expect(() => useUiStore.getState().toggleGuide('grid')).not.toThrow();
    expect(useUiStore.getState().guides.has('grid')).toBe(true);
  });
});

describe('overlay + panel toggles', () => {
  it('the export surface is a workspace panel, not a modal (#166)', async () => {
    installStorage();
    const useUiStore = await loadStore();

    // Export rides the persisted panel flags now: Ctrl+M toggles it, and it
    // does not fight the shortcut sheet for the screen.
    expect(useUiStore.getState().panels.export).toBe(false);
    useUiStore.getState().togglePanel('export');
    expect(useUiStore.getState().panels.export).toBe(true);

    useUiStore.getState().openShortcutHelp();
    expect(useUiStore.getState().shortcutHelpOpen).toBe(true);
    expect(useUiStore.getState().panels.export).toBe(true);
  });

  it('toggles the shortcut sheet', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().toggleShortcutHelp();
    expect(useUiStore.getState().shortcutHelpOpen).toBe(true);
    useUiStore.getState().toggleShortcutHelp();
    expect(useUiStore.getState().shortcutHelpOpen).toBe(false);
  });
});
