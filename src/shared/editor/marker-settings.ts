/**
 * Marker preferences — the Windows translation of upstream's
 * `rippleTimelineMarkers` preference (PR #560).
 *
 * Upstream keeps review notes glued to the cut by default and lets the user
 * turn that off for program-time pins. The default here matches: markers ride
 * every ripple edit unless the preference says otherwise.
 *
 * This module is pure domain (no Electron, no React) so the renderer
 * controller, the main-process mirror the Agent edits through, and the
 * persistence layer all narrow the same way: anything that is not an explicit
 * `false` reads as on, so a setting written by a build that stored something
 * unexpected cannot silently unpin every marker.
 */

export interface MarkerSettings {
  /** When false, ripple edits move clips but leave markers where they are. */
  rippleTimelineMarkers: boolean;
}

export const DEFAULT_MARKER_SETTINGS: MarkerSettings = {
  rippleTimelineMarkers: true,
};

/**
 * Narrow an unknown persisted value into settings.
 *
 * @param fallback  Used for any field that is absent or unusable. Defaults to
 *                  the built-in settings; pass the saved settings to make a
 *                  partial input behave as an override of those.
 */
export function normalizeMarkerSettings(
  input: unknown,
  fallback: MarkerSettings = DEFAULT_MARKER_SETTINGS,
): MarkerSettings {
  const flag = (input as Partial<MarkerSettings> | null | undefined)?.rippleTimelineMarkers;
  return {
    rippleTimelineMarkers: typeof flag === 'boolean' ? flag : fallback.rippleTimelineMarkers,
  };
}
