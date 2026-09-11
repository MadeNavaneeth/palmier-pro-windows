/**
 * Detached panels (upstream #286).
 *
 * A panel can live in its own OS window instead of in the main workspace. This
 * module is the shared contract: which panels may detach, the query the
 * detached window loads with, and that window's geometry. Pure, so the main
 * process, the renderer, and the tests read the same rules.
 *
 * Only stateless panels detach. The Agent is deliberately excluded: its visible
 * transcript is per-window renderer state, so moving it mid-conversation would
 * show an empty chat even though the main-process agent still holds the
 * history. Detaching the chat needs a transcript hand-off (and a rule refusing
 * detach while a turn is streaming), which is its own piece of work — a detach
 * button that silently drops the conversation is worse than no button.
 */

import type { Project } from '../types/project';

export const DETACHABLE_PANELS = ['media', 'inspector', 'export'] as const;

/** Panels that may live in their own window. The Agent is excluded; see above. */
export type DetachablePanel = (typeof DETACHABLE_PANELS)[number];

export function isDetachablePanel(value: unknown): value is DetachablePanel {
  return (
    value === 'media' || value === 'inspector' || value === 'export'
  );
}

export interface DetachedWindowConfig {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  /** Window title, e.g. "Media - Palmier Pro". */
  title: string;
}

export const DETACHED_WINDOW_CONFIG: Record<DetachablePanel, DetachedWindowConfig> = {
  media: { width: 480, height: 860, minWidth: 300, minHeight: 400, title: 'Media - Palmier Pro' },
  inspector: { width: 360, height: 860, minWidth: 280, minHeight: 400, title: 'Inspector - Palmier Pro' },
  export: { width: 400, height: 760, minWidth: 300, minHeight: 400, title: 'Export - Palmier Pro' },
};

/**
 * Read the panel a window should render from its query string.
 *
 * Returns null for anything that is not a detachable panel — including 'agent',
 * an empty query, and garbage — so a hand-edited URL can only ever produce the
 * normal workspace, never an empty or duplicated one.
 */
export function parseDetachedPanel(search: string): DetachablePanel | null {
  let value: string | null = null;
  try {
    value = new URLSearchParams(search).get('panel');
  } catch {
    return null;
  }
  return isDetachablePanel(value) ? value : null;
}

/**
 * Narrow an `editor:get-state` response to a project a detached window may
 * adopt.
 *
 * The detached window boots with an empty project and must pull the main
 * window's state before its sync mirror mounts; this is the read half. Only
 * the envelope is checked here (an object with `success: true` and an object
 * `data` carrying the project shape); `loadProject` throwing on anything
 * stranger is the second half.
 */
export function asMirroredProject(response: unknown): Project | null {
  if (typeof response !== 'object' || response === null) return null;
  const envelope = response as Record<string, unknown>;
  if (envelope['success'] !== true) return null;
  const data = envelope['data'];
  if (typeof data !== 'object' || data === null) return null;
  const project = data as Record<string, unknown>;
  if (typeof project['version'] !== 'number') return null;
  if (!Array.isArray(project['media'])) return null;
  if (typeof project['settings'] !== 'object' || project['settings'] === null) return null;
  if (typeof project['timeline'] !== 'object' || project['timeline'] === null) return null;
  return data as Project;
}
