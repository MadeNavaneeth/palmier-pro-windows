import { describe, expect, it } from 'vitest';
import { EditorController } from './controller';

function asset() {
  return {
    id: 'a1',
    path: 'D:/footage/clip.mp4',
    filename: 'clip.mp4',
    type: 'video' as const,
    duration: 300,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  };
}

describe('setAssetDescription (#118 AI half)', () => {
  it('writes a sanitized description as one undoable step', () => {
    const ctrl = new EditorController();
    ctrl.addMedia(asset());
    expect(ctrl.setAssetDescription('a1', '  A red\u0000car  by the beach  ')).toBe(true);
    expect(ctrl.getMedia()[0].aiDescription).toBe('A red car by the beach');

    ctrl.undo();
    expect(ctrl.getMedia()[0].aiDescription).toBeUndefined();

    ctrl.redo();
    expect(ctrl.getMedia()[0].aiDescription).toBe('A red car by the beach');
  });

  it('clears on blank and refuses unknown assets', () => {
    const ctrl = new EditorController();
    ctrl.addMedia({ ...asset(), aiDescription: 'A car.' });
    expect(ctrl.setAssetDescription('a1', '   ')).toBe(true);
    expect(ctrl.getMedia()[0].aiDescription).toBeUndefined();
    expect(ctrl.setAssetDescription('ghost', 'A car.')).toBe(false);
  });

  it('round-trips through serialize/deserialize', () => {
    const ctrl = new EditorController();
    ctrl.addMedia(asset());
    ctrl.setAssetDescription('a1', 'A red car by the beach.');
    const restored = EditorController.deserialize(ctrl.serialize());
    expect(restored.getMedia()[0].aiDescription).toBe('A red car by the beach.');
  });

  it('narrows hostile stored values on load without breaking', () => {
    const ctrl = new EditorController();
    ctrl.addMedia(asset());
    const raw = JSON.parse(ctrl.serialize()) as { media: Array<Record<string, unknown>> };
    raw.media[0]['aiDescription'] = 42;
    const degraded = EditorController.deserialize(JSON.stringify(raw));
    expect(degraded.getMedia()[0].aiDescription).toBeUndefined();

    const over = JSON.parse(ctrl.serialize()) as { media: Array<Record<string, unknown>> };
    over.media[0]['aiDescription'] = 'x'.repeat(501);
    const degradedOver = EditorController.deserialize(JSON.stringify(over));
    expect(degradedOver.getMedia()[0].aiDescription).toBeUndefined();
  });
});
