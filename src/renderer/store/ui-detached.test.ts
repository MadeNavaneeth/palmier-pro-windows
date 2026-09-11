/**
 * Regression coverage for detached panels (upstream #286).
 *
 * A panel in its own OS window is moved, not copied: the main window must
 * suppress it, the tab-group data must survive members crossing the detach
 * boundary, and the main process — not the renderer — owns the detached set.
 * The store therefore mirrors announcements rather than persisting them, and
 * narrows every payload the same way it narrows stored values: the file is
 * user-writable, and an IPC payload is untrusted input.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  dockedMembers,
  othersInRegion,
  regionAnchorOf,
  type PanelVisibility,
} from '../../shared/ui/panel-groups';

const ALL_VISIBLE: PanelVisibility = {
  media: true,
  inspector: true,
  agent: true,
  export: true,
};

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

describe('detached panels', () => {
  it('starts with nothing detached', async () => {
    installStorage();
    const useUiStore = await loadStore();

    expect(useUiStore.getState().detached).toEqual([]);
  });

  it('narrows an announced list to known detachable panels', async () => {
    installStorage();
    const useUiStore = await loadStore();

    // 'agent' can never detach (its transcript is per-window renderer state),
    // 'ghost' is not a panel, 42 is not a string, and the duplicate collapses.
    useUiStore.getState().setDetachedPanels(['media', 'agent', 'ghost', 42, 'media', 'export']);

    expect(useUiStore.getState().detached).toEqual(['media', 'export']);
  });

  it('treats a non-list announcement as nothing detached', async () => {
    for (const raw of [{ media: true }, 'media', null, undefined, 42]) {
      installStorage();
      const useUiStore = await loadStore();

      useUiStore.getState().setDetachedPanels(['media']);
      useUiStore.getState().setDetachedPanels(raw);

      // Garbage restores panels rather than hiding them.
      expect(useUiStore.getState().detached, JSON.stringify(raw)).toEqual([]);
    }
  });

  it('leaves the tab groups alone when a panel detaches', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().assignPanel('media', 'inspector');
    const groups = useUiStore.getState().groups;

    useUiStore.getState().setDetachedPanels(['media']);

    // The docked member collapses at render time; the data is untouched so a
    // re-attach has a group to reason about.
    expect(useUiStore.getState().groups).toBe(groups);
  });

  it('restores a re-attached panel to a standalone region', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().assignPanel('media', 'inspector');
    useUiStore.getState().setDetachedPanels(['media']);
    useUiStore.getState().setDetachedPanels([]);

    const groups = useUiStore.getState().groups;
    expect(othersInRegion(groups, 'media')).toEqual([]);
    expect(regionAnchorOf(groups, 'media')).toBe('media');
    // The group it left collapses to its remaining member.
    expect(othersInRegion(groups, 'inspector')).toEqual([]);
  });

  it('ignores a redundant announcement without repainting', async () => {
    installStorage();
    const useUiStore = await loadStore();

    const before = useUiStore.getState().detached;
    useUiStore.getState().setDetachedPanels([]);

    expect(useUiStore.getState().detached).toBe(before);
  });

  it('does not persist the detached set', async () => {
    const storage = installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().setDetachedPanels(['media', 'export']);

    // Windows die with the process; a stored set would suppress a panel that
    // is actually docked on the next launch.
    expect([...storage.keys()].some((key) => key.includes('detach'))).toBe(false);
  });

  it('stays usable when storage is unavailable', async () => {
    vi.stubGlobal('window', undefined);
    const useUiStore = await loadStore();

    expect(useUiStore.getState().detached).toEqual([]);
    expect(() => useUiStore.getState().setDetachedPanels(['media'])).not.toThrow();
    expect(useUiStore.getState().detached).toEqual(['media']);
  });
});

describe('dockedMembers', () => {
  it('keeps visible, docked members', async () => {
    expect(dockedMembers(['media', 'inspector'], ALL_VISIBLE, [])).toEqual([
      'media',
      'inspector',
    ]);
  });

  it('drops hidden and detached members', async () => {
    expect(
      dockedMembers(['media', 'inspector', 'agent'], { ...ALL_VISIBLE, agent: false }, ['media']),
    ).toEqual(['inspector']);
  });

  it('empties a region whose members are all detached', async () => {
    expect(dockedMembers(['inspector', 'export'], ALL_VISIBLE, ['inspector', 'export'])).toEqual(
      [],
    );
  });
});
