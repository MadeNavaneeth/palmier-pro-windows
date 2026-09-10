/**
 * Regression coverage for the marker editor popover's store surface
 * (upstream PR #542): color and comment patch through updateMarker with
 * domain validation, so the hand-edit path cannot diverge from the Agent's.
 */

import { describe, it, expect } from 'vitest';
import { useTimelineStore } from './timeline';

function storeWithMarker() {
  const store = useTimelineStore;
  const controller = store.getState().controller;
  const staleIds = controller.getMarkers().map((marker) => marker.id);
  if (staleIds.length > 0) controller.changeTimelineMarkers({ deleteIds: staleIds });
  const receipt = controller.changeTimelineMarkers({
    creates: [{ name: 'M', startFrame: 100 }],
  })!;
  return { store, controller, id: receipt.created[0].id };
}

describe('marker editor store surface (#542)', () => {
  it('patches color and comment', () => {
    const { store, controller, id } = storeWithMarker();

    expect(store.getState().updateMarker(id, { color: '#ef4444', comment: 'Pick this take' })).toBe(true);

    expect(controller.getMarkers().find((m) => m.id === id)).toMatchObject({
      color: '#ef4444',
      comment: 'Pick this take',
    });
  });

  it('refuses an invalid color without touching the marker', () => {
    const { store, controller, id } = storeWithMarker();

    expect(store.getState().updateMarker(id, { color: 'red' })).toBe(false);

    expect(controller.getMarkers().find((m) => m.id === id)?.color).toBe('#007AFF');
  });

  it('refuses an overlong comment without touching the marker', () => {
    const { store, controller, id } = storeWithMarker();

    expect(store.getState().updateMarker(id, { comment: 'x'.repeat(4001) })).toBe(false);

    expect(controller.getMarkers().find((m) => m.id === id)?.comment).toBe('');
  });
});
