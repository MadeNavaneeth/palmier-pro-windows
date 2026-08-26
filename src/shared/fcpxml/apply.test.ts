/**
 * Apply-plan coverage: exporter → parser → applyFcpxmlPlan onto a real
 * controller, asserting track synthesis, frame mapping, title styling, and
 * the offline-skip counter.
 */
import { describe, it, expect } from 'vitest';
import { EditorController } from '../editor/controller';
import { exportFcpxml } from './exporter';
import { parseFcpxml } from './importer';
import { applyFcpxmlPlan } from './apply';

function sourceProject(): EditorController {
  const editor = new EditorController();
  editor.addMedia({
    id: 'm',
    path: 'X:/media/music.wav',
    filename: 'music.wav',
    type: 'audio',
    duration: 90,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  const id = editor.addClip({ assetId: 'm', trackId: 'a1', startFrame: 30, durationFrames: 30 });
  editor.trimClip(id, 0, 30);
  return editor;
}

describe('applyFcpxmlPlan (#154 wiring core)', () => {
  it('synthesizes lanes and places clips with mapped frames', () => {
    const source = sourceProject();
    const plan = parseFcpxml(exportFcpxml(source.getProject()));

    // The importer needs a media asset to exist for the path; simulate the
    // caller having added it by handing over the same id the source used.
    const target = new EditorController();
    target.addMedia({
      id: 'imported-music',
      path: 'X:/media/music.wav',
      filename: 'music.wav',
      type: 'audio',
      duration: 90,
      fileSize: 1,
      addedAt: new Date().toISOString(),
    });

    const result = applyFcpxmlPlan(target, plan, new Map([
      ['X:/media/music.wav', 'imported-music'],
    ]));

    expect(result.tracksCreated).toBeGreaterThanOrEqual(2); // spine video + audio lane
    expect(result.placedClips).toBe(1);

    // Imported clip lives on a synthesized audio track at the exported spot.
    const synthAudio = target.getTracks().filter((t) => t.type === 'audio').slice(-1)[0]!;
    const clip = target.getClips().find((c) => c.trackId === synthAudio.id)!;
    expect(clip.startFrame).toBe(30);
    expect(clip.inPoint).toBe(0);
  });

  it('counts skips when an asset is offline', () => {
    const source = sourceProject();
    let xml = exportFcpxml(source.getProject()).replace(
      /src="file:\/\/\/[^"]*"/,
      'src="file:///Z:/gone.wav"',
    );
    const plan = parseFcpxml(xml);

    const target = new EditorController();
    const result = applyFcpxmlPlan(target, plan, new Map()); // nothing added

    expect(result.placedClips).toBe(0);
    expect(result.skippedOffline).toBe(1);
    expect(target.getTracks().some((t) => t.type === 'audio')).toBe(true); // lanes still synthesized
  });

  it('restores title styling through the shared pass', () => {
    const source = new EditorController();
    source.addTitleClip({
      trackId: 'v1', text: 'Styled', startFrame: 0, durationFrames: 45,
    });
    source.applyClipProperties([source.getClips()[0].id], 'Style', (draft) => {
      draft.titleColor = '#ffcc00';
      draft.titleSizeRatio = 0.08;
      draft.titleFontFamily = 'Georgia';
      draft.titleAlign = 'left';
      return true;
    });

    const plan = parseFcpxml(exportFcpxml(source.getProject()));
    const target = new EditorController();
    const result = applyFcpxmlPlan(target, plan, new Map());

    expect(result.titles).toBe(1);
    const imported = target.getClips()[0];
    expect(imported.text).toBe('Styled');
    expect(imported.titleColor).toBe('#FFCC00');
    // FCPXML fontSize is integer-px, so ratio↔px is ±1px lossy by design.
    expect(imported.titleSizeRatio).toBeCloseTo(0.08, 2);
    expect(imported.titleFontFamily).toBe('Georgia');
    expect(imported.titleAlign).toBe('left');
  });
});
