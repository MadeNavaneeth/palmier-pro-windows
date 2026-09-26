/**
 * Regression coverage for the grade-preset round trip (#157).
 *
 * Named presets are snapshots: capture, persistence normalization and apply
 * must preserve every grade-owned field, including inversion, while omitted
 * or invalid fields fall back to neutral. These tests run the real apply path
 * (`applyGradePresetTo` through a real controller) plus the pure pieces,
 * because the repo has no DOM test setup.
 */

import { describe, it, expect } from 'vitest';
import {
  GRADE_PRESETS,
  gradePresetById,
  normalizeUserGradePresets,
  type GradePreset,
} from '../../shared/editor/grade-preset-store';
import type { GradeCurve, GradeWheels, HueCurves } from '../../shared/editor/color-grade';
import { EditorController } from '../../shared/editor/controller';
import {
  applyGradePatch,
  applyGradePresetTo,
  gradeFromClip,
  gradePresetPatch,
  shotFromClip,
} from './grade-preset';

/** A non-identity curve with one empty (identity) channel. */
const CURVE: GradeCurve = {
  master: [{ x: 0, y: 0.05 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }],
  red: [],
  green: [{ x: 0, y: 0 }, { x: 0.4, y: 0.5 }, { x: 1, y: 1 }],
  blue: [],
};

const IDENTITY: GradeCurve = {
  master: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  red: [],
  green: [],
  blue: [],
};

/** Non-identity wheels with one default (identity) zone. */
const WHEELS: GradeWheels = {
  lift: { x: 0.5, y: -0.5, m: 0.1 },
  gamma: { x: 0, y: 0, m: 1 },
  gain: { x: 0, y: 0, m: 1.2 },
};

const IDENTITY_WHEELS: GradeWheels = {
  lift: { x: 0, y: 0, m: 0 },
  gamma: { x: 0, y: 0, m: 1 },
  gain: { x: 0, y: 0, m: 1 },
};

/** Non-identity hue curves with one empty (neutral) channel. */
const HUE_CURVES: HueCurves = {
  hueVsHue: [],
  hueVsSat: [{ x: 0, y: 0.8 }, { x: 0.15, y: 0.5 }],
  hueVsLum: [{ x: 0.3, y: 0.8 }, { x: 0.8, y: 0.3 }],
};

const NEUTRAL_HUE_CURVES: HueCurves = {
  hueVsHue: [],
  hueVsSat: [],
  hueVsLum: [],
};

const LUT = { path: 'C:\\luts\\warm.cube', intensity: 0.5, kind: '3d' as const, size: 33 };

const FX = {
  blurRadius: 8,
  vignette: { amount: -0.5, midpoint: 0.5, roundness: 0, feather: 0.5 },
  grain: { amount: 0.5, size: 2 },
  glow: { intensity: 0.5, radius: 6, threshold: 0.3, warmth: 0.25 },
};

function controllerWithClips(): { ctrl: EditorController; clipId: string } {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'v', path: '/v.mp4', filename: 'v.mp4', type: 'video',
    duration: 600, fileSize: 1, addedAt: new Date().toISOString(),
  });
  const clipId = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 30 });
  return { ctrl, clipId };
}

function clipById(ctrl: EditorController, id: string) {
  return ctrl.getClips().find((clip) => clip.id === id);
}

describe('gradeFromClip', () => {
  it('fills every scalar with its default and carries no curve when the clip is neutral', () => {
    const { ctrl, clipId } = controllerWithClips();
    const grade = gradeFromClip(clipById(ctrl, clipId)!);

    expect(grade).toMatchObject({
      brightness: 0, contrast: 1, saturation: 1, hueRotation: 0, exposure: 0,
      temperature: 6500, tint: 0, vibrance: 0, highlights: 0, shadows: 0,
      blacks: 0, whites: 0, invertColors: false,
    });
    expect(grade).not.toHaveProperty('curves');
  });

  it('carries the fields the clip has set', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Color grade', (draft) => {
      draft.brightness = 0.2;
      draft.saturation = 1.4;
      return true;
    });

    expect(gradeFromClip(clipById(ctrl, clipId)!)).toMatchObject({
      brightness: 0.2,
      saturation: 1.4,
      contrast: 1,
    });
  });

  it('carries the clip inversion state', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Invert colors', (draft) => {
      draft.invertColors = true;
      return true;
    });

    expect(gradeFromClip(clipById(ctrl, clipId)!).invertColors).toBe(true);
  });

  it('carries a non-identity curve and omits an identity-shaped one', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Edit curves', (draft) => {
      draft.curves = CURVE;
      return true;
    });
    expect(gradeFromClip(clipById(ctrl, clipId)!).curves).toEqual(CURVE);

    ctrl.applyClipProperties([clipId], 'Edit curves', (draft) => {
      draft.curves = IDENTITY;
      return true;
    });
    expect(gradeFromClip(clipById(ctrl, clipId)!)).not.toHaveProperty('curves');
  });

  it('carries non-identity wheels and omits identity-shaped ones', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Edit wheels', (draft) => {
      draft.wheels = WHEELS;
      return true;
    });
    expect(gradeFromClip(clipById(ctrl, clipId)!).wheels).toEqual(WHEELS);

    ctrl.applyClipProperties([clipId], 'Edit wheels', (draft) => {
      draft.wheels = IDENTITY_WHEELS;
      return true;
    });
    expect(gradeFromClip(clipById(ctrl, clipId)!)).not.toHaveProperty('wheels');
  });

  it('carries non-neutral hue curves and omits neutral-shaped ones', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Edit hue curves', (draft) => {
      draft.hueCurves = HUE_CURVES;
      return true;
    });
    expect(gradeFromClip(clipById(ctrl, clipId)!).hueCurves).toEqual(HUE_CURVES);

    ctrl.applyClipProperties([clipId], 'Edit hue curves', (draft) => {
      draft.hueCurves = NEUTRAL_HUE_CURVES;
      return true;
    });
    expect(gradeFromClip(clipById(ctrl, clipId)!)).not.toHaveProperty('hueCurves');
  });
});

describe('gradePresetPatch', () => {
  it('no built-in preset patch carries curves', () => {
    for (const preset of GRADE_PRESETS) {
      expect(gradePresetPatch(preset), preset.id).not.toHaveProperty('curves');
    }
  });

  it('no built-in preset patch carries wheels', () => {
    for (const preset of GRADE_PRESETS) {
      expect(gradePresetPatch(preset), preset.id).not.toHaveProperty('wheels');
    }
  });

  it('no built-in preset patch carries hue curves', () => {
    for (const preset of GRADE_PRESETS) {
      expect(gradePresetPatch(preset), preset.id).not.toHaveProperty('hueCurves');
    }
  });

  it('carries the preset curve when the preset has one', () => {
    const patch = gradePresetPatch({ id: 'user-1', label: 'Look', grade: { brightness: 0.1, curves: CURVE } });
    expect(patch).toEqual({ brightness: 0.1, curves: CURVE });
  });

  it('carries the preset wheels when the preset has them', () => {
    const patch = gradePresetPatch({ id: 'user-1', label: 'Look', grade: { brightness: 0.1, wheels: WHEELS } });
    expect(patch).toEqual({ brightness: 0.1, wheels: WHEELS });
  });

  it('carries the preset hue curves when the preset has them', () => {
    const patch = gradePresetPatch({ id: 'user-1', label: 'Look', grade: { brightness: 0.1, hueCurves: HUE_CURVES } });
    expect(patch).toEqual({ brightness: 0.1, hueCurves: HUE_CURVES });
  });

  it('carries inversion when the preset has it', () => {
    const patch = gradePresetPatch({ id: 'user-1', label: 'Look', grade: { invertColors: true } });
    expect(patch.invertColors).toBe(true);
  });

  it('drops values outside the accepted ranges', () => {
    expect(gradePresetPatch({ id: 'user-1', label: 'Bad', grade: { brightness: 99 } })).toEqual({});
  });
});

describe('applyGradePatch', () => {
  it('clears scalars the patch omits and writes the ones it names', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Color grade', (draft) => {
      draft.brightness = 0.4;
      draft.contrast = 1.5;
      return true;
    });

    ctrl.applyClipProperties([clipId], 'Grade: Patch', (draft) => {
      applyGradePatch(draft, { brightness: 0.1 });
      return true;
    });

    const clip = clipById(ctrl, clipId)!;
    expect(clip.brightness).toBe(0.1);
    expect(clip.contrast).toBeUndefined();
  });

  it('clears the clip curves when the patch carries none', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Edit curves', (draft) => {
      draft.curves = CURVE;
      return true;
    });

    // Preset application is snapshot semantics now: an omitted optional
    // field means neutral, not "keep the target's previous value".
    ctrl.applyClipProperties([clipId], 'Grade: Patch', (draft) => {
      applyGradePatch(draft, { brightness: 0.1 });
      return true;
    });

    expect(clipById(ctrl, clipId)!.curves).toBeUndefined();
  });

  it('writes the patch curve when it carries one', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Grade: Patch', (draft) => {
      applyGradePatch(draft, { curves: CURVE });
      return true;
    });
    expect(clipById(ctrl, clipId)!.curves).toEqual(CURVE);
  });

  it('clears the clip wheels when the patch carries none', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Edit wheels', (draft) => {
      draft.wheels = WHEELS;
      return true;
    });

    ctrl.applyClipProperties([clipId], 'Grade: Patch', (draft) => {
      applyGradePatch(draft, { brightness: 0.1 });
      return true;
    });

    expect(clipById(ctrl, clipId)!.wheels).toBeUndefined();
  });

  it('writes the patch wheels when it carries them', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Grade: Patch', (draft) => {
      applyGradePatch(draft, { wheels: WHEELS });
      return true;
    });
    expect(clipById(ctrl, clipId)!.wheels).toEqual(WHEELS);
  });

  it('clears the clip hue curves when the patch carries none', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Edit hue curves', (draft) => {
      draft.hueCurves = HUE_CURVES;
      return true;
    });

    ctrl.applyClipProperties([clipId], 'Grade: Patch', (draft) => {
      applyGradePatch(draft, { brightness: 0.1 });
      return true;
    });

    expect(clipById(ctrl, clipId)!.hueCurves).toBeUndefined();
  });

  it('writes the patch hue curves when it carries them', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Grade: Patch', (draft) => {
      applyGradePatch(draft, { hueCurves: HUE_CURVES });
      return true;
    });
    expect(clipById(ctrl, clipId)!.hueCurves).toEqual(HUE_CURVES);
  });
});

describe('preset snapshot semantics', () => {
  it('round-trips inversion and clears it from a clean capture', () => {
    const { ctrl, clipId: invertedSourceId } = controllerWithClips();
    const cleanSourceId = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 60, durationFrames: 30 });
    const targetId = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 120, durationFrames: 30 });

    ctrl.applyClipProperties([invertedSourceId], 'Invert colors', (draft) => {
      draft.invertColors = true;
      return true;
    });
    const invertedPreset = normalizeUserGradePresets([
      { id: 'inverted', label: 'Inverted', grade: gradeFromClip(clipById(ctrl, invertedSourceId)!) },
    ])[0];
    applyGradePresetTo(ctrl, [targetId], invertedPreset);
    expect(clipById(ctrl, targetId)!.invertColors).toBe(true);

    const cleanPreset = normalizeUserGradePresets([
      { id: 'clean', label: 'Clean', grade: gradeFromClip(clipById(ctrl, cleanSourceId)!) },
    ])[0];
    applyGradePresetTo(ctrl, [targetId], cleanPreset);
    expect(clipById(ctrl, targetId)!.invertColors).toBeUndefined();
  });

  it('leaves clip framing untouched when applying a legacy grade-only preset', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Set framing', (draft) => {
      Object.assign(draft, {
        x: 123,
        y: 234,
        scaleX: 1.4,
        scaleY: 0.8,
        rotation: 27,
        anchorX: 45,
        anchorY: 56,
        opacity: 0.65,
        crop: { left: 0.1, right: 0.05, top: 0.08, bottom: 0.03 },
        motionX: [{ frame: 0, value: 7 }],
        motionRot: [{ frame: 0, value: 3 }],
      });
      return true;
    });
    const before = clipById(ctrl, clipId)!;

    applyGradePresetTo(ctrl, [clipId], { id: 'legacy', label: 'Legacy', grade: { brightness: 0.1 } });

    const after = clipById(ctrl, clipId)!;
    expect(after).toMatchObject({
      x: before.x,
      y: before.y,
      scaleX: before.scaleX,
      scaleY: before.scaleY,
      rotation: before.rotation,
      anchorX: before.anchorX,
      anchorY: before.anchorY,
      opacity: before.opacity,
      crop: before.crop,
      motionX: before.motionX,
      motionRot: before.motionRot,
    });
  });

  it('round-trips every grade-owned field from a fully populated look', () => {
    const { ctrl, clipId: sourceId } = controllerWithClips();
    const targetId = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 60, durationFrames: 30 });
    const sourceGrade = {
      brightness: 0.31,
      contrast: 1.42,
      saturation: 1.17,
      hueRotation: 37,
      exposure: 1.2,
      temperature: 7200,
      tint: -18,
      vibrance: 0.22,
      highlights: 0.18,
      shadows: -0.24,
      blacks: 0.12,
      whites: -0.16,
      invertColors: true,
      curves: CURVE,
      wheels: WHEELS,
      hueCurves: HUE_CURVES,
      lut: LUT,
      ...FX,
    };
    const targetGrade = {
      brightness: -0.64,
      contrast: 2.2,
      saturation: 0.45,
      hueRotation: -120,
      exposure: -2.25,
      temperature: 3100,
      tint: 72,
      vibrance: -0.55,
      highlights: -0.7,
      shadows: 0.65,
      blacks: -0.35,
      whites: 0.58,
      invertColors: false,
      curves: {
        master: [{ x: 0, y: 0.8 }, { x: 1, y: 0.2 }],
        red: [],
        green: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }],
        blue: [],
      },
      wheels: {
        lift: { x: -0.4, y: 0.2, m: -0.2 },
        gamma: { x: 0.3, y: -0.1, m: 1.3 },
        gain: { x: 0.2, y: 0.4, m: 0.8 },
      },
      hueCurves: {
        hueVsHue: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }],
        hueVsSat: [{ x: 0, y: 0.2 }, { x: 1, y: 0.8 }],
        hueVsLum: [{ x: 0, y: 0.9 }, { x: 1, y: 0.1 }],
      },
      lut: { path: 'C:\\luts\\cool.cube', intensity: 0.9, kind: '3d' as const, size: 17 },
      blurRadius: 2,
      vignette: { amount: 0.6, midpoint: 0.7, roundness: 0.4, feather: 0.2 },
      grain: { amount: 0.2, size: 3.5 },
      glow: { intensity: 0.3, radius: 4, threshold: 0.8, warmth: 0.1 },
    };

    ctrl.applyClipProperties([sourceId], 'Source look', (draft) => {
      Object.assign(draft, sourceGrade);
      return true;
    });
    ctrl.applyClipProperties([targetId], 'Different look', (draft) => {
      Object.assign(draft, targetGrade);
      return true;
    });

    const expected = gradeFromClip(clipById(ctrl, sourceId)!);
    expect(gradeFromClip(clipById(ctrl, targetId)!)).not.toEqual(expected);
    const saved = normalizeUserGradePresets([
      { id: 'full-look', label: 'Full look', grade: expected },
    ]);
    expect(saved).toHaveLength(1);

    applyGradePresetTo(ctrl, [targetId], saved[0]);

    // This comparison covers every scalar, invertColors, curves, wheels,
    // hueCurves, lut, blurRadius, vignette, grain and glow.
    const applied = clipById(ctrl, targetId)!;
    expect(gradeFromClip(applied)).toEqual(expected);
    expect(applied).toMatchObject(sourceGrade);
  });

  it('narrows hostile stored fields to neutral instead of applying them raw', () => {
    const { ctrl, clipId } = controllerWithClips();
    const hostileGrade = {
      brightness: 0.2,
      contrast: 99,
      invertColors: 'yes',
      curves: 'not a curve',
      wheels: 42,
      hueCurves: false,
      lut: { path: 123, intensity: 99, kind: '3d', size: 999 },
      blurRadius: 999,
      vignette: 'not a vignette',
      grain: { amount: 99, size: 'tiny' },
      glow: { intensity: 'bright', radius: 999, threshold: 99, warmth: -1 },
    } as unknown as GradePreset['grade'];
    const saved = normalizeUserGradePresets([
      { id: 'hostile', label: 'Hostile', grade: hostileGrade },
    ]);
    expect(saved).toHaveLength(1);

    ctrl.applyClipProperties([clipId], 'Populate target', (draft) => {
      draft.saturation = 1.6;
      draft.contrast = 2;
      draft.invertColors = true;
      draft.curves = CURVE;
      draft.wheels = WHEELS;
      draft.hueCurves = HUE_CURVES;
      draft.lut = LUT;
      draft.blurRadius = FX.blurRadius;
      draft.vignette = { ...FX.vignette };
      draft.grain = { ...FX.grain };
      draft.glow = { ...FX.glow };
      return true;
    });
    applyGradePresetTo(ctrl, [clipId], saved[0]);

    const applied = clipById(ctrl, clipId)!;
    expect(applied.brightness).toBe(0.2);
    expect(applied.contrast).toBeUndefined();
    expect(applied.saturation).toBeUndefined();
    expect(applied.invertColors).toBeUndefined();
    expect(applied.curves).toBeUndefined();
    expect(applied.wheels).toBeUndefined();
    expect(applied.hueCurves).toBeUndefined();
    expect(applied.lut).toBeUndefined();
    expect(applied.blurRadius).toBeUndefined();
    expect(applied.vignette).toBeUndefined();
    expect(applied.grain).toBeUndefined();
    expect(applied.glow).toBeUndefined();
  });
});

describe('preset round trip with curves', () => {
  it('a curve-carrying look survives save -> normalize -> apply as one undo step', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Color grade', (draft) => {
      draft.brightness = 0.2;
      draft.saturation = 1.4;
      draft.curves = CURVE;
      return true;
    });

    // Save side: the Inspector stores gradeFromClip(clip) through the store's
    // normalizer (the store test covers localStorage; this is the data path).
    const saved = normalizeUserGradePresets([
      { id: 'user-look', label: 'Look', grade: gradeFromClip(clipById(ctrl, clipId)!) },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0].grade).toMatchObject({ brightness: 0.2, saturation: 1.4 });
    expect(saved[0].grade.curves).toEqual(CURVE);

    // Apply side: one applyClipProperties call, exactly what the Inspector does.
    const targetId = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 60, durationFrames: 30 });
    applyGradePresetTo(ctrl, [targetId], saved[0]);

    const applied = clipById(ctrl, targetId)!;
    expect(applied.brightness).toBe(0.2);
    expect(applied.saturation).toBe(1.4);
    expect(applied.curves).toEqual(CURVE);

    // The whole look is one history entry: a single undo returns the target to
    // ungraded and leaves the source clip alone.
    expect(ctrl.undo()).toBe(true);
    expect(clipById(ctrl, targetId)!.brightness).toBeUndefined();
    expect(clipById(ctrl, targetId)!.curves).toBeUndefined();
    expect(clipById(ctrl, clipId)!.curves).toEqual(CURVE);
  });

  it('every built-in preset clears omitted curves under snapshot semantics', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Edit curves', (draft) => {
      draft.curves = CURVE;
      return true;
    });

    // This used to pin the old merge contract. Named presets now replace
    // the complete grade, so a built-in's omitted curve means neutral.
    for (const preset of GRADE_PRESETS) {
      applyGradePresetTo(ctrl, [clipId], preset);
      expect(clipById(ctrl, clipId)!.curves, preset.id).toBeUndefined();
    }

    // The last built-in wrote its own fields...
    const last = GRADE_PRESETS[GRADE_PRESETS.length - 1];
    expect(clipById(ctrl, clipId)).toMatchObject(last.grade);
    // ...and "Neutral" resets the remaining sliders and omitted fields.
    applyGradePresetTo(ctrl, [clipId], gradePresetById('neutral')!);
    expect(clipById(ctrl, clipId)!.brightness).toBeUndefined();
    expect(clipById(ctrl, clipId)!.contrast).toBeUndefined();
    expect(clipById(ctrl, clipId)!.curves).toBeUndefined();
  });

  it('applies a curve-carrying look across a selection as one undo step', () => {
    const { ctrl, clipId } = controllerWithClips();
    const secondId = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 60, durationFrames: 30 });
    const preset = { id: 'user-look', label: 'Look', grade: { brightness: 0.15, curves: CURVE } };

    applyGradePresetTo(ctrl, [clipId, secondId], preset);

    expect(clipById(ctrl, clipId)!.curves).toEqual(CURVE);
    expect(clipById(ctrl, secondId)!.curves).toEqual(CURVE);

    expect(ctrl.undo()).toBe(true);
    expect(clipById(ctrl, clipId)!.curves).toBeUndefined();
    expect(clipById(ctrl, secondId)!.curves).toBeUndefined();
  });
});

describe('preset round trip with wheels', () => {
  it('a wheels-carrying look survives save -> normalize -> apply as one undo step', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Color grade', (draft) => {
      draft.brightness = 0.2;
      draft.wheels = WHEELS;
      return true;
    });

    const saved = normalizeUserGradePresets([
      { id: 'user-look', label: 'Look', grade: gradeFromClip(clipById(ctrl, clipId)!) },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0].grade).toMatchObject({ brightness: 0.2 });
    expect(saved[0].grade.wheels).toEqual(WHEELS);

    const targetId = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 60, durationFrames: 30 });
    applyGradePresetTo(ctrl, [targetId], saved[0]);

    const applied = clipById(ctrl, targetId)!;
    expect(applied.brightness).toBe(0.2);
    expect(applied.wheels).toEqual(WHEELS);

    // The whole look is one history entry: a single undo returns the target to
    // ungraded and leaves the source clip alone.
    expect(ctrl.undo()).toBe(true);
    expect(clipById(ctrl, targetId)!.brightness).toBeUndefined();
    expect(clipById(ctrl, targetId)!.wheels).toBeUndefined();
    expect(clipById(ctrl, clipId)!.wheels).toEqual(WHEELS);
  });

  it('every built-in preset clears omitted wheels under snapshot semantics', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Edit wheels', (draft) => {
      draft.wheels = WHEELS;
      return true;
    });

    // This used to pin the old merge contract; omitted wheels now mean
    // neutral so a named look is reproducible.
    for (const preset of GRADE_PRESETS) {
      applyGradePresetTo(ctrl, [clipId], preset);
      expect(clipById(ctrl, clipId)!.wheels, preset.id).toBeUndefined();
    }

    // ...and "Neutral" resets the sliders and omitted fields.
    applyGradePresetTo(ctrl, [clipId], gradePresetById('neutral')!);
    expect(clipById(ctrl, clipId)!.brightness).toBeUndefined();
    expect(clipById(ctrl, clipId)!.contrast).toBeUndefined();
    expect(clipById(ctrl, clipId)!.wheels).toBeUndefined();
  });
});

describe('preset round trip with hue curves', () => {
  it('a hue-carrying look survives save -> normalize -> apply as one undo step', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Color grade', (draft) => {
      draft.brightness = 0.2;
      draft.hueCurves = HUE_CURVES;
      return true;
    });

    const saved = normalizeUserGradePresets([
      { id: 'user-look', label: 'Look', grade: gradeFromClip(clipById(ctrl, clipId)!) },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0].grade).toMatchObject({ brightness: 0.2 });
    expect(saved[0].grade.hueCurves).toEqual(HUE_CURVES);

    const targetId = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 60, durationFrames: 30 });
    applyGradePresetTo(ctrl, [targetId], saved[0]);

    const applied = clipById(ctrl, targetId)!;
    expect(applied.brightness).toBe(0.2);
    expect(applied.hueCurves).toEqual(HUE_CURVES);

    // The whole look is one history entry: a single undo returns the target to
    // ungraded and leaves the source clip alone.
    expect(ctrl.undo()).toBe(true);
    expect(clipById(ctrl, targetId)!.brightness).toBeUndefined();
    expect(clipById(ctrl, targetId)!.hueCurves).toBeUndefined();
    expect(clipById(ctrl, clipId)!.hueCurves).toEqual(HUE_CURVES);
  });

  it('every built-in preset clears omitted hue curves under snapshot semantics', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Edit hue curves', (draft) => {
      draft.hueCurves = HUE_CURVES;
      return true;
    });

    // This used to pin the old merge contract; omitted hue curves now mean
    // neutral so applying a named look is a true snapshot.
    for (const preset of GRADE_PRESETS) {
      applyGradePresetTo(ctrl, [clipId], preset);
      expect(clipById(ctrl, clipId)!.hueCurves, preset.id).toBeUndefined();
    }

    // ...and "Neutral" resets the sliders and omitted fields.
    applyGradePresetTo(ctrl, [clipId], gradePresetById('neutral')!);
    expect(clipById(ctrl, clipId)!.brightness).toBeUndefined();
    expect(clipById(ctrl, clipId)!.contrast).toBeUndefined();
    expect(clipById(ctrl, clipId)!.hueCurves).toBeUndefined();
  });
});

describe('preset round trip with a LUT', () => {
  it('a LUT-carrying look survives save -> normalize -> apply as one undo step', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Color grade', (draft) => {
      draft.brightness = 0.2;
      draft.lut = LUT;
      return true;
    });

    const saved = normalizeUserGradePresets([
      { id: 'user-look', label: 'Look', grade: gradeFromClip(clipById(ctrl, clipId)!) },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0].grade).toMatchObject({ brightness: 0.2 });
    expect(saved[0].grade.lut).toEqual(LUT);

    const targetId = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 60, durationFrames: 30 });
    applyGradePresetTo(ctrl, [targetId], saved[0]);

    const applied = clipById(ctrl, targetId)!;
    expect(applied.brightness).toBe(0.2);
    expect(applied.lut).toEqual(LUT);

    // The whole look is one history entry: a single undo returns the target to
    // ungraded and leaves the source clip alone.
    expect(ctrl.undo()).toBe(true);
    expect(clipById(ctrl, targetId)!.brightness).toBeUndefined();
    expect(clipById(ctrl, targetId)!.lut).toBeUndefined();
    expect(clipById(ctrl, clipId)!.lut).toEqual(LUT);
  });

  it('every built-in preset clears an omitted LUT under snapshot semantics', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Apply LUT', (draft) => {
      draft.lut = LUT;
      return true;
    });

    // This used to pin the old merge contract; an omitted LUT now means
    // neutral so the target reproduces the named look exactly.
    for (const preset of GRADE_PRESETS) {
      applyGradePresetTo(ctrl, [clipId], preset);
      expect(clipById(ctrl, clipId)!.lut, preset.id).toBeUndefined();
    }

    // ...and "Neutral" resets the sliders and omitted fields.
    applyGradePresetTo(ctrl, [clipId], gradePresetById('neutral')!);
    expect(clipById(ctrl, clipId)!.brightness).toBeUndefined();
    expect(clipById(ctrl, clipId)!.contrast).toBeUndefined();
    expect(clipById(ctrl, clipId)!.lut).toBeUndefined();
  });
});

describe('preset round trip with effects', () => {
  it('an effects-carrying look survives save -> normalize -> apply as one undo step', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Effects', (draft) => {
      draft.blurRadius = FX.blurRadius;
      draft.vignette = { ...FX.vignette };
      draft.grain = { ...FX.grain };
      draft.glow = { ...FX.glow };
      return true;
    });

    const saved = normalizeUserGradePresets([
      { id: 'user-fx', label: 'FX', grade: gradeFromClip(clipById(ctrl, clipId)!) },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0].grade).toMatchObject({
      blurRadius: 8,
      vignette: FX.vignette,
      grain: FX.grain,
      glow: FX.glow,
    });

    const targetId = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 60, durationFrames: 30 });
    applyGradePresetTo(ctrl, [targetId], saved[0]);

    const applied = clipById(ctrl, targetId)!;
    expect(applied.blurRadius).toBe(8);
    expect(applied.vignette).toEqual(FX.vignette);
    expect(applied.grain).toEqual(FX.grain);
    expect(applied.glow).toEqual(FX.glow);

    // One history entry: a single undo clears the stages on the target and
    // leaves the source clip alone.
    expect(ctrl.undo()).toBe(true);
    expect(clipById(ctrl, targetId)!.blurRadius).toBeUndefined();
    expect(clipById(ctrl, targetId)!.vignette).toBeUndefined();
    expect(clipById(ctrl, targetId)!.grain).toBeUndefined();
    expect(clipById(ctrl, targetId)!.glow).toBeUndefined();
    expect(clipById(ctrl, clipId)!.glow).toEqual(FX.glow);
  });

  it('every built-in preset clears omitted effects under snapshot semantics', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Effects', (draft) => {
      draft.blurRadius = FX.blurRadius;
      draft.vignette = { ...FX.vignette };
      return true;
    });

    // This used to pin the old merge contract; omitted effect stages now
    // mean neutral, just like omitted curves and the other grade fields.
    for (const preset of GRADE_PRESETS) {
      applyGradePresetTo(ctrl, [clipId], preset);
      expect(clipById(ctrl, clipId)!.blurRadius, preset.id).toBeUndefined();
      expect(clipById(ctrl, clipId)!.vignette, preset.id).toBeUndefined();
    }
  });
});

/**
 * The Inspector's save surface (#157): "Save current as preset…" captures the
 * grade AND the clip's normalized static framing, so applying a saved look
 * reframes the target as well as recoloring it. These tests pin exactly the
 * payload the Inspector hands the store.
 */
describe('Inspector save surface captures grade + shot (#157)', () => {
  it('a fully-moved clip saves normalized shot values beside its grade', () => {
    const { ctrl, clipId: sourceId } = controllerWithClips();
    ctrl.applyClipProperties([sourceId], 'Set the look', (draft) => {
      Object.assign(draft, {
        brightness: 0.18,
        saturation: 1.25,
        x: 384,
        y: 162,
        scaleX: 1.5,
        scaleY: 0.8,
        rotation: -12,
        anchorX: 240,
        anchorY: 135,
        opacity: 0.7,
        crop: { left: 0.12, right: 0.04, top: 0.07, bottom: 0.02 },
      });
      return true;
    });
    const source = clipById(ctrl, sourceId)!;

    // The capture pair the Inspector sends through the async store.
    const capturedGrade = gradeFromClip(source);
    const capturedShot = shotFromClip(source, { width: 1920, height: 1080 });

    expect(capturedGrade).toMatchObject({ brightness: 0.18, saturation: 1.25 });
    expect(capturedShot).toEqual({
      x: 0.2,
      y: 0.15,
      scaleX: 1.5,
      scaleY: 0.8,
      rotation: -12,
      // Anchors are a fraction of the clip box (this clip is full-canvas).
      anchorX: 0.125,
      anchorY: 0.125,
      opacity: 0.7,
      crop: { left: 0.12, right: 0.04, top: 0.07, bottom: 0.02 },
    });

    // The repository's normalizer keeps the shot as a sibling of the grade,
    // never nested inside it.
    const [saved] = normalizeUserGradePresets([
      { id: 'user-framed', label: 'Framed', grade: capturedGrade, shot: capturedShot },
    ]);
    expect(saved.shot).toEqual(capturedShot);
    expect(Object.keys(saved.grade)).not.toContain('shot');

    // Applying it moves the target's framing to match, even after the project
    // canvas changes, and lands as one history entry.
    const targetId = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 60, durationFrames: 30 });
    const settings = ctrl.getProject().settings;
    ctrl.loadProject({ ...ctrl.getProject(), settings: { ...settings, width: 1280, height: 720 } });
    applyGradePresetTo(ctrl, [targetId], saved);

    const target = clipById(ctrl, targetId)!;
    expect(target).toMatchObject({
      brightness: 0.18,
      saturation: 1.25,
      x: 256,           // 0.2 of 1280
      y: 108,           // 0.15 of 720
      scaleX: 1.5,
      scaleY: 0.8,
      rotation: -12,
      opacity: 0.7,
      crop: { left: 0.12, right: 0.04, top: 0.07, bottom: 0.02 },
    });

    // One undo step for the whole look (grade + framing together).
    expect(ctrl.undo()).toBe(true);
    const undone = clipById(ctrl, targetId)!;
    expect(undone.brightness).toBeUndefined();
    expect(undone.x).not.toBe(256);
    expect(undone.rotation).not.toBe(-12);
  });

  it('a grade-only clip still saves cleanly, and a grade-only preset leaves framing alone', () => {
    const { ctrl, clipId } = controllerWithClips();
    ctrl.applyClipProperties([clipId], 'Color grade', (draft) => {
      draft.brightness = 0.2;
      return true;
    });
    const source = clipById(ctrl, clipId)!;

    // The capture pair the Inspector sends; a neutral clip has valid static
    // fields, so the UI stores them, but its grade carries no curves/effects.
    const capturedGrade = gradeFromClip(source);
    const capturedShot = shotFromClip(source, { width: 1920, height: 1080 });
    expect(capturedGrade).toMatchObject({ brightness: 0.2, contrast: 1, saturation: 1 });
    expect(capturedGrade).not.toHaveProperty('curves');
    expect(capturedGrade).not.toHaveProperty('blurRadius');
    expect(capturedShot).toBeDefined();

    // A grade-only stored preset (no shot — every pre-#157 save) still applies
    // without touching framing.
    const [gradeOnly] = normalizeUserGradePresets([
      { id: 'user-grade-only', label: 'Grade only', grade: capturedGrade },
    ]);
    expect(gradeOnly.shot).toBeUndefined();

    ctrl.applyClipProperties([clipId], 'Set target framing', (draft) => {
      Object.assign(draft, { x: 500, y: 400, rotation: 33, scaleX: 1.7 });
      return true;
    });
    applyGradePresetTo(ctrl, [clipId], gradeOnly);

    const after = clipById(ctrl, clipId)!;
    expect(after.brightness).toBe(0.2);
    expect(after).toMatchObject({ x: 500, y: 400, rotation: 33, scaleX: 1.7 });
  });
});

/**
 * The Inspector's preset linkage surface (#157): applying a saved preset records
 * the link in the same undo step as the grade, applying a built-in clears it,
 * and the "Clear link" action drops it on its own as a single undo step while
 * leaving the look untouched.
 */
describe('Inspector preset linkage (#157)', () => {
  const saved = normalizeUserGradePresets([
    { id: 'user-golden', label: 'Golden', grade: { brightness: 0.2, saturation: 1.2 } },
  ])[0];

  it('applying a saved preset records the link in the same undo step', () => {
    const { ctrl, clipId } = controllerWithClips();

    // Exactly the call the Inspector makes for a saved preset.
    applyGradePresetTo(ctrl, [clipId], saved, true);

    const clip = clipById(ctrl, clipId)!;
    expect(clip.gradePresetId).toBe('user-golden');
    expect(clip.brightness).toBe(0.2);

    // One undo removes both the look and the link together.
    expect(ctrl.undo()).toBe(true);
    const undone = clipById(ctrl, clipId)!;
    expect(undone.gradePresetId).toBeUndefined();
    expect(undone.brightness).toBeUndefined();
  });

  it('applying a built-in clears an existing link in the same step', () => {
    const { ctrl, clipId } = controllerWithClips();
    applyGradePresetTo(ctrl, [clipId], saved, true);
    expect(clipById(ctrl, clipId)!.gradePresetId).toBe('user-golden');

    // A built-in is not a saved named preset, so the Inspector passes false.
    applyGradePresetTo(ctrl, [clipId], GRADE_PRESETS[0], false);
    expect(clipById(ctrl, clipId)!.gradePresetId).toBeUndefined();
  });

  it('omitting the link flag leaves an existing link untouched', () => {
    const { ctrl, clipId } = controllerWithClips();
    applyGradePresetTo(ctrl, [clipId], saved, true);

    applyGradePresetTo(ctrl, [clipId], saved);
    expect(clipById(ctrl, clipId)!.gradePresetId).toBe('user-golden');
  });

  it('clearing the link is one undo step and leaves the grade in place', () => {
    const { ctrl, clipId } = controllerWithClips();
    applyGradePresetTo(ctrl, [clipId], saved, true);

    // Exactly the call the Inspector's "Clear link" button makes.
    ctrl.applyClipProperties([clipId], 'Clear grade preset link', (draft) => {
      delete draft.gradePresetId;
      return true;
    });

    const cleared = clipById(ctrl, clipId)!;
    expect(cleared.gradePresetId).toBeUndefined();
    expect(cleared.brightness).toBe(0.2);
    expect(cleared.saturation).toBe(1.2);

    // One undo puts the link back, and the look never moved.
    expect(ctrl.undo()).toBe(true);
    const restored = clipById(ctrl, clipId)!;
    expect(restored.gradePresetId).toBe('user-golden');
    expect(restored.brightness).toBe(0.2);
  });

  it('a hand-edited grade keeps its link — drift is metadata, not an error', () => {
    const { ctrl, clipId } = controllerWithClips();
    applyGradePresetTo(ctrl, [clipId], saved, true);

    // A manual slider edit, exactly as the Inspector writes one field.
    ctrl.applyClipProperties([clipId], 'Color grade', (draft) => {
      draft.brightness = 0.75;
      return true;
    });

    const clip = clipById(ctrl, clipId)!;
    expect(clip.gradePresetId).toBe('user-golden');
    expect(clip.brightness).toBe(0.75);
  });
});
