/**
 * Panel tab grouping (upstream #286).
 *
 * Upstream's issue says the workspace panels should "basically be turned into
 * tabs" — any two or more of them sharing one region. The arrangement presets
 * only decide where the regions sit; this module decides which panels sit in the
 * same one as tabs, entirely independent of visibility and of the preset.
 *
 * The model is deliberately a partition of {@link PANEL_KEYS} into ordered
 * groups, each group's first entry being the region's anchor. That makes the
 * four invariants the store has to keep cheap:
 *
 * - A group always occupies exactly one region, so it reuses that region's
 *   stored split width rather than carrying one of its own.
 * - A partition cannot list a panel twice, so normalization only has to drop
 *   unknown keys and hand any omitted panel its own group.
 * - Visibility stays a separate `Record<PanelKey, boolean>`: hiding a panel
 *   makes it drop out of its group at render time, and an all-hidden group
 *   simply has no region.
 * - The Agent's chat is the one panel whose region is pinned (it is always the
 *   anchor of its own group) so regrouping it never relocates its React parent
 *   and unmounts an in-progress conversation. See `assignPanelToGroup`.
 *
 * Pure data and pure functions so the store, the renderer, and the tests read
 * the same rules.
 */

export const PANEL_KEYS = ['media', 'inspector', 'agent', 'export'] as const;

export type PanelKey = (typeof PANEL_KEYS)[number];

/** Which panels are showing. Orthogonal to {@link PanelGroups}. */
export type PanelVisibility = Record<PanelKey, boolean>;

/**
 * One tab region: its members in tab order. The first entry is the region's
 * anchor, which decides where the region sits and which split dimension it uses.
 */
export type PanelGroup = readonly PanelKey[];

export type PanelGroups = readonly PanelGroup[];

export const PANEL_LABELS: Record<PanelKey, string> = {
  media: 'Media',
  inspector: 'Inspector',
  agent: 'Agent',
  export: 'Export',
};

/** Each panel in its own region — the current independent-columns behaviour. */
export const DEFAULT_PANEL_GROUPS: PanelGroups = [['media'], ['inspector'], ['agent'], ['export']];

export function isPanelKey(value: unknown): value is PanelKey {
  return typeof value === 'string' && (PANEL_KEYS as readonly string[]).includes(value);
}

function cloneGroups(groups: PanelGroups): PanelKey[][] {
  return groups.map((group) => [...group]);
}

/**
 * Narrow an untrusted stored value to a partition of {@link PANEL_KEYS}.
 *
 * The stored file is user-writable and may come from a build with a different
 * set of panels, so entries are narrowed rather than trusted: unknown keys are
 * dropped, a panel appears at most once across the whole set, empty groups
 * disappear, and any panel the stored value omitted falls back to its own
 * region. A malformed payload degrades to the independent-columns default
 * instead of producing an empty workspace.
 */
export function normalizePanelGroups(value: unknown): PanelKey[][] {
  if (!Array.isArray(value)) return cloneGroups(DEFAULT_PANEL_GROUPS);
  const seen = new Set<PanelKey>();
  const groups: PanelKey[][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry)) continue;
    const group: PanelKey[] = [];
    for (const item of entry) {
      if (isPanelKey(item) && !seen.has(item)) {
        seen.add(item);
        group.push(item);
      }
    }
    if (group.length > 0) groups.push(group);
  }
  for (const panel of PANEL_KEYS) {
    if (!seen.has(panel)) groups.push([panel]);
  }
  return groups.map(anchorAgentFirst);
}

/**
 * Force the Agent to the front of its group.
 *
 * The Agent has to remain the anchor of its region or the region that holds it
 * changes React parent — and remounts the chat. `assignPanelToGroup` maintains
 * that on every user action, but a grouping written by hand or by another build
 * could put the Agent at the end of a group, so it is corrected on read too.
 */
function anchorAgentFirst(group: PanelKey[]): PanelKey[] {
  const index = group.indexOf('agent');
  if (index <= 0) return group;
  const next = [...group];
  next.splice(index, 1);
  next.unshift('agent');
  return next;
}

/** The anchor (region) a panel currently belongs to, or the panel itself. */
export function regionAnchorOf(groups: PanelGroups, panel: PanelKey): PanelKey {
  for (const group of groups) {
    if (group.includes(panel)) return group[0];
  }
  return panel;
}

/** The other panels sharing a panel's region, in tab order. */
export function othersInRegion(groups: PanelGroups, panel: PanelKey): PanelKey[] {
  const group = groups.find((entry) => entry.includes(panel));
  return group ? group.filter((member) => member !== panel) : [];
}

/** Visible members of one group. An empty result means the region disappears. */
export function visibleMembers(group: PanelGroup, panels: PanelVisibility): PanelKey[] {
  return group.filter((panel) => panels[panel]);
}

/**
 * Members that render in the main workspace: visible and not detached.
 *
 * A detached panel lives in its own OS window, so it must drop out of its
 * region without mutating the group itself — the membership stays intact so
 * the model keeps working while members come and go across the detach
 * boundary.
 */
export function dockedMembers(
  group: PanelGroup,
  panels: PanelVisibility,
  detached: readonly PanelKey[],
): PanelKey[] {
  return visibleMembers(group, panels).filter((panel) => !detached.includes(panel));
}

/**
 * Remove a panel from wherever it is and append it to the group that owns
 * `anchor`. Passing the panel as its own anchor makes it standalone. Removing a
 * panel from a group leaves the remaining members in their own group, which is
 * how a region "collapses" when one of its tabs is hidden or leaves.
 */
function moveMember(groups: PanelGroups, member: PanelKey, anchor: PanelKey): PanelKey[][] {
  const next = groups
    .map((group) => group.filter((entry) => entry !== member))
    .filter((group) => group.length > 0)
    .map((group) => [...group]);

  if (anchor === member) return [...next, [member]];

  const index = next.findIndex((group) => group.includes(anchor));
  if (index === -1) return [...next, [anchor, member]];
  next[index] = [...next[index], member];
  return next;
}

/**
 * Put `panel` in the same region as `anchor`.
 *
 * The Agent is special-cased on purpose: it is always the anchor of its own
 * region. If it moved into someone else's region instead, its React parent would
 * change and `ChatPanel` would remount, dropping the draft and scroll of an
 * in-progress conversation — the constraint upstream #286 calls out. So an
 * "Agent with Media" request is served by moving Media into the Agent's region,
 * which is exactly the same visible result without ever moving the chat.
 */
export function assignPanelToGroup(
  groups: PanelGroups,
  panel: PanelKey,
  anchor: PanelKey,
): PanelKey[][] {
  const target = panel === 'agent' || anchor === 'agent' ? 'agent' : anchor;
  if (target === panel) {
    // `panel` is the Agent and `anchor` is another panel: bring that panel over.
    return moveMember(groups, anchor, panel);
  }
  if (panel === anchor) return moveMember(groups, panel, panel);
  return moveMember(groups, panel, target);
}

/** Structural equality, so a no-op assignment does not repaint or persist. */
export function samePanelGroups(a: PanelGroups, b: PanelGroups): boolean {
  if (a.length !== b.length) return false;
  return a.every((group, index) => {
    const other = b[index];
    return other.length === group.length && group.every((panel, i) => panel === other[i]);
  });
}
