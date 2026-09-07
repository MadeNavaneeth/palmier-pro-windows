import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKER_SETTINGS,
  normalizeMarkerSettings,
} from './marker-settings';

describe('normalizeMarkerSettings', () => {
  it('defaults to rippling markers with edits', () => {
    expect(normalizeMarkerSettings(undefined)).toEqual({ rippleTimelineMarkers: true });
    expect(normalizeMarkerSettings({})).toEqual({ rippleTimelineMarkers: true });
    expect(DEFAULT_MARKER_SETTINGS.rippleTimelineMarkers).toBe(true);
  });

  it('keeps an explicit opt-out', () => {
    expect(normalizeMarkerSettings({ rippleTimelineMarkers: false })).toEqual({
      rippleTimelineMarkers: false,
    });
    expect(normalizeMarkerSettings({ rippleTimelineMarkers: true })).toEqual({
      rippleTimelineMarkers: true,
    });
  });

  it('narrows junk from a user-writable settings file back to a boolean', () => {
    expect(normalizeMarkerSettings(null)).toEqual({ rippleTimelineMarkers: true });
    expect(normalizeMarkerSettings({ rippleTimelineMarkers: 'no' })).toEqual({
      rippleTimelineMarkers: true,
    });
    expect(normalizeMarkerSettings({ rippleTimelineMarkers: 0 })).toEqual({
      rippleTimelineMarkers: true,
    });
  });

  it('merges a partial update over saved settings', () => {
    const saved = normalizeMarkerSettings({ rippleTimelineMarkers: false });
    expect(normalizeMarkerSettings(undefined, saved)).toEqual({
      rippleTimelineMarkers: false,
    });
    expect(normalizeMarkerSettings({}, saved)).toEqual({ rippleTimelineMarkers: false });
    expect(normalizeMarkerSettings({ rippleTimelineMarkers: true }, saved)).toEqual({
      rippleTimelineMarkers: true,
    });
  });
});
