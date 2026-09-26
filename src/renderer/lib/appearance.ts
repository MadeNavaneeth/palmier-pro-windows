/**
 * Appearance preference (upstream PR #430's Theme half).
 *
 * Upstream models this as `AppAppearance`: system / light / dark, persisted as
 * a short string. Upstream's stored-default for a missing or unrecognized
 * value is dark; this port degrades to system instead, because the OS theme
 * is always available through `matchMedia` and dark remains the untouched
 * default look either way.
 *
 * Pure data and narrowing only: applying the resolved theme to the document
 * lives in `hooks/useAppearanceTheme`, which is the only DOM touchpoint.
 */

export const APPEARANCES = ['system', 'light', 'dark'] as const;

export type Appearance = (typeof APPEARANCES)[number];

/** The resolved, renderable theme: `system` is never a render state. */
export type ResolvedAppearance = 'light' | 'dark';

/** Follow the OS until the user picks an explicit override. */
export const DEFAULT_APPEARANCE: Appearance = 'system';

export interface AppearanceInfo {
  id: Appearance;
  label: string;
  /** What the choice does, shown as help text. */
  description: string;
}

export const APPEARANCE_INFO: readonly AppearanceInfo[] = [
  {
    id: 'system',
    label: 'System',
    description: 'Follow the OS appearance, switching live when it changes.',
  },
  {
    id: 'light',
    label: 'Light',
    description: 'Light surfaces regardless of the OS appearance.',
  },
  {
    id: 'dark',
    label: 'Dark',
    description: 'Dark surfaces regardless of the OS appearance.',
  },
] as const;

export function appearanceInfo(appearance: Appearance): AppearanceInfo {
  // Non-null: APPEARANCE_INFO covers every member of APPEARANCES, which the
  // test suite asserts, so this cannot miss.
  return APPEARANCE_INFO.find((entry) => entry.id === appearance)!;
}

/**
 * Narrow an untrusted stored value to an appearance. The persisted value is
 * user-writable and may have been written by a build with a different set of
 * choices, so anything unrecognized degrades to following the system rather
 * than trapping the app in a theme it can no longer name.
 */
export function narrowAppearance(value: unknown): Appearance {
  return typeof value === 'string' && (APPEARANCES as readonly string[]).includes(value)
    ? (value as Appearance)
    : DEFAULT_APPEARANCE;
}

/**
 * Resolve a preference to a renderable theme. An explicit override always
 * wins; `system` tracks the OS value the caller read from `matchMedia`.
 */
export function resolveAppearance(preference: Appearance, systemDark: boolean): ResolvedAppearance {
  if (preference === 'light') return 'light';
  if (preference === 'dark') return 'dark';
  return systemDark ? 'dark' : 'light';
}
