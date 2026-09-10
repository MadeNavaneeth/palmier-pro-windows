/**
 * Regression coverage for panel tab grouping (upstream #286).
 *
 * #286 asks for the workspace panels to be turnable into tabs. The state that
 * makes that work is a partition of the four panels into ordered groups, each
 * group's first entry the region anchor. These tests pin the parts that are easy
 * to get subtly wrong: the partition survives a restart, a stored value written
 * by another build cannot duplicate or invent a panel, regrouping never moves
 * the Agent into a region that would remount its chat, and visibility and preset
 * remain orthogonal to grouping.
 *
 * Stored values are narrowed on read for the same reason every other layout key
 * is: the file is user-writable and may predate the panels this build has.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_PANEL_GROUPS,
  assignPanelToGroup,
  normalizePanelGroups,
  othersInRegion,
  regionAnchorOf,
  visibleMembers,
  type PanelVisibility,
} from '../../shared/ui/panel-groups';

const STORAGE_KEY = 'palmier.layout.panelGroups';

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

describe('panel grouping', () => {
  it('starts with every panel in its own region', async () => {
    installStorage();
    const useUiStore = await loadStore();

    expect(useUiStore.getState().groups).toEqual([
      ['media'],
      ['inspector'],
      ['agent'],
      ['export'],
    ]);
  });

  it('puts two panels in one region and replaces the array so subscribers repaint', async () => {
    installStorage();
    const useUiStore = await loadStore();

    const before = useUiStore.getState().groups;
    useUiStore.getState().assignPanel('media', 'inspector');

    const after = useUiStore.getState().groups;
    expect(after).not.toBe(before);
    expect(regionAnchorOf(after, 'media')).toBe('inspector');
    expect(othersInRegion(after, 'inspector')).toEqual(['media']);
  });

  it('joins a region that already has members', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().assignPanel('media', 'inspector');
    useUiStore.getState().assignPanel('export', 'inspector');

    const groups = useUiStore.getState().groups;
    expect(groups.find((group) => group[0] === 'inspector')).toEqual([
      'inspector',
      'media',
      'export',
    ]);
    expect(groups.find((group) => group.includes('media'))).toBe(
      groups.find((group) => group.includes('export')),
    );
  });

  it('ungroups a panel without dropping its former groupmates', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().assignPanel('media', 'inspector');
    useUiStore.getState().assignPanel('media', 'media'); // anchor to self = standalone

    const groups = useUiStore.getState().groups;
    expect(othersInRegion(groups, 'media')).toEqual([]);
    // Inspector is no longer the anchor of a region that includes media, but it
    // is still its own region rather than vanishing.
    expect(regionAnchorOf(groups, 'inspector')).toBe('inspector');
  });

  it('removing the anchor collapses the region to its remaining members', async () => {
    const groups = assignPanelToGroup(
      [['agent', 'media', 'inspector'], ['export']],
      'agent',
      'agent',
    );

    // Agent leaves; media and inspector stay in a region, now anchored at media.
    expect(othersInRegion(groups, 'media')).toEqual(['inspector']);
    expect(regionAnchorOf(groups, 'media')).toBe('media');
    expect(othersInRegion(groups, 'agent')).toEqual([]);
    expect(regionAnchorOf(groups, 'export')).toBe('export');
  });

  it('keeps the Agent as its region anchor so ChatPanel is never remounted', async () => {
    installStorage();
    const useUiStore = await loadStore();

    // Whichever direction the request comes from, the Agent stays the anchor and
    // the other panel is the one that moves.
    useUiStore.getState().assignPanel('agent', 'media');
    let groups = useUiStore.getState().groups;
    expect(regionAnchorOf(groups, 'agent')).toBe('agent');
    expect(regionAnchorOf(groups, 'media')).toBe('agent');

    useUiStore.getState().assignPanel('inspector', 'agent');
    groups = useUiStore.getState().groups;
    expect(regionAnchorOf(groups, 'inspector')).toBe('agent');
    expect(groups.find((group) => group[0] === 'agent')).toEqual([
      'agent',
      'media',
      'inspector',
    ]);
  });

  it('never lists a panel twice', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().assignPanel('media', 'inspector');
    useUiStore.getState().assignPanel('media', 'export');
    useUiStore.getState().assignPanel('media', 'inspector');

    const occurrences = useUiStore
      .getState()
      .groups.flat()
      .filter((panel) => panel === 'media');
    expect(occurrences).toEqual(['media']);
  });

  it('ignores an untyped caller instead of persisting an unplaceable grouping', async () => {
    installStorage();
    const useUiStore = await loadStore();
    const before = useUiStore.getState().groups;

    useUiStore.getState().assignPanel('ghost' as never, 'media');
    useUiStore.getState().assignPanel('media', 'ghost' as never);

    expect(useUiStore.getState().groups).toBe(before);
  });

  it('leaves grouping alone when the preset changes', async () => {
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().assignPanel('media', 'inspector');
    const groups = useUiStore.getState().groups;

    useUiStore.getState().setLayout('vertical');

    expect(useUiStore.getState().groups).toBe(groups);
  });

  it('leaves grouping alone when a panel is toggled off', async () => {
    // Invariant: hiding a tab must not orphan its group. Membership persists;
    // the renderer collapses the region to its remaining visible members.
    installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().assignPanel('media', 'inspector');
    const groups = useUiStore.getState().groups;

    useUiStore.getState().togglePanel('media');

    expect(useUiStore.getState().panels.media).toBe(false);
    expect(useUiStore.getState().groups).toBe(groups);
  });
});

describe('visible members', () => {
  it('drops hidden members and disappears when none remain', () => {
    expect(visibleMembers(['media', 'agent'], ALL_VISIBLE)).toEqual(['media', 'agent']);
    expect(visibleMembers(['media', 'agent'], { ...ALL_VISIBLE, agent: false })).toEqual(['media']);
    expect(visibleMembers(['media', 'agent'], { ...ALL_VISIBLE, media: false, agent: false })).toEqual([]);
  });
});

describe('panel grouping persistence', () => {
  it('writes the groups back to storage and restores them', async () => {
    const storage = installStorage();
    const useUiStore = await loadStore();

    useUiStore.getState().assignPanel('media', 'agent');

    expect(JSON.parse(storage.get(STORAGE_KEY)!)).toEqual([
      ['inspector'],
      ['agent', 'media'],
      ['export'],
    ]);

    const reloaded = await loadStore();
    expect(regionAnchorOf(reloaded.getState().groups, 'media')).toBe('agent');
  });

  it('drops unknown keys and duplicates but keeps valid groups', async () => {
    installStorage({
      [STORAGE_KEY]: JSON.stringify([
        ['media', 'agent', 'ghost'],
        ['media'],
        ['inspector', 'export'],
        'nope',
        [],
      ]),
    });
    const useUiStore = await loadStore();

    // The Agent is re-anchored to the front of its group on read.
    expect(useUiStore.getState().groups).toEqual([
      ['agent', 'media'],
      ['inspector', 'export'],
    ]);
  });

  it('re-anchors the Agent to its group when a stored value put it later', async () => {
    installStorage({ [STORAGE_KEY]: JSON.stringify([['media', 'agent']]) });
    const useUiStore = await loadStore();

    // A grouping written by hand or another build must not be able to move the
    // chat out of its region / remount it.
    expect(useUiStore.getState().groups[0]?.[0]).toBe('agent');
    expect(regionAnchorOf(useUiStore.getState().groups, 'media')).toBe('agent');
  });

  it('restores a panel the stored grouping omitted to its own region', async () => {
    installStorage({ [STORAGE_KEY]: JSON.stringify([['media', 'inspector']]) });
    const useUiStore = await loadStore();

    expect(useUiStore.getState().groups).toEqual([
      ['media', 'inspector'],
      ['agent'],
      ['export'],
    ]);
  });

  it('falls back to independent panels for malformed or unexpected stored data', async () => {
    for (const raw of ['not json', '{}', '"media"', 'null', '42', '']) {
      installStorage({ [STORAGE_KEY]: raw });
      const useUiStore = await loadStore();
      expect(useUiStore.getState().groups, raw).toEqual(DEFAULT_PANEL_GROUPS);
    }
  });

  it('stays usable when storage is unavailable', async () => {
    // No window at all — the guard must not throw during module init.
    vi.stubGlobal('window', undefined);
    const useUiStore = await loadStore();

    expect(useUiStore.getState().groups).toEqual(DEFAULT_PANEL_GROUPS);
    expect(() => useUiStore.getState().assignPanel('media', 'agent')).not.toThrow();
    expect(regionAnchorOf(useUiStore.getState().groups, 'media')).toBe('agent');
  });

  it('keeps grouping when a write is rejected', async () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      },
    });
    const useUiStore = await loadStore();

    expect(() => useUiStore.getState().assignPanel('media', 'inspector')).not.toThrow();
    expect(regionAnchorOf(useUiStore.getState().groups, 'media')).toBe('inspector');
  });
});

describe('normalizePanelGroups', () => {
  it('is idempotent on an already-normalized partition', () => {
    const groups = normalizePanelGroups([['agent', 'media'], ['inspector'], ['export']]);
    expect(normalizePanelGroups(groups)).toEqual(groups);
  });
});
