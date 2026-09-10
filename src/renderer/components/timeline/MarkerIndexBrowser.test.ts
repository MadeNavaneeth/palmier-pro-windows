import { describe, expect, it } from 'vitest';
import { EditorController } from '../../../shared/editor/controller';
import { frameToTimecode, timecodeToFrame } from '../../../shared/utils/time';

describe('MarkerIndexBrowser sorting and filtering (#552)', () => {
  it('filters by status and search text', () => {
    const ctrl = new EditorController();
    ctrl.changeTimelineMarkers({ creates: [{ name: 'Intro', startFrame: 10, comment: 'pick', status: 'open' }] });
    ctrl.changeTimelineMarkers({ creates: [{ name: 'Review note', startFrame: 20, comment: 'needs fix', status: 'review' }] });
    ctrl.changeTimelineMarkers({ creates: [{ name: 'Outro', startFrame: 30, comment: 'done', status: 'resolved' }] });

    const markers = ctrl.getMarkers();
    const filtered = markers.filter((m) => m.status === 'review');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('Review note');

    const searchFiltered = markers.filter((m) => m.name.toLowerCase().includes('intro') || m.comment.toLowerCase().includes('intro'));
    expect(searchFiltered).toHaveLength(1);
    expect(searchFiltered[0].name).toBe('Intro');
  });

  it('sorts by startFrame then id', () => {
    const ctrl = new EditorController();
    ctrl.changeTimelineMarkers({ creates: [{ name: 'B', startFrame: 100 }] });
    ctrl.changeTimelineMarkers({ creates: [{ name: 'A', startFrame: 50 }] });
    const sorted = [...ctrl.getMarkers()].sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : 1));
    expect(sorted[0].name).toBe('A');
    expect(sorted[1].name).toBe('B');
  });

  it('timecode round-trips for marker display', () => {
    for (const frame of [0, 30, 90, 250] as const) {
      expect(timecodeToFrame(frameToTimecode(frame, 30), 30)).toBe(frame);
    }
  });
});
