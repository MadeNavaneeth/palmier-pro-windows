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

/**
 * Two mode attributes and the adjustment family this module reads for nothing.
 *
 * `adjust-crop@mode` is `#REQUIRED` in Apple's FCPXML DTD with the value set
 * `(trim | crop | pan)`, and it selects WHICH child rect is live — the DTD even
 * allows `crop-rect?`, `trim-rect?` and `(pan-rect, pan-rect)?` to all be present
 * with only one active. So a `mode="crop"` document can legitimately carry an
 * INACTIVE `<trim-rect>` next to its live `<crop-rect>`, and reading that as the
 * crop is a wrong value with nothing to tell it from a right one. Only `trim` is
 * applied; everything else is refused and reported.
 *
 * `adjust-blend@mode` is `CDATA #IMPLIED`, an open enumeration with no published
 * value list, so there is nothing verified to map from and honouring it is
 * gated on finding one. `Clip.blendMode` ships twelve W3C modes, which is what
 * made the silence a defect rather than a gap — but a wrong composite is worse
 * than a plain one, so the note says the mode is dropped and the `amount` still
 * applies.
 */
describe('adjust modes and the unrepresented adjustment family (#154)', () => {
  function docWith(clipBody: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
      '<asset id="2" name="clip.mp4" src="file:///X:/media/clip.mp4" start="0s" duration="10s" hasVideo="1" format="r1"/>',
      '</resources><library><event name="E"><project name="E"><spine>',
      `<asset-clip name="Take 1" offset="0s" duration="2s" start="0s" ref="2">${clipBody}</asset-clip>`,
      '</spine></project></event></library></fcpxml>',
    ].join('');
  }

  /** The clip as the importer planned it and as the materializer placed it. */
  function read(body: string): {
    planKeys: string[];
    cropTrim: unknown;
    opacity: number | undefined;
    applied: { crop: unknown; opacity: number; blendMode: unknown };
    unsupported: string[];
  } {
    const plan = parseFcpxml(docWith(body));
    const clip = plan.clips[0] as unknown as Record<string, unknown>;
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
      addedAt: new Date().toISOString(),
    });
    const result = applyFcpxmlPlan(target, plan, new Map([['X:/media/clip.mp4', 'imported']]), DIMS);
    expect(result.placedClips).toBe(1);
    const placed = target.getClips()[0]!;
    return {
      planKeys: Object.keys(clip),
      cropTrim: clip.cropTrim,
      opacity: clip.opacity as number | undefined,
      applied: { crop: placed.crop, opacity: placed.opacity, blendMode: placed.blendMode },
      unsupported: plan.unsupported,
    };
  }

  /** A rect big enough that applying it by mistake would be unmistakable. */
  const BIG_TRIM = '<trim-rect top="20" right="10" bottom="5" left="30"/>';

  it('reports adjust-blend mode and still applies the amount as plain opacity', () => {
    for (const mode of ['lighten', '30', 'screen']) {
      const read1 = read(`<adjust-blend amount="0.5" mode="${mode}"/>`);
      expect(read1.unsupported, mode).toEqual([
        `Asset-clip "Take 1" has adjust-blend mode="${mode}";`
        + ' the composite mode is not imported, and the amount still applies.',
      ]);
      // The amount survives untouched — this is a reported omission, not a
      // dropped element — and the composite stays the model default.
      expect(read1.opacity, mode).toBe(0.5);
      expect(read1.applied.opacity, mode).toBe(0.5);
      expect(read1.applied.blendMode, mode).toBeUndefined();
    }
  });

  it('is quiet for an adjust-blend that names no mode, which is what we write', () => {
    const read1 = read('<adjust-blend amount="0.5"/>');
    expect(read1.unsupported).toEqual([]);
    expect(read1.applied.opacity).toBe(0.5);
  });

  it('still applies a mode="trim" crop, so the refusal is not over-broad', () => {
    const read1 = read(`<adjust-crop mode="trim">${BIG_TRIM}</adjust-crop>`);
    expect(read1.unsupported).toEqual([]);
    expect(read1.cropTrim).toEqual({ left: 30, top: 20, right: 10, bottom: 5 });
    // Percent of frame height on every edge, left/right aspect-corrected.
    expect(read1.applied.crop).toEqual({
      left: 0.16874999999999998, right: 0.05625, top: 0.2, bottom: 0.05,
    });
  });

  it('refuses every other crop mode and applies NO crop from it', () => {
    const cases: Array<[string, string, string]> = [
      ['crop (scale-in, a different adjustment entirely)',
        `<adjust-crop mode="crop"><crop-rect left="10" top="10" right="10" bottom="10"/></adjust-crop>`,
        'crop'],
      ['pan (a Ken Burns start/end pair)',
        '<adjust-crop mode="pan"><pan-rect left="0" top="0" right="0" bottom="0"/>'
        + '<pan-rect left="10" top="10" right="10" bottom="10"/></adjust-crop>',
        'pan'],
      // Not in the DTD's (trim | crop | pan) at all.
      ['add (not a value the format defines)',
        `<adjust-crop mode="add">${BIG_TRIM}</adjust-crop>`,
        'add'],
      // The DTD makes mode #REQUIRED, so this is invalid — and it used to be
      // read as a trim, which is guessing on a required attribute.
      ['absent (the DTD makes it #REQUIRED)',
        `<adjust-crop>${BIG_TRIM}</adjust-crop>`,
        '(none)'],
      // The sharpest one, and the one that is not invalid at all: the DTD allows
      // an inactive <trim-rect> to sit beside the live <crop-rect>. Before the
      // refusal this applied left 0.169 / right 0.056 / top 0.2 / bottom 0.05 —
      // a crop the document itself says is switched off.
      ['crop carrying an INACTIVE trim-rect beside the live crop-rect',
        `<adjust-crop mode="crop"><crop-rect left="10" top="10" right="10" bottom="10"/>${BIG_TRIM}</adjust-crop>`,
        'crop'],
    ];

    for (const [name, body, mode] of cases) {
      const read1 = read(body);
      expect(read1.unsupported, name).toEqual([
        `Asset-clip "Take 1" has adjust-crop mode="${mode}";`
        + ' only mode="trim" is imported, so no crop is applied from it.',
      ]);
      // The assertion that matters: the rect never reaches the plan, so no
      // materializer can apply it, and the placed clip has no crop at all.
      expect(read1.planKeys, name).not.toContain('cropTrim');
      expect(read1.applied.crop, name).toBeUndefined();
    }
  });

  it('reports a refused crop without also claiming a base crop was kept', () => {
    // The crop keyframe note is only true in trim mode; in a refused mode there
    // is no base crop, so the two must not both fire.
    const read1 = read(
      '<adjust-crop mode="crop"><param name="Center"><keyframeAnimation>'
      + '<keyframe time="0s" value="0.5 0.5"/>'
      + '<keyframe time="1s" value="0.4 0.4"/>'
      + '</keyframeAnimation></param></adjust-crop>',
    );
    expect(read1.unsupported).toEqual([
      'Asset-clip "Take 1" has adjust-crop mode="crop";'
      + ' only mode="trim" is imported, so no crop is applied from it.',
    ]);
    // And in trim mode the keyframe note is unchanged.
    const trimmed = read(
      '<adjust-crop mode="trim"><param name="Center"><keyframeAnimation>'
      + '<keyframe time="0s" value="0.5 0.5"/>'
      + '<keyframe time="1s" value="0.4 0.4"/>'
      + '</keyframeAnimation></param><trim-rect left="10" top="0" right="0" bottom="0"/></adjust-crop>',
    );
    expect(trimmed.unsupported).toEqual([
      'Asset-clip "Take 1" animates crop; crop keyframes are not transported (base crop kept).',
    ]);
  });

  it('reports the adjustment elements it reads for nothing, once per document', () => {
    // The DTD's %intrinsic-params-video / -audio / %timing-params members this
    // module does not read, each with a shape the DTD actually declares. Several
    // mirror a feature this editor SHIPS — color grade, EQ, noise reduction,
    // fades, and a conform-rate is a retime — which is what made the silence a
    // defect rather than a gap.
    const bodies: Array<[string, string]> = [
      ['info-asc-cdl', '<info-asc-cdl slope="1.1 1 1" offset="0 0 0" power="1 1 1"/>'],
      ['adjust-color', '<adjust-color><colorBalance><data key="k">0</data></colorBalance></adjust-color>'],
      ['adjust-corners', '<adjust-corners topLeft="0.2 0.2"/>'],
      ['adjust-stabilization', '<adjust-stabilization type="smoothCam"/>'],
      ['adjust-rollingShutter', '<adjust-rollingShutter amount="low"/>'],
      ['adjust-loudness', '<adjust-loudness amount="-23" uniformity="0.5"/>'],
      ['adjust-noiseReduction', '<adjust-noiseReduction amount="2"/>'],
      ['adjust-humReduction', '<adjust-humReduction frequency="50"/>'],
      ['adjust-EQ', '<adjust-EQ mode="voice_enhance"/>'],
      ['adjust-matchEQ', '<adjust-matchEQ><data key="k">1</data></adjust-matchEQ>'],
      ['adjust-panner', '<adjust-panner amount="0.5"/>'],
      // A retime, in the same %timing-params group as <timeMap>.
      ['conform-rate', '<conform-rate srcFrameRate="24" frameSampling="floor"/>'],
      ['fadeIn', '<adjust-volume amount="0dB"><param name="amount"><fadeIn duration="0.5s"/></param></adjust-volume>'],
      ['fadeOut', '<adjust-volume amount="0dB"><param name="amount"><fadeOut duration="0.5s"/></param></adjust-volume>'],
    ];

    for (const [element, body] of bodies) {
      const plan = parseFcpxml(docWith(body));
      expect(plan.unsupported, element).toContain(`${element} elements are skipped.`);
      // The clip still arrives; the note reports, it does not skip the element.
      expect(plan.clips, element).toHaveLength(1);
    }

    // Three of them in ONE document produce THREE notes, not one per element:
    // that per-document shape is the calibration, since our writer emits none of
    // them and a per-element note would be a note per clip on any real project.
    const many = parseFcpxml(docWith(
      '<adjust-color><colorBalance><data key="k">0</data></colorBalance></adjust-color>'
      + '<adjust-EQ mode="flat"/>'
      + '<conform-rate srcFrameRate="24" frameSampling="floor"/>'
      + '<adjust-blend amount="0.5"/>'
      + '<adjust-crop mode="trim"><trim-rect left="10" top="0" right="0" bottom="0"/></adjust-crop>',
    ));
    expect(many.unsupported).toEqual([
      'adjust-color elements are skipped.',
      'adjust-EQ elements are skipped.',
      'conform-rate elements are skipped.',
    ]);
  });

  it('reports nothing new on a document our own writer produced', () => {
    // The calibration, measured rather than asserted: one clip carrying every
    // adjust element this writer CAN emit, so an uncalibrated report would fire
    // here and on every user round trip.
    const editor = sourceProject();
    placeVideo(editor, 0, (draft) => {
      draft.opacity = 0.5;
      draft.x = 0; draft.y = 0; draft.width = 960; draft.height = 540;
      draft.crop = { left: 0.1, right: 0, top: 0.05, bottom: 0 };
      draft.volume = 0.5;
      draft.rotation = 15;
    });
    const xml = exportFcpxml(editor.getProject());
    // The premise: every element the writer emits, and none of the family.
    expect(xml).toContain('<adjust-blend amount="0.5"/>');
    expect(xml).toContain('<adjust-crop mode="trim">');
    expect(xml).toContain('<adjust-volume amount="-6.0206dB"/>');
    expect(xml).toContain('<adjust-transform');
    expect(xml).toContain('<adjust-conform type="fit"/>');

    const plan = parseFcpxml(xml);
    expect(plan.unsupported).toEqual([]);
    expect(plan.clips).toHaveLength(1);
  });
});

