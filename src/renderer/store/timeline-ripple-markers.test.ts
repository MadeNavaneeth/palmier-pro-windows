/**
 * Regression coverage for the marker-ripple preference in the timeline store
 * (upstream PR #560): the toggle flips the store controller's flag, and both
 * actions survive without a preload bridge (unit tests run in node).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { useTimelineStore } from './timeline';

describe('rippleMarkers store surface (#560)', () => {
  afterEach(() => {
    // The store is a module singleton shared across test files.
    useTimelineStore.getState().setRippleMarkers(true);
  });

  it('defaults to on, matching upstream', () => {
    expect(useTimelineStore.getState().rippleMarkers).toBe(true);
    expect(useTimelineStore.getState().controller.isRippleTimelineMarkers()).toBe(true);
  });

  it('flips the controller flag and state together', () => {
    useTimelineStore.getState().setRippleMarkers(false);

    expect(useTimelineStore.getState().rippleMarkers).toBe(false);
    expect(useTimelineStore.getState().controller.isRippleTimelineMarkers()).toBe(false);

    useTimelineStore.getState().setRippleMarkers(true);

    expect(useTimelineStore.getState().rippleMarkers).toBe(true);
    expect(useTimelineStore.getState().controller.isRippleTimelineMarkers()).toBe(true);
  });

  it('keeps the default when no preload bridge exists', () => {
    expect(() => useTimelineStore.getState().loadRippleMarkers()).not.toThrow();
    expect(useTimelineStore.getState().rippleMarkers).toBe(true);
  });
});
