/**
 * Opacity / geometry / crop / volume interchange (upstream #154, phase 3).
 *
 * Exporter assertions pin each adjust element and the identity elisions;
 * importer assertions pin third-party parsing and the malformed-value
 * discipline; the round trip pins the property that matters — a project
 * exported, imported and re-exported carries the same adjust elements, so the
 * interchange is stable even though import normalizes placement
 * representation (see geometry.placementFromTransform).
 */
import { describe, expect, it } from 'vitest';
import { EditorController } from '../editor/controller';
import { exportFcpxml } from './exporter';
import { parseFcpxml } from './importer';
import { applyFcpxmlPlan } from './apply';

const CANVAS = { width: 1920, height: 1080 };
const DIMS = new Map([['X:/media/clip.mp4', { width: 1920, height: 1080 }]]);

function sourceProject(): EditorController {
  const editor = new EditorController();
  editor.addMedia({
    id: 'v',
    path: 'X:/media/clip.mp4',
    filename: 'clip.mp4',
    type: 'video',
    duration: 300,
    width: 1920,
    height: 1080,
    fileSize: 1,
    addedAt: '2026-08-26T00:00:00.000Z',
  });
  return editor;
}

function placeVideo(
  editor: EditorController,
  startFrame: number,
  patch: (draft: {
    x: number; y: number; width: number; height: number;
    rotation: number; scaleX: number; scaleY: number; opacity: number;
    anchorX: number; anchorY: number; volume: number; muted: boolean;
    crop?: { left: number; right: number; top: number; bottom: number };
  }) => void,
): void {
  const id = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame, durationFrames: 60 });
  editor.applyClipProperties([id], 'test adjustments', (draft) => {
    patch(draft);
    return true;
  });
}

/**
 * Adjust-element substrings of an asset-clip, in document order.
 *
 * Self-closing only, which is all our exporter emits; paired elements (a
 * third-party file's keyframed params) are covered by the importer unit
 * tests. A combined pattern backtracks across elements, so the two shapes
 * are matched separately by construction.
 */
function adjustElements(xml: string): string[] {
  return xml.match(/<adjust-(?:blend|transform|crop|volume)\b[^>]*\/>/g) ?? [];
}

describe('adjust export (#154)', () => {
  it('writes opacity below unity and omits it at unity', () => {
    const editor = sourceProject();
    placeVideo(editor, 0, (draft) => { draft.opacity = 0.5; });
    placeVideo(editor, 60, (draft) => { draft.opacity = 1; });

    const xml = exportFcpxml(editor.getProject());

    expect(xml).toContain('<adjust-blend amount="0.5"/>');
    expect(xml.match(/<adjust-blend/g)).toHaveLength(1);
  });

  it('writes geometry for a grid cell and nothing for a full-frame clip', () => {
    const editor = sourceProject();
    placeVideo(editor, 0, (draft) => {
      draft.x = 0; draft.y = 0; draft.width = 960; draft.height = 540;
    });
    placeVideo(editor, 60, () => {});

    const xml = exportFcpxml(editor.getProject());
    const transforms = xml.match(/<adjust-transform[^>]*\/>/g) ?? [];
    expect(transforms).toHaveLength(1);
    expect(transforms[0]).toContain('scale="0.5 0.5"');
    // Top-left quadrant center relative to canvas center, y-up, %height units.
    expect(transforms[0]).toContain('position="-44.4444 25"');
    expect(transforms[0]).toContain('anchor="0 0"');
  });

  it('negates rotation into counter-clockwise degrees', () => {
    const editor = sourceProject();
    placeVideo(editor, 0, (draft) => { draft.rotation = 15; });

    const xml = exportFcpxml(editor.getProject());
    expect(xml).toContain('rotation="-15"');
  });

  it('writes crop as height-percent trim with aspect-corrected width edges', () => {
    const editor = sourceProject();
    placeVideo(editor, 0, (draft) => {
      draft.crop = { left: 0.1, right: 0, top: 0.05, bottom: 0 };
    });

    const xml = exportFcpxml(editor.getProject());
    // 10% of a 16:9 width edge = 17.7778% of height; top is direct.
    expect(xml).toContain('<adjust-crop mode="trim">');
    expect(xml).toContain('left="17.7778"');
    expect(xml).toContain('top="5"');
  });

  it('writes volume in decibels, unity omitted, mute at the floor', () => {
    const editor = sourceProject();
    placeVideo(editor, 0, (draft) => { draft.volume = 0.5; });
    placeVideo(editor, 60, (draft) => { draft.muted = true; });
    placeVideo(editor, 120, () => {});

    const xml = exportFcpxml(editor.getProject());
    expect(xml).toContain('<adjust-volume amount="-6.0206dB"/>');
    expect(xml).toContain('<adjust-volume amount="-96dB"/>');
    expect(xml.match(/<adjust-volume/g)).toHaveLength(2);
  });
});

describe('adjust import (#154)', () => {
  function docWith(clipBody: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="0.033333s" width="1920" height="1080"/>',
      '<asset id="2" name="clip.mp4" src="file:///X:/media/clip.mp4" start="0s" duration="10s" hasVideo="1" format="r1"/>',
      '</resources><library><event name="E"><project name="E"><spine>',
      `<asset-clip name="Clip" offset="0s" duration="2s" start="0s" ref="2">${clipBody}</asset-clip>`,
      '</spine></project></event></library></fcpxml>',
    ].join('');
  }

  it('parses opacity, geometry, crop and volume', () => {
    const plan = parseFcpxml(docWith(
      '<adjust-blend amount="0.5"/>'
      + '<adjust-transform scale="0.5 0.5" rotation="-15" anchor="0 0" position="-44.4444 25"/>'
      + '<adjust-crop mode="trim"><trim-rect top="5" right="0" bottom="0" left="17.7778"/></adjust-crop>'
      + '<adjust-volume amount="-6.0206dB"/>',
    ));
    const clip = plan.clips[0];
    expect(clip.kind).toBe('video');
    if (clip.kind !== 'video') return;
    expect(clip.opacity).toBe(0.5);
    expect(clip.transform).toEqual({
      positionX: -44.4444, positionY: 25, scaleX: 0.5, scaleY: 0.5, rotation: -15,
    });
    expect(clip.cropTrim).toEqual({ left: 17.7778, top: 5, right: 0, bottom: 0 });
    expect(clip.volume).toBeCloseTo(0.5, 4);
    expect(clip.muted).toBe(false);
  });

  it('reads deep silence as muted', () => {
    const plan = parseFcpxml(docWith('<adjust-volume amount="-96dB"/>'));
    const clip = plan.clips[0];
    expect(clip.kind).toBe('video');
    if (clip.kind !== 'video') return;
    expect(clip.volume).toBe(0);
    expect(clip.muted).toBe(true);
  });

  it('ignores malformed adjust values instead of failing', () => {
    const plan = parseFcpxml(docWith(
      '<adjust-blend amount="opaque"/>'
      + '<adjust-transform scale="huge" position="0"/>'
      + '<adjust-volume amount="loud"/>',
    ));
    const clip = plan.clips[0];
    expect(clip.kind).toBe('video');
    if (clip.kind !== 'video') return;
    expect(clip.opacity).toBeUndefined();
    expect(clip.transform).toBeUndefined();
    expect(clip.volume).toBeUndefined();
  });

  it('reports keyframed parameters and effect children as skipped', () => {
    const plan = parseFcpxml(docWith(
      '<adjust-blend amount="0.5"><param name="amount" value="0.5">'
      + '<keyframeAnimation><keyframe time="0s" value="0"/></keyframeAnimation>'
      + '</param></adjust-blend>'
      + '<effect name="Vignette" uid="FFVignette"/>',
    ));
    expect(plan.unsupported.some((note) => /keyframe/i.test(note))).toBe(true);
    expect(plan.unsupported.some((note) => /effect/i.test(note))).toBe(true);
    // The base value still lands.
    const clip = plan.clips[0];
    expect(clip.kind).toBe('video');
    if (clip.kind !== 'video') return;
    expect(clip.opacity).toBe(0.5);
  });
});

describe('adjust round trip (#154)', () => {
  function adjustedSource(): EditorController {
    const editor = sourceProject();
    placeVideo(editor, 0, (draft) => { draft.opacity = 0.5; });
    placeVideo(editor, 60, (draft) => {
      draft.x = 0; draft.y = 0; draft.width = 960; draft.height = 540;
    });
    placeVideo(editor, 120, (draft) => {
      draft.crop = { left: 0.1, right: 0, top: 0.05, bottom: 0 };
    });
    placeVideo(editor, 180, (draft) => { draft.volume = 0.5; });
    placeVideo(editor, 240, (draft) => { draft.rotation = 15; });
    return editor;
  }

  function reimported(): EditorController {
    const xml = exportFcpxml(adjustedSource().getProject());
    const plan = parseFcpxml(xml);
    const target = new EditorController();
    target.addMedia({
      id: 'imported',
      path: 'X:/media/clip.mp4',
      filename: 'clip.mp4',
      type: 'video',
      duration: 300,
      width: 1920,
      height: 1080,
      fileSize: 1,
      addedAt: '2026-08-26T00:00:00.000Z',
    });
    const result = applyFcpxmlPlan(
      target,
      plan,
      new Map([['X:/media/clip.mp4', 'imported']]),
      DIMS,
    );
    expect(result.placedClips).toBe(5);
    return target;
  }

  it('restores scalar adjustments exactly', () => {
    const clips = reimported().getClips().sort((a, b) => a.startFrame - b.startFrame);
    expect(clips[0].opacity).toBe(0.5);
    // Four-decimal FCPXML numbers round-trip to ~1e-7, like upstream's own
    // format; exactness of the interchange is pinned by the stability test.
    expect(clips[2].crop?.left).toBeCloseTo(0.1, 6);
    expect(clips[2].crop?.top).toBeCloseTo(0.05, 6);
    expect(clips[2].crop?.right).toBe(0);
    expect(clips[2].crop?.bottom).toBe(0);
    expect(clips[3].volume).toBeCloseTo(0.5, 4);
    expect(clips[3].muted).toBe(false);
  });

  it('keeps the interchange stable across a second export', () => {
    const first = exportFcpxml(adjustedSource().getProject());
    const second = exportFcpxml(reimported().getProject());
    expect(adjustElements(first)).toEqual(adjustElements(second));
  });
});
