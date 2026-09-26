/**
 * Keyframed transform transport (upstream PRs #154/#289; FCPXMLExporter.swift
 * at b4b1333): position/scale/rotation ride <param>/<keyframeAnimation>
 * children under <adjust-transform> exactly as upstream writes them, and the
 * importer reads them back into the motion tracks.
 *
 * Easing mirrors upstream: only linear points carry `curve="linear"`; every
 * other easing relies on FCPXML's default smooth curve, which our model
 * approximates as easeInOut. Opacity keyframes use the same nested amount
 * parameter under <adjust-blend>; keyframed volume and crop remain unsupported.
 */
import { describe, expect, it } from 'vitest';
import { EditorController } from '../editor/controller';
import { sanitizeMotion } from '../media/motion';
import { exportFcpxml } from './exporter';
import { parseFcpxml } from './importer';
import { applyFcpxmlPlan } from './apply';

const MEDIA_PATH = 'X:/media/clip.mp4';
const DIMS = new Map([[MEDIA_PATH, { width: 1920, height: 1080 }]]);

function editorWithClip(startFrame = 30): { editor: EditorController; clipId: string } {
  const editor = new EditorController();
  editor.addMedia({
    id: 'v',
    path: MEDIA_PATH,
    filename: 'clip.mp4',
    type: 'video',
    duration: 300,
    width: 1920,
    height: 1080,
    fileSize: 1,
    addedAt: '2026-08-26T00:00:00.000Z',
  });
  const clipId = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame, durationFrames: 90 });
  return { editor, clipId };
}

function addMotion(editor: EditorController, clipId: string, withStatic = false): void {
  editor.applyClipProperties([clipId], 'motion', (draft) => {
    if (withStatic) {
      draft.x = 0;
      draft.y = 0;
      draft.width = 960;
      draft.height = 540;
      draft.rotation = 15;
    }
    draft.motionX = sanitizeMotion([{ frame: 30, value: withStatic ? 100 : 0 }, { frame: 60, value: withStatic ? 300 : 200 }]);
    draft.motionY = sanitizeMotion([{ frame: 30, value: withStatic ? 50 : 0 }, { frame: 60, value: withStatic ? 150 : 100 }]);
    draft.motionScaleX = sanitizeMotion([
      { frame: 30, value: 0.5, easing: 'easeInOut' },
      { frame: 60, value: withStatic ? 1 : 2, easing: 'easeInOut' },
    ]);
    draft.motionScaleY = sanitizeMotion([
      { frame: 30, value: 0.5, easing: 'easeInOut' },
      { frame: 60, value: withStatic ? 1 : 1, easing: 'easeInOut' },
    ]);
    draft.motionRot = sanitizeMotion([{ frame: 30, value: 0 }, { frame: 60, value: 90 }]);
    return true;
  });
}

function addOpacityTrack(editor: EditorController, clipId: string): void {
  editor.setClipOpacityTrack(clipId, [
    { frame: 30, value: 0.2 },
    { frame: 60, value: 0.8, easing: 'easeInOut' },
  ]);
}

/** Full <adjust-transform> blocks, paired or self-closing, in document order. */
function transformElements(xml: string): string[] {
  return xml.match(/<adjust-transform\b[^>]*(?:\/>|>[\s\S]*?<\/adjust-transform>)/g) ?? [];
}

/** Minimal FCPXML doc with a video and an audio asset, for import-only cases. */
function framesDoc(clipBody: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
    '<fcpxml version="1.11"><resources>',
    '<format id="r1" frameDuration="0.033333s" width="1920" height="1080"/>',
    '<asset id="2" name="clip.mp4" src="file:///X:/media/clip.mp4" start="0s" duration="10s" hasVideo="1" hasAudio="1" format="r1"/>',
    '<asset id="3" name="audio.wav" src="file:///X:/media/audio.wav" start="0s" duration="10s" hasAudio="1"/>',
    '</resources><library><event name="E"><project name="E"><spine>',
    `<asset-clip name="Clip" offset="0s" duration="2s" start="0s" ref="2">${clipBody}</asset-clip>`,
    '</spine></project></event></library></fcpxml>',
  ].join('');
}

describe('keyframed opacity export (#154)', () => {
  it('writes the nested amount animation even when the base opacity is opaque', () => {
    const { editor, clipId } = editorWithClip(30);
    const before = exportFcpxml(editor.getProject());
    addOpacityTrack(editor, clipId);

    const xml = exportFcpxml(editor.getProject());

    expect(xml).toContain(
      '<adjust-blend amount="1"><param name="amount" value="1"><keyframeAnimation>'
      + '<keyframe time="0.000000s" curve="linear" value="0.2"/>'
      + '<keyframe time="1.000000s" value="0.8"/>'
      + '</keyframeAnimation></param></adjust-blend>',
    );
    expect(xml).not.toContain('<adjust-blend amount="1"/>');
    expect(xml).not.toBe(before);
  });

  it('keeps the opaque no-track export byte-identical', () => {
    const { editor, clipId } = editorWithClip(30);
    const before = exportFcpxml(editor.getProject());
    addOpacityTrack(editor, clipId);
    editor.setClipOpacityTrack(clipId, []);
    const after = exportFcpxml(editor.getProject());

    expect(after).toBe(before);
  });
});

describe('keyframed transform export (#289)', () => {
  it('writes params with upstream units, curve rules and clip-relative times', () => {
    const { editor, clipId } = editorWithClip(30);
    addMotion(editor, clipId);

    const xml = exportFcpxml(editor.getProject());

    // Keyframes exist, so the element is emitted even though every static
    // value is identity; rotation appears because its track does.
    expect(xml).toContain('<adjust-transform scale="1 1" rotation="0" anchor="0 0" position="0 0">');
    // Scale: FCPXML multipliers, no curve for easeInOut (upstream writes the
    // attribute only for linear; FCPXML's smooth default is left implicit).
    expect(xml).toContain(
      '<param name="scale" value="1 1"><keyframeAnimation>'
      + '<keyframe time="0.000000s" value="0.5 0.5"/>'
      + '<keyframe time="1.000000s" value="2 1"/>'
      + '</keyframeAnimation></param>',
    );
    // Position: percent of canvas height, center-based, y-up. At frame 60 the
    // animated 90-degree rotation (clockwise here, so about the top-left
    // anchor) puts the box center at x=200-540, y=100+960.
    expect(xml).toContain(
      '<param name="position" value="0 0"><keyframeAnimation>'
      + '<keyframe time="0.000000s" curve="linear" value="0 0"/>'
      + '<keyframe time="1.000000s" curve="linear" value="-120.3704 -48.1481"/>'
      + '</keyframeAnimation></param>',
    );
    // Rotation: counter-clockwise degrees, negated; time offset from start.
    expect(xml).toContain(
      '<param name="rotation" value="0"><keyframeAnimation>'
      + '<keyframe time="0.000000s" curve="linear" value="0"/>'
      + '<keyframe time="1.000000s" curve="linear" value="-90"/>'
      + '</keyframeAnimation></param>',
    );
    expect(xml).not.toContain('curve="smooth"');
  });

  it('pairs independently-keyed axes at the union of their frames', () => {
    const { editor, clipId } = editorWithClip(0);
    editor.applyClipProperties([clipId], 'motion', (draft) => {
      draft.motionX = sanitizeMotion([{ frame: 0, value: 0 }, { frame: 15, value: 90 }]);
      draft.motionY = sanitizeMotion([{ frame: 0, value: 0 }, { frame: 30, value: 60 }]);
      return true;
    });

    const xml = exportFcpxml(editor.getProject());

    // One position param carries the pair: frame 15 interpolates Y to 30.
    expect(xml).toContain(
      '<param name="position" value="0 0"><keyframeAnimation>'
      + '<keyframe time="0.000000s" curve="linear" value="0 0"/>'
      + '<keyframe time="0.500000s" curve="linear" value="8.3333 -2.7778"/>'
      + '<keyframe time="1.000000s" curve="linear" value="8.3333 -5.5556"/>'
      + '</keyframeAnimation></param>',
    );
  });

  it('keeps static-only transforms self-closing with no param children', () => {
    const { editor, clipId } = editorWithClip(0);
    editor.applyClipProperties([clipId], 'place', (draft) => {
      draft.x = 0;
      draft.y = 0;
      draft.width = 960;
      draft.height = 540;
      return true;
    });

    const xml = exportFcpxml(editor.getProject());

    expect(transformElements(xml)).toHaveLength(1);
    expect(xml).toContain('<adjust-transform scale="0.5 0.5" anchor="0 0" position="-44.4444 25"/>');
    expect(xml).not.toContain('<keyframeAnimation');
  });
});

describe('keyframed transform import (#289)', () => {
  it('reads keyframes back into the motion tracks with upstream easing and timing', () => {
    const { editor, clipId } = editorWithClip(30);
    addMotion(editor, clipId);
    const plan = parseFcpxml(exportFcpxml(editor.getProject()));

    const clip = plan.clips.find((c) => c.kind === 'video')!;
    expect(clip.kind).toBe('video');
    if (clip.kind !== 'video') return;
    expect(clip.transformKeyframes).toEqual({
      position: [
        { frame: 30, a: 0, b: 0, easing: 'linear' },
        { frame: 60, a: -120.3704, b: -48.1481, easing: 'linear' },
      ],
      scale: [
        { frame: 30, a: 0.5, b: 0.5, easing: 'easeInOut' },
        { frame: 60, a: 2, b: 1, easing: 'easeInOut' },
      ],
      rotation: [
        { frame: 30, value: 0, easing: 'linear' },
        { frame: 60, value: -90, easing: 'linear' },
      ],
    });
    // Supported keyframes are transported, not reported as skipped.
    expect(plan.unsupported).toEqual([]);

    const target = new EditorController();
    target.addMedia({
      id: 'imported',
      path: MEDIA_PATH,
      filename: 'clip.mp4',
      type: 'video',
      duration: 300,
      width: 1920,
      height: 1080,
      fileSize: 1,
      addedAt: '2026-08-26T00:00:00.000Z',
    });
    applyFcpxmlPlan(target, plan, new Map([[MEDIA_PATH, 'imported']]), DIMS);
    const restored = target.getClips()[0]!;

    // Scale and rotation recover exactly; position is within FCPXML's
    // four-decimal unit rounding (±0.001px after the height-percent scale).
    expect(restored.motionScaleX).toEqual([
      { frame: 30, value: 0.5, easing: 'easeInOut' },
      { frame: 60, value: 2, easing: 'easeInOut' },
    ]);
    expect(restored.motionScaleY).toEqual([
      { frame: 30, value: 0.5, easing: 'easeInOut' },
      { frame: 60, value: 1, easing: 'easeInOut' },
    ]);
    expect(restored.motionRot).toEqual([{ frame: 30, value: 0 }, { frame: 60, value: 90 }]);
    expect(restored.motionX?.map((p) => p.frame)).toEqual([30, 60]);
    expect(restored.motionY?.map((p) => p.frame)).toEqual([30, 60]);
    expect(restored.motionX?.[1]?.value).toBeCloseTo(200, 2);
    expect(restored.motionY?.[1]?.value).toBeCloseTo(100, 2);
  });

  it('normalizes easeIn/easeOut to the implicit FCPXML default curve', () => {
    const { editor, clipId } = editorWithClip(0);
    editor.applyClipProperties([clipId], 'motion', (draft) => {
      draft.motionScaleX = sanitizeMotion([
        { frame: 0, value: 1, easing: 'easeIn' },
        { frame: 30, value: 2, easing: 'easeOut' },
      ]);
      return true;
    });

    const xml = exportFcpxml(editor.getProject());
    // Upstream writes no curve attribute for non-linear points, so their
    // distinction cannot survive FCPXML; timing and values still do.
    expect(xml).not.toContain('curve=');
    const clip = parseFcpxml(xml).clips[0]!;
    if (clip.kind !== 'video') return;
    expect(clip.transformKeyframes?.scale).toEqual([
      { frame: 0, a: 1, b: 1, easing: 'easeInOut' },
      { frame: 30, a: 2, b: 1, easing: 'easeInOut' },
    ]);
  });

  it('treats an absent curve as the FCPXML default S-curve', () => {
    const plan = parseFcpxml(framesDoc(
      '<adjust-transform scale="1 1" anchor="0 0" position="0 0"><param name="rotation" value="0">'
      + '<keyframeAnimation><keyframe time="0s" value="0"/><keyframe time="1s" curve="smooth" value="45"/>'
      + '</keyframeAnimation></param></adjust-transform>',
    ));
    const clip = plan.clips[0]!;
    if (clip.kind !== 'video') return;
    expect(clip.transformKeyframes?.rotation).toEqual([
      { frame: 0, value: 0, easing: 'easeInOut' },
      { frame: 30, value: 45, easing: 'easeInOut' },
    ]);
    expect(plan.unsupported).toEqual([]);
  });
});

describe('keyframed opacity import and apply (#154)', () => {
  it('reads absolute frames and easing without reporting supported animation as unsupported', () => {
    const { editor, clipId } = editorWithClip(30);
    addOpacityTrack(editor, clipId);
    const plan = parseFcpxml(exportFcpxml(editor.getProject()));
    const clip = plan.clips.find((candidate) => candidate.kind === 'video')!;

    expect(clip.kind).toBe('video');
    if (clip.kind !== 'video') return;
    expect(clip.opacityTrack).toEqual([
      { frame: 30, value: 0.2 },
      { frame: 60, value: 0.8, easing: 'easeInOut' },
    ]);
    expect(plan.unsupported).toEqual([]);
  });

  it('reports malformed opacity animation while keeping the static amount', () => {
    const plan = parseFcpxml(framesDoc(
      '<adjust-blend amount="0.4"><param name="amount" value="0.4"><keyframeAnimation>'
      + '<keyframe time="0s" value="0"/>'
      + '<keyframe time="1s" value="bad"/>'
      + '</keyframeAnimation></param></adjust-blend>',
    ));
    const clip = plan.clips[0]!;

    expect(clip.kind).toBe('video');
    if (clip.kind !== 'video') return;
    expect(clip.opacity).toBe(0.4);
    expect(clip.opacityTrack).toBeUndefined();
    expect(plan.unsupported.some((note) => /opacity/i.test(note))).toBe(true);
  });

  it('applies the track in the existing adjustment batch and undoes it once', () => {
    const { editor, clipId } = editorWithClip(30);
    addOpacityTrack(editor, clipId);
    const plan = parseFcpxml(exportFcpxml(editor.getProject()));
    const target = new EditorController();
    target.addMedia({
      id: 'imported', path: MEDIA_PATH, filename: 'clip.mp4', type: 'video',
      duration: 300, width: 1920, height: 1080, fileSize: 1,
      addedAt: '2026-08-26T00:00:00.000Z',
    });
    const beforeAdjustments = target.getLastCommandDescription();
    applyFcpxmlPlan(target, plan, new Map([[MEDIA_PATH, 'imported']]), DIMS);
    const imported = target.getClips()[0]!;

    expect(imported.opacityTrack).toEqual([
      { frame: 30, value: 0.2 },
      { frame: 60, value: 0.8, easing: 'easeInOut' },
    ]);
    expect(target.getLastCommandDescription()).not.toBe(beforeAdjustments);
    expect(target.undo()).toBe(true);
    expect(target.getClips()[0]!.opacityTrack).toBeUndefined();
    expect(target.undo()).toBe(true);
  });
});

describe('keyframed transform round trip (#289)', () => {
  it('is stable across export → import → export with matching motion fields', () => {
    const { editor, clipId } = editorWithClip(30);
    addMotion(editor, clipId, true);
    const source = editor.getProject();
    const first = exportFcpxml(source);

    const plan = parseFcpxml(first);
    const target = new EditorController();
    target.addMedia({
      id: 'imported',
      path: MEDIA_PATH,
      filename: 'clip.mp4',
      type: 'video',
      duration: 300,
      width: 1920,
      height: 1080,
      fileSize: 1,
      addedAt: '2026-08-26T00:00:00.000Z',
    });
    const result = applyFcpxmlPlan(target, plan, new Map([[MEDIA_PATH, 'imported']]), DIMS);
    expect(result.placedClips).toBe(1);

    const second = exportFcpxml(target.getProject());
    expect(transformElements(second)).toEqual(transformElements(first));

    const sourceClip = source.timeline.clips[0]!;
    const restored = target.getClips()[0]!;
    for (const key of ['motionScaleX', 'motionScaleY', 'motionRot'] as const) {
      expect(restored[key]).toEqual(sourceClip[key]);
    }
    expect(restored.motionX?.map((p) => p.frame)).toEqual(sourceClip.motionX?.map((p) => p.frame));
    expect(restored.motionY?.map((p) => p.frame)).toEqual(sourceClip.motionY?.map((p) => p.frame));
    for (let i = 0; i < (sourceClip.motionX?.length ?? 0); i++) {
      expect(restored.motionX?.[i]?.value).toBeCloseTo(sourceClip.motionX![i]!.value, 2);
      expect(restored.motionY?.[i]?.value).toBeCloseTo(sourceClip.motionY![i]!.value, 2);
    }
  });
});

describe('unsupported keyframed inputs (#154)', () => {
  it('transports opacity while reporting volume and crop keyframes', () => {
    const plan = parseFcpxml(framesDoc(
      '<adjust-blend amount="0.4"><param name="amount" value="0.4"><keyframeAnimation>'
      + '<keyframe time="0s" curve="linear" value="0"/>'
      + '<keyframe time="1s" curve="linear" value="0.8"/>'
      + '</keyframeAnimation></param></adjust-blend>'
      + '<adjust-volume amount="-6.0206dB"><param name="amount" value="-6.0206"><keyframeAnimation>'
      + '<keyframe time="0s" curve="linear" value="0"/>'
      + '<keyframe time="1s" curve="linear" value="-6.0206"/>'
      + '</keyframeAnimation></param></adjust-volume>'
      + '<adjust-crop mode="trim"><trim-rect top="0" right="0" bottom="0" left="0"/>'
      + '<param name="left" value="0"><keyframeAnimation>'
      + '<keyframe time="0s" value="0"/><keyframe time="1s" value="10"/>'
      + '</keyframeAnimation></param></adjust-crop>',
    ));
    expect(plan.unsupported.some((note) => /opacity/i.test(note))).toBe(false);
    expect(plan.unsupported.some((note) => /volume/i.test(note))).toBe(true);
    expect(plan.unsupported.some((note) => /crop/i.test(note))).toBe(true);
    const clip = plan.clips[0]!;
    if (clip.kind !== 'video') return;
    expect(clip.opacity).toBe(0.4);
    expect(clip.opacityTrack).toEqual([
      { frame: 0, value: 0 },
      { frame: 30, value: 0.8 },
    ]);
    expect(clip.volume).toBeCloseTo(0.5, 4);
  });

  it('reports keyframed audio volume without importing it', () => {
    const plan = parseFcpxml(framesDoc('').replace(
      '<asset-clip name="Clip" offset="0s" duration="2s" start="0s" ref="2"></asset-clip>',
      '<asset-clip name="Music" lane="-1" offset="0s" duration="2s" start="0s" ref="3">'
      + '<adjust-volume amount="-6.0206dB"><param name="amount" value="-6.0206"><keyframeAnimation>'
      + '<keyframe time="0s" curve="linear" value="0"/>'
      + '<keyframe time="1s" curve="linear" value="-6.0206"/>'
      + '</keyframeAnimation></param></adjust-volume></asset-clip>',
    ));
    expect(plan.unsupported.some((note) => /volume/i.test(note))).toBe(true);
    const audio = plan.clips.find((c) => c.kind === 'audio')!;
    expect(audio.volume).toBeCloseTo(0.5, 4);
  });

  it('reports unsupported curves, malformed values, title keyframes and effects', () => {
    const plan = parseFcpxml(framesDoc(
      '<adjust-transform scale="1 1" anchor="0 0" position="0 0"><param name="position" value="0 0">'
      + '<keyframeAnimation><keyframe time="0s" curve="hold" value="0 0"/>'
      + '<keyframe time="1s" curve="hold" value="bad"/>'
      + '</keyframeAnimation></param></adjust-transform>'
      + '<effect name="Vignette" uid="FFVignette"/>'
      + '<filter-video ref="r5" name="Color Correction"/>',
    ));
    expect(plan.unsupported.some((note) => /hold/i.test(note))).toBe(true);
    expect(plan.unsupported.some((note) => /malformed/i.test(note))).toBe(true);
    expect(plan.unsupported.some((note) => /effect/i.test(note))).toBe(true);
    expect(plan.unsupported.some((note) => /filter-video/i.test(note))).toBe(true);

    const titlePlan = parseFcpxml(framesDoc('').replace(
      '<asset-clip name="Clip" offset="0s" duration="2s" start="0s" ref="2"></asset-clip>',
      '<title name="T" offset="0s" duration="2s" ref="ts1"><text><text-style ref="ts1">Hi</text-style></text>'
      + '<adjust-transform scale="1 1" anchor="0 0" position="0 0"><param name="scale" value="1 1">'
      + '<keyframeAnimation><keyframe time="0s" value="1 1"/><keyframe time="1s" value="2 2"/>'
      + '</keyframeAnimation></param></adjust-transform></title>',
    ));
    expect(titlePlan.unsupported.some((note) => /title/i.test(note))).toBe(true);
  });
});
