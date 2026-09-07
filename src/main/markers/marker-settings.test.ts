/**
 * Regression coverage for the saved marker preferences (upstream PR #560).
 *
 * Runs outside Electron, so `app` is unavailable and the persistent store is
 * never constructed. That is the interesting case: the preference still has
 * to work for the session, because the alternative is a toolbar toggle that
 * appears to flip and then silently has no effect on the next ripple edit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadMarkerSettings,
  saveMarkerSettings,
  resetMarkerSettingsCache,
} from './marker-settings';
import { DEFAULT_MARKER_SETTINGS } from '../../shared/editor/marker-settings';

describe('marker settings', () => {
  beforeEach(() => {
    resetMarkerSettingsCache();
  });

  it('starts from the built-in defaults when nothing is saved', () => {
    expect(loadMarkerSettings()).toEqual(DEFAULT_MARKER_SETTINGS);
    expect(loadMarkerSettings().rippleTimelineMarkers).toBe(true);
  });

  it('persists an opt-out for the session', () => {
    saveMarkerSettings({ rippleTimelineMarkers: false });

    expect(loadMarkerSettings()).toEqual({ rippleTimelineMarkers: false });
  });

  it('returns the value it actually stored, so the toolbar reconciles to it', () => {
    const saved = saveMarkerSettings({ rippleTimelineMarkers: false });
    expect(saved).toEqual({ rippleTimelineMarkers: false });
    expect(loadMarkerSettings().rippleTimelineMarkers).toBe(false);
  });

  it('narrows junk back to the default instead of unpinning markers', () => {
    saveMarkerSettings({ rippleTimelineMarkers: 'no' });

    expect(loadMarkerSettings()).toEqual({ rippleTimelineMarkers: true });
  });

  it('keeps the saved value when handed an unusable update', () => {
    saveMarkerSettings({ rippleTimelineMarkers: false });
    saveMarkerSettings(undefined);

    expect(loadMarkerSettings().rippleTimelineMarkers).toBe(false);
  });
});
