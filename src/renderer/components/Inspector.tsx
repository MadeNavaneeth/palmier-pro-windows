/**
 * Inspector â€” properties for the current clip selection.
 *
 * Exposes blend mode (upstream #203), opacity, fades, transitions and the
 * silence-removal controls (upstream PR #426). A single clip is edited directly;
 * a multi-clip selection edits every selected clip in one batched, single-undo
 * operation (upstream PR #419).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Pipette } from 'lucide-react';
import { useTimelineStore, type SilenceRemovalOutcome } from '../store/timeline';
import { useProjectStore } from '../store/project';
import { BLEND_MODES, BLEND_MODE_LABELS, type BlendMode } from '../../shared/types/blend-mode';
import { DEFAULT_SILENCE_CONFIG, SILENCE_LIMITS } from '../../shared/audio/silence-detector';
import { useSilenceSettings } from '../hooks/useSilenceSettings';
import { useMediaPanelStore } from '../store/media-panel';
import { evaluateMotion, type MotionEasing } from '../../shared/media/motion';
import {
  SHAPE_KINDS,
  SHAPE_STROKE_WIDTH_MAX,
  sanitizeShapeKind,
} from '../../shared/editor/shape';
import { mergeChromaKey, DEFAULT_CHROMA_KEY_COLOR } from '../../shared/editor/chroma-key';
import {
  TITLE_VARIATION_ITAL_DEFAULT,
  TITLE_VARIATION_SLNT_DEFAULT,
  TITLE_VARIATION_WDTH_DEFAULT,
  TITLE_VARIATION_WDTH_MAX,
  TITLE_VARIATION_WDTH_MIN,
  TITLE_VARIATION_WGHT_DEFAULT,
  TITLE_VARIATION_WGHT_MAX,
  TITLE_VARIATION_WGHT_MIN,
  sanitizeTitleVariationItal,
  sanitizeTitleVariationSlnt,
  sanitizeTitleVariationWdth,
  sanitizeTitleVariationWght,
} from '../../shared/editor/title';
import {
  COLOR_GRADE_LIMITS,
  DEFAULT_COLOR_GRADE,
  sanitizeColorGrade,
  type GradeCurve,
  type GradeWheels,
  type HueCurves,
} from '../../shared/editor/color-grade';
import {
  GRADE_PRESETS,
  GRADE_PRESET_NAME_MAX,
  type GradePreset,
} from '../../shared/editor/grade-preset-store';
import { LUT_INTENSITY_LIMITS, lutRefsEqual, sanitizeLutRef } from '../../shared/editor/lut';
import {
  DEFAULT_GLOW,
  DEFAULT_GRAIN,
  DEFAULT_VIGNETTE,
  EFFECT_LIMITS,
  effectsOf,
  grainsEqual,
  glowsEqual,
  sanitizeGlow,
  sanitizeGrain,
  sanitizeVignette,
  vignettesEqual,
  type Glow,
  type Grain,
  type Vignette,
} from '../../shared/editor/effects';
import {
  applyGradePresetTo,
  gradeFromClip,
  resolveGradePresetPropagation,
  shotFromClip,
  type GradePresetPropagateMode,
} from '../lib/grade-preset';
import { clipPresetLink, presetOptionLabel } from '../lib/grade-preset-label';
import { supportsMediaAdjustmentControls } from '../lib/inspector-eligibility';
import {
  hasOpacityTrack,
  nextOpacityTrack,
  opacityPercent,
  removeOpacityKeyframe,
  withOpacityEasing,
} from '../lib/opacity-track';
import { curveForEditing } from '../lib/curve-editor';
import { CurveEditor } from './CurveEditor';
import { wheelsForEditing } from '../lib/color-wheels';
import { ColorWheels } from './ColorWheels';
import { hueCurvesForEditing } from '../lib/hue-curves';
import { HueCurveEditor } from './HueCurveEditor';
import { useGradePresetsStore } from '../store/grade-presets';
import {
  COMPRESSOR_LIMITS,
  DEFAULT_COMPRESSOR,
  hasCompressor,
  mergeCompressor,
  normalizeCompressor,
  type CompressorConfig,
} from '../../shared/audio/compressor';
import {
  DEFAULT_NOISE_REDUCTION,
  NOISE_REDUCTION_LIMITS,
  noiseReductionOf,
} from '../../shared/audio/denoise';
import { linearToDb } from '../../shared/audio/normalize';
import type { Clip } from '../../shared/types/project';
import type { EditorController } from '../../shared/editor/controller';
import {
  ASPECT_PRESETS,
  QUALITY_PRESETS,
  aspectPresetMatches,
  aspectRatioLabel,
  customRatioInput,
  customRatioResolution,
  findAspectPreset,
  findQualityPreset,
  qualityPresetMatches,
  resolutionForQuality,
} from '../../shared/project/aspect-ratio';

export function Inspector() {
  // Re-render on project changes so the controls reflect the selected clip.
  useTimelineStore((s) => s.project);
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const getSelectedClip = useTimelineStore((s) => s.getSelectedClip);
  const setClipBlendMode = useTimelineStore((s) => s.setClipBlendMode);
  const setClipOpacity = useTimelineStore((s) => s.setClipOpacity);
  const setClipFade = useTimelineStore((s) => s.setClipFade);
  const setClipTransition = useTimelineStore((s) => s.setClipTransition);
  const removeSilenceForClip = useTimelineStore((s) => s.removeSilenceForClip);
  const controller = useTimelineStore((s) => s.controller);
  const fps = useTimelineStore((s) => s.project.settings.fps);
  const project = useTimelineStore((s) => s.project);
  const projectName = useProjectStore((s) => s.name);

  const [silenceStatus, setSilenceStatus] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const clip = getSelectedClip();

  const handleBlendChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (clip) setClipBlendMode(clip.id, e.target.value as BlendMode);
    },
    [clip, setClipBlendMode],
  );

  const handleOpacityChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (clip) setClipOpacity(clip.id, parseInt(e.target.value, 10) / 100);
    },
    [clip, setClipOpacity],
  );

  const handleFadeInChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (clip) setClipFade(clip.id, Math.round(parseFloat(e.target.value || '0') * fps), undefined);
    },
    [clip, setClipFade, fps],
  );

  const handleFadeOutChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (clip) setClipFade(clip.id, undefined, Math.round(parseFloat(e.target.value || '0') * fps));
    },
    [clip, setClipFade, fps],
  );

  const handleTransitionChange = useCallback(
    (type: 'none' | 'wipe' | 'slide', direction: 'left' | 'right' | 'up' | 'down') => {
      if (!clip) return;
      if (type === 'none') {
        setClipTransition(clip.id, null);
      } else {
        const frames = clip.transitionIn?.frames || Math.round(fps); // default 1s
        setClipTransition(clip.id, { type, direction, frames, softness: clip.transitionIn?.softness });
      }
    },
    [clip, setClipTransition, fps],
  );

  const handleRemoveSilence = useCallback(async () => {
    if (!clip) return;
    setWorking(true);
    setSilenceStatus('Analyzing audio…');
    const result = await removeSilenceForClip(clip.id);
    setWorking(false);
    setSilenceStatus(silenceRemovalStatus(result));
  }, [clip, removeSilenceForClip]);


  if (!clip) {
    // More than one clip (and not a single linked A/V pair): edit them together.
    if (selectedClipIds.size > 1) {
      return <MultiClipInspector />;
    }
    const totalFrames = project.timeline.clips.reduce(
      (maximum, item) => Math.max(maximum, item.startFrame + item.durationFrames),
      0,
    );
    return (
      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="panel-header flex items-center px-3 text-[11px] font-medium text-text-secondary">
          Inspector
        </div>
        <InspectorSection title="Project">
          <InspectorValue label="Name" value={projectName} />
          <InspectorValue
            label="Duration"
            value={`${(totalFrames / project.settings.fps).toFixed(1)} s`}
          />
        </InspectorSection>
        <ProjectSettingsSection />
      </div>
    );
  }

  const isAudio = clip.type === 'audio';
  const opacityPct = Math.round(clip.opacity * 100);

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      {/* Header */}
      <div className="panel-header flex items-center justify-between px-3">
        <h2 className="text-[11px] font-medium text-text-secondary">
          Inspector
        </h2>
        <span className="text-[10px] text-text-muted capitalize">{clip.type}</span>
      </div>

      <div className="space-y-3 px-3 py-3">
        {/* Clip label */}
        <div className="truncate text-xs text-text-primary" title={clip.label || clip.id}>
          {clip.label || clip.id}
        </div>

        <ColorLabelPicker clipId={clip.id} currentColor={clip.color} />

        <GenerationInfo clipId={clip.id} />

        <AssetDescription clipId={clip.id} />

        {!isAudio && (
          <>
            {/* Blend mode */}
            <div className="flex flex-col gap-1">
              <label className="text-2xs text-text-muted uppercase tracking-wide">Blend Mode</label>
              <select
                value={clip.blendMode || 'normal'}
                onChange={handleBlendChange}
                className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
              >
                {BLEND_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {BLEND_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </div>

            {/* Opacity */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label className="text-2xs text-text-muted uppercase tracking-wide">Opacity</label>
                <span className="text-2xs text-text-secondary tabular-nums">{opacityPct}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={opacityPct}
                onChange={handleOpacityChange}
                className="w-full accent-accent"
              />
            </div>

            {/* Transition fades */}
            <div className="flex flex-col gap-1">
              <label className="text-2xs text-text-muted uppercase tracking-wide">Fades (seconds)</label>
              <div className="flex gap-2">
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="text-2xs text-text-muted">In</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={((clip.fadeInFrames ?? 0) / fps).toFixed(1)}
                    onChange={handleFadeInChange}
                    className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
                  />
                </div>
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="text-2xs text-text-muted">Out</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={((clip.fadeOutFrames ?? 0) / fps).toFixed(1)}
                    onChange={handleFadeOutChange}
                    className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Opacity animation track. Sits with the opacity/fades concern but
                is a separate control from the static slider and the fades;
                gated to the decoded-media clips the track can animate. */}
            {supportsMediaAdjustmentControls(clip.type) && (
              <OpacityKeyframeControls clipId={clip.id} />
            )}

            {/* Geometric transition (wipe / slide) */}
            <div className="flex flex-col gap-1">
              <label className="text-2xs text-text-muted uppercase tracking-wide">Transition In</label>
              <div className="flex gap-2">
                <select
                  value={clip.transitionIn?.type ?? 'none'}
                  onChange={(e) =>
                    handleTransitionChange(
                      e.target.value as 'none' | 'wipe' | 'slide',
                      clip.transitionIn?.direction ?? 'left',
                    )
                  }
                  className="flex-1 rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
                >
                  <option value="none">None</option>
                  <option value="wipe">Wipe</option>
                  <option value="slide">Slide</option>
                </select>
                <select
                  value={clip.transitionIn?.direction ?? 'left'}
                  disabled={!clip.transitionIn}
                  onChange={(e) =>
                    handleTransitionChange(
                      clip.transitionIn?.type ?? 'wipe',
                      e.target.value as 'left' | 'right' | 'up' | 'down',
                    )
                  }
                  className="flex-1 rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none disabled:opacity-40"
                >
                  <option value="left">From left</option>
                  <option value="right">From right</option>
                  <option value="up">From top</option>
                  <option value="down">From bottom</option>
                </select>
              </div>
            </div>

             {/* Shape style (tutorial overlays): kind + stroke/fill only. Media
                 stages below (grade, effects, chroma, edges) operate on
                 decoded frames and do not apply to vector shapes. */}
            {clip.type === 'shape' && (
              <ShapeControls clipId={clip.id} clip={clip} controller={controller} />
            )}

             {/* Variable-font axes (upstream issue #50): mechanical sliders
                 only — one undo step per change, default clears the field so
                 presence always means non-default (the bake-routing rule). */}
            {clip.type === 'title' && (
              <TitleVariationControls clipId={clip.id} clip={clip} controller={controller} />
            )}

             {/* Media stages below (grade, effects, chroma, edges) operate on
                 decoded frames. Title, shape, and compound clips use separate
                 render paths and bypass them; generated clips stay eligible. */}
            {supportsMediaAdjustmentControls(clip.type) && (
              <>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={clip.invertColors ?? false}
                  onChange={(e) => {
                    if (clip) {
                      controller.applyClipProperties([clip.id], 'Invert colors', (draft) => {
                        if (e.target.checked) draft.invertColors = true;
                        else delete draft.invertColors;
                        return true;
                      });
                    }
                  }}
                  className="accent-[var(--color-accent)]"
                />
                <span className="text-2xs text-text-muted uppercase tracking-wide">Invert Colors</span>
              </label>
            </div>

            {/* Color grade + named presets (upstream #157, stack from R4) */}
            <ColorGradeControls clipId={clip.id} clip={clip} controller={controller} />

            {/* Effects subgroups (upstream #157: blur, vignette, grain, glow) */}
            <EffectsControls clipId={clip.id} clip={clip} controller={controller} />

            {/* Chroma key (upstream issue #97) */}
            <ChromaKeyControls clipId={clip.id} chromaKey={clip.chromaKey} controller={controller} />

            {/* Edge rounding & softness (upstream PR #369) */}
            {(() => {
              const roundingPct = Math.round((clip.edgeRounding ?? 0) * 100);
              const softnessPct = Math.round((clip.edgeSoftness ?? 0) * 100);
              return (
                <div className="flex flex-col gap-2 pt-1">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <label className="text-2xs text-text-muted uppercase tracking-wide">Edge Rounding</label>
                      <span className="text-2xs text-text-secondary tabular-nums">{roundingPct}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={roundingPct}
                      onChange={(e) => {
                        if (clip) {
                          const v = Number(e.target.value) / 100;
                          controller.applyClipProperties([clip.id], 'Edge rounding', (draft) => {
                            if (v > 0) draft.edgeRounding = v;
                            else delete draft.edgeRounding;
                            return true;
                          });
                        }
                      }}
                      className="w-full accent-accent"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <label className="text-2xs text-text-muted uppercase tracking-wide">Edge Softness</label>
                      <span className="text-2xs text-text-secondary tabular-nums">{softnessPct}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={softnessPct}
                      onChange={(e) => {
                        if (clip) {
                          const v = Number(e.target.value) / 100;
                          controller.applyClipProperties([clip.id], 'Edge softness', (draft) => {
                            if (v > 0) draft.edgeSoftness = v;
                            else delete draft.edgeSoftness;
                            return true;
                          });
                        }
                      }}
                      className="w-full accent-accent"
                    />
                  </div>
                </div>
              );
            })()}
              </>
            )}
          </>
        )}

        {isAudio && (
          <>
            <p className="text-2xs text-text-muted">
              Audio clip — compositing properties don't apply.
            </p>
            <EqControls clipId={clip.id} clip={clip} />
            <CompressorControls clipId={clip.id} clip={clip} />
            <NoiseReductionControls clipId={clip.id} clip={clip} />
            <VolumeKeyframeControls clipId={clip.id} />
          </>
        )}

        {(clip.type === 'video' || clip.type === 'image' || clip.type === 'shape') && (
          <MotionControls clipId={clip.id} />
        )}

        {/* Audio tools — available for audio and video clips (both can carry sound). */}
        {clip.type !== 'image' && clip.type !== 'title' && clip.type !== 'shape' && (
          <SilenceRemovalControls
            onRemove={handleRemoveSilence}
            working={working}
            status={silenceStatus}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The one status line under "Remove Silence".
 *
 * The detector reads the whole asset while the clip shows a trimmed part of it,
 * so a detected span with no overlap in the clip is omitted rather than clamped
 * to the nearest edge (upstream PR #426). Reporting that as "No silence found."
 * would be a false statement about the user's own audio, so a span that was
 * found and left in place is named as such: how many were found, how many were
 * removed, and why the rest produced no cut. Nothing found is still the plain
 * "no silence" line.
 */
export function silenceRemovalStatus(result: SilenceRemovalOutcome): string {
  if (result.error) return result.error;
  const outsideClip = result.omitted?.['outside-clip'] ?? 0;
  const invalid = result.omitted?.['invalid-range'] ?? 0;
  const omitted = outsideClip + invalid;
  if (omitted === 0) {
    return result.removed === 0
      ? 'No silence found.'
      : `Removed ${result.removed} silent gap${result.removed === 1 ? '' : 's'}.`;
  }
  const found = result.removed + omitted;
  const gaps = `silent gap${found === 1 ? '' : 's'}`;
  const why = [
    ...(outsideClip > 0 ? [`${outsideClip} outside this clip's trimmed window`] : []),
    ...(invalid > 0 ? [`${invalid} with invalid timings`] : []),
  ].join(', ');
  return result.removed === 0
    ? `Found ${found} ${gaps} in this audio, but removed none: ${why}.`
    : `Removed ${result.removed} of ${found} ${gaps}: ${why}.`;
}

/**
 * Color grade + named presets (upstream #157).
 *
 * The grade fields (exposure/temperature/tint/vibrance/highlights/shadows/
 * blacks/whites/brightness/contrast/saturation/hue) were rendered by both preview and export since R4 but had no way to be set
 * from the UI —
 * only the model knew them. Each slider writes one field through `applyClipProperties`
 * as one undo step and removes the field at its default, so a neutral clip
 * still reads as ungraded everywhere (`hasColorGrade`). Presets apply the
 * whole grade at once; the built-in list and the user's own saved looks share
 * one picker, and a saved look can be deleted from the same row. A saved look
 * also carries the clip's curves, while a built-in look leaves the clip's own
 * curves untouched (see `lib/grade-preset`).
 *
 * "Save current as preset…" stores the whole look, not just the grade: the
 * clip's effects ride along with the grade, and its current static framing
 * (position, scale, rotation, opacity, crop) is captured as a normalized shot
 * sibling so the saved name is portable across project sizes. Such a row is
 * marked "· grade + framing" in the picker, because applying it reframes the
 * clip as well as recoloring it. Motion tracks are deliberately not captured
 * and keep winning over the static values. Both halves land in one
 * `applyClipProperties` call, so applying a preset is a single undo step.
 *
 * Applying a saved preset also records `Clip.gradePresetId` in that same step,
 * and the row then shows which preset the clip uses. That link is metadata
 * only: a later manual grade edit makes it stale, and drift is deliberately
 * not detected or repaired, so the note never claims the clip still matches.
 * A link whose preset was deleted degrades to a quiet "Preset no longer
 * exists" with the same "Clear link" action — the clip's look is untouched
 * either way. Clearing the link is one undo step that leaves the grade and
 * framing exactly as they are.
 *
 * The tone-curve editor at the bottom writes the clip's `curves` field through
 * the same sanitize-then-apply path, so a curve drag is one undo step and an
 * all-identity curve clears the field like a neutral slider does. The color
 * wheels below it work the same way over the clip's `wheels` field: pad drags
 * and master changes commit once per gesture. The hue-curves editor below the
 * wheels works the same way over `hueCurves`, with the cyclic eval wrapping
 * the drawn stroke across the 0/1 seam.
 */
/**
 * The grade block's apply step: resolve the opt-in propagation, then write the
 * snapshot to the whole covered set in one undo step.
 *
 * Split out of the component so the wiring can be exercised without a DOM
 * event. With no modes the cover is exactly the one clip the user is looking
 * at, so an unticked apply is byte-for-byte the previous single-clip apply. A
 * covered clip that cannot be written refuses the whole call and leaves the
 * project untouched rather than leaving the look half applied.
 */
export function applyPresetWithPropagation(
  controller: EditorController,
  clipId: string,
  preset: GradePreset,
  linkPreset: boolean,
  modes: readonly GradePresetPropagateMode[],
): { ok: true; clipIds: string[] } | { ok: false; error: string } {
  const cover = resolveGradePresetPropagation(
    controller,
    [clipId],
    modes,
    (clip) => supportsMediaAdjustmentControls(clip.type),
  );
  if (!cover.ok) return { ok: false, error: cover.error };
  applyGradePresetTo(controller, cover.cover.clipIds, preset, linkPreset);
  return { ok: true, clipIds: cover.cover.clipIds };
}

export function ColorGradeControls({
  clipId,
  clip,
  controller,
}: {
  clipId: string;
  clip: Clip;
  controller: EditorController;
}) {
  const userPresets = useGradePresetsStore((state) => state.presets);
  const saveUserPreset = useGradePresetsStore((state) => state.save);
  const removeUserPreset = useGradePresetsStore((state) => state.remove);
  const [lastPresetId, setLastPresetId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [saveError, setSaveError] = useState('');
  // Propagation is a per-apply choice, never a remembered default: both boxes
  // start unchecked so a preset never leaves the clip the user is looking at.
  const [propagateLinked, setPropagateLinked] = useState(false);
  const [propagateSyncLock, setPropagateSyncLock] = useState(false);
  const [applyError, setApplyError] = useState('');

  // Normalized shot capture needs the project canvas (position is a fraction of
  // it), so the saved look travels with the project size.
  const canvas = useTimelineStore((s) => s.project.settings);

  // Slider values plus the clip's curves, which is also what "Save current as
  // preset…" stores (`lib/grade-preset`: identity curves are omitted).
  const current = gradeFromClip(clip);
  const graded =
    clip.brightness !== undefined
    || clip.contrast !== undefined
    || clip.saturation !== undefined
    || clip.hueRotation !== undefined
    || clip.exposure !== undefined
    || clip.temperature !== undefined
    || clip.tint !== undefined
    || clip.vibrance !== undefined
    || clip.highlights !== undefined
    || clip.shadows !== undefined
    || clip.blacks !== undefined
    || clip.whites !== undefined
    || clip.curves !== undefined
    || clip.wheels !== undefined
    || clip.hueCurves !== undefined
    || clip.lut !== undefined;

  const setField = (field: keyof typeof COLOR_GRADE_LIMITS, value: number) => {
    const sanitized = sanitizeColorGrade({ [field]: value });
    if (sanitized[field] === undefined) return;
    controller.applyClipProperties([clipId], 'Color grade', (draft) => {
      if (sanitized[field] === DEFAULT_COLOR_GRADE[field]) delete draft[field];
      else draft[field] = sanitized[field];
      return true;
    });
  };

  // The curve editor commits one whole curve per gesture. `sanitizeColorGrade`
  // canonicalizes it back to no field at all once every channel is identity,
  // which is what keeps a cleared curve out of `hasColorGrade`.
  const setCurves = (next: GradeCurve, label: string) => {
    const sanitized = sanitizeColorGrade({ curves: next });
    controller.applyClipProperties([clipId], label, (draft) => {
      if (sanitized.curves) draft.curves = sanitized.curves;
      else delete draft.curves;
      return true;
    });
  };

  // The wheels editor commits one whole wheels per gesture, same shape: an
  // all-identity wheels deletes the field so a cleared wheels leaves no
  // grading behind.
  const setWheels = (next: GradeWheels, label: string) => {
    const sanitized = sanitizeColorGrade({ wheels: next });
    controller.applyClipProperties([clipId], label, (draft) => {
      if (sanitized.wheels) draft.wheels = sanitized.wheels;
      else delete draft.wheels;
      return true;
    });
  };

  // The hue-curves editor commits one whole channel set per gesture, same
  // shape: all-neutral channels delete the field so cleared hue curves leave
  // no grading behind.
  const setHueCurves = (next: HueCurves, label: string) => {
    const sanitized = sanitizeColorGrade({ hueCurves: next });
    controller.applyClipProperties([clipId], label, (draft) => {
      if (sanitized.hueCurves) draft.hueCurves = sanitized.hueCurves;
      else delete draft.hueCurves;
      return true;
    });
  };

  // Applying a saved preset records the link on the clip in the same single
  // undo step as the grade/shot. A built-in is not a saved named preset, so it
  // clears the link rather than recording one (same contract as the agent's
  // apply_grade_preset linkPreset flag). Propagation adds the ticked relations
  // to the same batch, so a pushed apply is still one undo step.
  const applyPreset = (preset: GradePreset) => {
    const isUserPreset = userPresets.some((candidate) => candidate.id === preset.id);
    const modes: GradePresetPropagateMode[] = [
      ...(propagateLinked ? ['linked' as const] : []),
      ...(propagateSyncLock ? ['syncLock' as const] : []),
    ];
    const result = applyPresetWithPropagation(controller, clipId, preset, isUserPreset, modes);
    if (!result.ok) {
      setApplyError(result.error);
      return;
    }
    setApplyError('');
    setLastPresetId(preset.id);
  };

  // Which saved look this clip is linked to. Drift after a hand edit is not
  // detected (deliberate), so this only says the link exists, not that the clip
  // still matches the preset.
  const linked = clipPresetLink(clip, userPresets);

  const clearPresetLink = () => {
    // One undo step: drop the link and leave the grade/shot exactly as they
    // are, matching every other single-field edit in this block.
    controller.applyClipProperties([clipId], 'Clear grade preset link', (draft) => {
      delete draft.gradePresetId;
      return true;
    });
  };

  const lastUserPreset = lastPresetId
    ? userPresets.find((preset) => preset.id === lastPresetId) ?? null
    : null;

  const commitSave = async () => {
    // Save the whole look, not just the grade (upstream #157): the clip's
    // current static framing travels with it as a normalized shot sibling, so
    // applying the preset reframes the target as well as recoloring it. Motion
    // tracks stay out of the payload and keep winning over the static values.
    const shot = shotFromClip(clip, canvas);
    const stored = await saveUserPreset(presetName, { ...current }, shot);
    if (!stored) {
      // The async store returns null for a refused or failed save; the
      // repository owns the reason, so name the class of refusals here.
      setSaveError(
        `Could not save — enter a name (max ${GRADE_PRESET_NAME_MAX} characters) that is not already used.`,
      );
      return;
    }
    setLastPresetId(stored.id);
    setSaving(false);
    setPresetName('');
    setSaveError('');
  };

  const removeLastPreset = async () => {
    if (!lastUserPreset) return;
    if (await removeUserPreset(lastUserPreset.id)) {
      setLastPresetId(null);
      setSaveError('');
      return;
    }
    setSaveError(`Could not delete “${lastUserPreset.label}”.`);
  };

  const reset = () => {
    controller.applyClipProperties([clipId], 'Reset color grade', (draft) => {
      delete draft.brightness;
      delete draft.contrast;
      delete draft.saturation;
      delete draft.hueRotation;
      delete draft.exposure;
      delete draft.temperature;
      delete draft.tint;
      delete draft.vibrance;
      delete draft.highlights;
      delete draft.shadows;
      delete draft.blacks;
      delete draft.whites;
      delete draft.curves;
      delete draft.wheels;
      delete draft.hueCurves;
      delete draft.lut;
      return true;
    });
  };

  return (
    <div className="flex flex-col gap-2 border-t border-white/10 pt-1" data-color-grade>
      <div className="flex items-center justify-between">
        <label className="text-2xs uppercase tracking-wide text-text-muted">Color Grade</label>
        {graded && (
          <button
            onClick={reset}
            className="text-2xs text-text-muted underline decoration-dotted transition hover:text-text-secondary"
          >
            Reset
          </button>
        )}
      </div>

      <select
        value=""
        onChange={(event) => {
          const preset = [...GRADE_PRESETS, ...userPresets]
            .find((candidate) => candidate.id === event.target.value);
          if (preset) applyPreset(preset);
        }}
        aria-label="Apply grade preset"
        data-grade-preset
        className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
      >
        <option value="" disabled>
          Apply a preset…
        </option>
        <optgroup label="Built-in">
          {GRADE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </optgroup>
        {userPresets.length > 0 && (
          <optgroup label="My presets">
            {userPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {presetOptionLabel(preset)}
              </option>
            ))}
          </optgroup>
        )}
      </select>

      {/* Opt-in push, never a default: the boxes read "also" so the extra
          clips are the user's explicit choice for this apply. */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={propagateLinked}
            onChange={(event) => setPropagateLinked(event.target.checked)}
            data-grade-preset-propagate="linked"
            aria-label="Also apply to linked clips"
            className="accent-[var(--color-accent)]"
          />
          <span className="text-2xs uppercase tracking-wide text-text-muted">Also linked clips</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={propagateSyncLock}
            onChange={(event) => setPropagateSyncLock(event.target.checked)}
            data-grade-preset-propagate="syncLock"
            aria-label="Also apply to sync-locked tracks"
            className="accent-[var(--color-accent)]"
          />
          <span className="text-2xs uppercase tracking-wide text-text-muted">Also sync-locked tracks</span>
        </label>
      </div>
      {applyError && (
        <p className="text-[9px] text-red-400" data-grade-preset-propagate-error>{applyError}</p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            setSaving((value) => !value);
            setSaveError('');
          }}
          data-grade-preset-save
          title="Saves the clip's color grade, effects, and current framing (position, scale, rotation, opacity, crop) under one name"
          className="rounded border border-surface-4 px-1.5 py-0.5 text-[9px] text-text-secondary hover:bg-white/10 hover:text-text-primary"
        >
          Save current as preset…
        </button>
        {lastUserPreset && (
          <button
            type="button"
            onClick={() => void removeLastPreset()}
            data-grade-preset-delete
            className="rounded px-1.5 py-0.5 text-[9px] text-red-400 hover:bg-red-500/10"
          >
            Delete “{lastUserPreset.label}”
          </button>
        )}
        {/* Which saved look this clip is linked to (#157). Plain, factual, and
            truncating so a long name cannot push the row wider. */}
        {linked.kind !== 'none' && (
          <span
            className="flex min-w-0 items-baseline gap-1 text-[9px] text-text-muted"
            data-grade-preset-link
            title={
              linked.kind === 'linked'
                ? `Linked to “${linked.label}” — manual grade edits since then are not tracked`
                : 'This clip points at a saved preset that no longer exists'
            }
          >
            <span className="min-w-0 truncate">
              {linked.kind === 'linked' ? `Using “${linked.label}”` : 'Preset no longer exists'}
            </span>
            <button
              type="button"
              onClick={clearPresetLink}
              data-grade-preset-unlink
              className="shrink-0 rounded px-1 py-0.5 text-[9px] text-text-secondary underline decoration-dotted hover:text-text-primary"
            >
              Clear link
            </button>
          </span>
        )}
      </div>
      {saving && (
        <div className="flex items-center gap-1.5">
          <input
            value={presetName}
            onChange={(event) => setPresetName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commitSave();
              if (event.key === 'Escape') setSaving(false);
            }}
            placeholder="Preset name"
            maxLength={GRADE_PRESET_NAME_MAX}
            autoFocus
            aria-label="New grade preset name"
            className="min-w-0 flex-1 rounded border border-surface-3 bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={commitSave}
            className="rounded bg-accent px-1.5 py-0.5 text-[9px] font-medium text-surface-0 hover:bg-accent-hover"
          >
            Save
          </button>
        </div>
      )}
      {saveError && <p className="text-[9px] text-red-400">{saveError}</p>}

      <GradeSlider
        label="Exposure"
        value={current.exposure}
        min={COLOR_GRADE_LIMITS.exposure.min}
        max={COLOR_GRADE_LIMITS.exposure.max}
        step={0.1}
        format={(value) => `${value > 0 ? '+' : ''}${value.toFixed(1)} EV`}
        onChange={(value) => setField('exposure', value)}
      />
      <GradeSlider
        label="Temperature"
        value={current.temperature}
        min={COLOR_GRADE_LIMITS.temperature.min}
        max={COLOR_GRADE_LIMITS.temperature.max}
        step={50}
        format={(value) => `${Math.round(value)} K`}
        onChange={(value) => setField('temperature', value)}
      />
      <GradeSlider
        label="Tint"
        value={current.tint}
        min={COLOR_GRADE_LIMITS.tint.min}
        max={COLOR_GRADE_LIMITS.tint.max}
        step={1}
        format={(value) => `${value > 0 ? '+' : ''}${value}`}
        onChange={(value) => setField('tint', value)}
      />
      <GradeSlider
        label="Vibrance"
        value={current.vibrance}
        min={COLOR_GRADE_LIMITS.vibrance.min}
        max={COLOR_GRADE_LIMITS.vibrance.max}
        step={0.05}
        format={(value) => (value === 0 ? '0' : `${value > 0 ? '+' : ''}${value.toFixed(2)}`)}
        onChange={(value) => setField('vibrance', value)}
      />
      <GradeSlider
        label="Highlights"
        value={current.highlights}
        min={COLOR_GRADE_LIMITS.highlights.min}
        max={COLOR_GRADE_LIMITS.highlights.max}
        step={0.05}
        format={(value) => (value === 0 ? '0' : `${value > 0 ? '+' : ''}${value.toFixed(2)}`)}
        onChange={(value) => setField('highlights', value)}
      />
      <GradeSlider
        label="Shadows"
        value={current.shadows}
        min={COLOR_GRADE_LIMITS.shadows.min}
        max={COLOR_GRADE_LIMITS.shadows.max}
        step={0.05}
        format={(value) => (value === 0 ? '0' : `${value > 0 ? '+' : ''}${value.toFixed(2)}`)}
        onChange={(value) => setField('shadows', value)}
      />
      <GradeSlider
        label="Blacks"
        value={current.blacks}
        min={COLOR_GRADE_LIMITS.blacks.min}
        max={COLOR_GRADE_LIMITS.blacks.max}
        step={0.05}
        format={(value) => (value === 0 ? '0' : `${value > 0 ? '+' : ''}${value.toFixed(2)}`)}
        onChange={(value) => setField('blacks', value)}
      />
      <GradeSlider
        label="Whites"
        value={current.whites}
        min={COLOR_GRADE_LIMITS.whites.min}
        max={COLOR_GRADE_LIMITS.whites.max}
        step={0.05}
        format={(value) => (value === 0 ? '0' : `${value > 0 ? '+' : ''}${value.toFixed(2)}`)}
        onChange={(value) => setField('whites', value)}
      />
      <GradeSlider
        label="Brightness"
        value={current.brightness}
        min={COLOR_GRADE_LIMITS.brightness.min}
        max={COLOR_GRADE_LIMITS.brightness.max}
        step={0.01}
        format={(value) => `${Math.round(value * 100)}%`}
        onChange={(value) => setField('brightness', value)}
      />
      <GradeSlider
        label="Contrast"
        value={current.contrast}
        min={COLOR_GRADE_LIMITS.contrast.min}
        max={COLOR_GRADE_LIMITS.contrast.max}
        step={0.01}
        format={(value) => `${value.toFixed(2)}×`}
        onChange={(value) => setField('contrast', value)}
      />
      <GradeSlider
        label="Saturation"
        value={current.saturation}
        min={COLOR_GRADE_LIMITS.saturation.min}
        max={COLOR_GRADE_LIMITS.saturation.max}
        step={0.01}
        format={(value) => `${value.toFixed(2)}×`}
        onChange={(value) => setField('saturation', value)}
      />
      <GradeSlider
        label="Hue"
        value={current.hueRotation}
        min={COLOR_GRADE_LIMITS.hueRotation.min}
        max={COLOR_GRADE_LIMITS.hueRotation.max}
        step={1}
        format={(value) => `${Math.round(value)}°`}
        onChange={(value) => setField('hueRotation', value)}
      />

      <CurveEditor curve={curveForEditing(clip.curves)} onCommit={setCurves} />

      <ColorWheels wheels={wheelsForEditing(clip.wheels)} onCommit={setWheels} />

      <HueCurveEditor curves={hueCurvesForEditing(clip.hueCurves)} onCommit={setHueCurves} />

      <LutControls clipId={clipId} clip={clip} controller={controller} />
    </div>
  );
}

/**
 * .cube LUT row (upstream #157 LUTs).
 *
 * Mechanical only, from existing patterns: the file button copies the preset
 * picker's bordered style and shows the chosen file's name (upstream's file
 * row shows the last path component the same way), the intensity control is
 * the shared GradeSlider below, and Remove copies the preset delete button's
 * red style. Every write goes through `applyClipProperties` as one undo
 * step; choosing a file keeps the current intensity (upstream's picker only
 * writes the path), and an intensity identical to the stored one writes
 * nothing, so scrubbing back to the start adds no history.
 *
 * A stored path whose file went missing diagnoses here (the main-process
 * validate IPC names the reason) while preview and export skip that stage.
 */
function LutControls({
  clipId,
  clip,
  controller,
}: {
  clipId: string;
  clip: Clip;
  controller: EditorController;
}) {
  const lut = sanitizeLutRef(clip.lut);
  const [notice, setNotice] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    if (!clip.lut?.path) {
      setNotice(null);
      return;
    }
    let cancelled = false;
    const api = (window as unknown as { palmier?: { media?: {
      validateLut?: (path: string) => Promise<unknown>;
    } } }).palmier?.media;
    if (!api?.validateLut) {
      setNotice(null);
      return;
    }
    api.validateLut(clip.lut.path)
      .then((result) => {
        if (cancelled) return;
        const res = result as { valid?: boolean; error?: unknown };
        setNotice(res.valid ? null : (typeof res.error === 'string' ? res.error : 'LUT file is missing or invalid.'));
      })
      .catch(() => {
        if (!cancelled) setNotice('LUT file could not be checked.');
      });
    return () => {
      cancelled = true;
    };
  }, [clip.lut?.path]);

  const fileName = lut?.path.split(/[\\/]/).pop() ?? null;

  const choose = async () => {
    const api = (window as unknown as { palmier?: { media?: {
      chooseLut?: () => Promise<unknown>;
    } } }).palmier?.media;
    if (!api?.chooseLut || choosing) return;
    setChoosing(true);
    try {
      const result = await api.chooseLut() as {
        success?: boolean; canceled?: boolean; lut?: unknown; error?: unknown;
      };
      if (!result?.success || !result.lut) {
        if (result && !result.canceled && typeof result.error === 'string') setNotice(result.error);
        return;
      }
      const sanitized = sanitizeLutRef(result.lut);
      if (!sanitized) {
        setNotice('That file is not a usable .cube LUT.');
        return;
      }
      const existingIntensity = sanitizeLutRef(clip.lut)?.intensity;
      const next = existingIntensity !== undefined
        ? { ...sanitized, intensity: existingIntensity }
        : sanitized;
      if (lutRefsEqual(next, clip.lut)) return;
      setNotice(null);
      controller.applyClipProperties([clipId], 'Apply LUT', (draft) => {
        draft.lut = next;
        return true;
      });
    } finally {
      setChoosing(false);
    }
  };

  const setIntensity = (value: number) => {
    const clamped = Math.min(LUT_INTENSITY_LIMITS.max, Math.max(LUT_INTENSITY_LIMITS.min, value));
    controller.applyClipProperties([clipId], 'Change LUT intensity', (draft) => {
      const existing = sanitizeLutRef(draft.lut);
      if (!existing) return true;
      const next = { ...existing, intensity: clamped };
      if (lutRefsEqual(next, draft.lut)) return true;
      draft.lut = next;
      return true;
    });
  };

  const remove = () => {
    controller.applyClipProperties([clipId], 'Remove LUT', (draft) => {
      delete draft.lut;
      return true;
    });
  };

  return (
    <div className="flex flex-col gap-2 border-t border-white/10 pt-1" data-lut>
      <div className="flex items-center justify-between">
        <label className="text-2xs uppercase tracking-wide text-text-muted">LUT</label>
        {lut && (
          <button
            type="button"
            onClick={remove}
            data-lut-remove
            className="rounded px-1.5 py-0.5 text-[9px] text-red-400 hover:bg-red-500/10"
          >
            Remove
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={choose}
        disabled={choosing}
        aria-label="Choose LUT file"
        data-lut-choose
        title={lut?.path ?? 'Choose a .cube LUT file'}
        className="w-full truncate rounded border border-surface-3 bg-surface-2 px-2 py-1 text-left text-xs text-text-primary focus:border-accent focus:outline-none disabled:opacity-60"
      >
        {fileName ?? 'Choose .cube…'}
      </button>
      {lut && (
        <GradeSlider
          label="Intensity"
          value={lut.intensity}
          min={LUT_INTENSITY_LIMITS.min}
          max={LUT_INTENSITY_LIMITS.max}
          step={0.01}
          format={(value) => `${Math.round(value * 100)}%`}
          onChange={setIntensity}
        />
      )}
      {notice && <p className="text-[9px] text-red-400">{notice}</p>}
    </div>
  );
}

/**
 * Effects subgroups (upstream #157: Detail, Blur, Vignette, Film Grain,
 * Glow — only the shippable stages, see `shared/editor/effects.ts`).
 *
 * Mechanical only: every row is the shared GradeSlider below, writing one
 * field through `applyClipProperties` as one undo step. A slider moved off
 * identity creates the stage filled with registry defaults (upstream's
 * upsert rule); steering every component back to default prunes the field,
 * so a cleared effect leaves no grading behind. An identical write assigns
 * nothing, so scrubbing back to the start adds no history.
 */
function EffectsControls({
  clipId,
  clip,
  controller,
}: {
  clipId: string;
  clip: Clip;
  controller: EditorController;
}) {
  const effected = effectsOf(clip) !== null;

  const setBlur = (value: number) => {
    controller.applyClipProperties([clipId], 'Blur', (draft) => {
      if (value === EFFECT_LIMITS.blurRadius.min) delete draft.blurRadius;
      else draft.blurRadius = value;
      return true;
    });
  };

  const setVignette = (patch: Partial<Vignette>) => {
    controller.applyClipProperties([clipId], 'Vignette', (draft) => {
      const merged = { ...(sanitizeVignette(draft.vignette) ?? { ...DEFAULT_VIGNETTE }), ...patch };
      const next = sanitizeVignette(merged);
      if (vignettesEqual(next, draft.vignette)) return true;
      if (next) draft.vignette = next;
      else delete draft.vignette;
      return true;
    });
  };

  const setGrain = (patch: Partial<Grain>) => {
    controller.applyClipProperties([clipId], 'Film grain', (draft) => {
      const merged = { ...(sanitizeGrain(draft.grain) ?? { ...DEFAULT_GRAIN }), ...patch };
      const next = sanitizeGrain(merged);
      if (grainsEqual(next, draft.grain)) return true;
      if (next) draft.grain = next;
      else delete draft.grain;
      return true;
    });
  };

  const setGlow = (patch: Partial<Glow>) => {
    controller.applyClipProperties([clipId], 'Glow', (draft) => {
      const merged = { ...(sanitizeGlow(draft.glow) ?? { ...DEFAULT_GLOW }), ...patch };
      const next = sanitizeGlow(merged);
      if (glowsEqual(next, draft.glow)) return true;
      if (next) draft.glow = next;
      else delete draft.glow;
      return true;
    });
  };

  const reset = () => {
    controller.applyClipProperties([clipId], 'Reset effects', (draft) => {
      delete draft.blurRadius;
      delete draft.vignette;
      delete draft.grain;
      delete draft.glow;
      return true;
    });
  };

  const vignette = sanitizeVignette(clip.vignette) ?? { ...DEFAULT_VIGNETTE };
  const grain = sanitizeGrain(clip.grain) ?? { ...DEFAULT_GRAIN };
  const glow = sanitizeGlow(clip.glow) ?? { ...DEFAULT_GLOW };
  const percent = (value: number): string => `${Math.round(value * 100)}%`;
  const signedPercent = (value: number): string => (value === 0 ? '0' : `${value > 0 ? '+' : ''}${Math.round(value * 100)}%`);
  const px = (value: number): string => `${Math.round(value)}px`;

  return (
    <div className="flex flex-col gap-2 border-t border-white/10 pt-1" data-effects>
      <div className="flex items-center justify-between">
        <label className="text-2xs uppercase tracking-wide text-text-muted">Effects</label>
        {effected && (
          <button
            onClick={reset}
            className="text-2xs text-text-muted underline decoration-dotted transition hover:text-text-secondary"
          >
            Reset
          </button>
        )}
      </div>
      <GradeSlider
        label="Blur"
        value={clip.blurRadius ?? EFFECT_LIMITS.blurRadius.min}
        min={EFFECT_LIMITS.blurRadius.min}
        max={EFFECT_LIMITS.blurRadius.max}
        step={1}
        format={px}
        onChange={setBlur}
      />
      <GradeSlider
        label="Vignette amount"
        value={vignette.amount}
        min={EFFECT_LIMITS.vignette.amount.min}
        max={EFFECT_LIMITS.vignette.amount.max}
        step={0.05}
        format={signedPercent}
        onChange={(value) => setVignette({ amount: value })}
      />
      <GradeSlider
        label="Vignette midpoint"
        value={vignette.midpoint}
        min={EFFECT_LIMITS.vignette.midpoint.min}
        max={EFFECT_LIMITS.vignette.midpoint.max}
        step={0.05}
        format={percent}
        onChange={(value) => setVignette({ midpoint: value })}
      />
      <GradeSlider
        label="Vignette roundness"
        value={vignette.roundness}
        min={EFFECT_LIMITS.vignette.roundness.min}
        max={EFFECT_LIMITS.vignette.roundness.max}
        step={0.05}
        format={signedPercent}
        onChange={(value) => setVignette({ roundness: value })}
      />
      <GradeSlider
        label="Vignette feather"
        value={vignette.feather}
        min={EFFECT_LIMITS.vignette.feather.min}
        max={EFFECT_LIMITS.vignette.feather.max}
        step={0.05}
        format={percent}
        onChange={(value) => setVignette({ feather: value })}
      />
      <GradeSlider
        label="Grain amount"
        value={grain.amount}
        min={EFFECT_LIMITS.grain.amount.min}
        max={EFFECT_LIMITS.grain.amount.max}
        step={0.05}
        format={percent}
        onChange={(value) => setGrain({ amount: value })}
      />
      <GradeSlider
        label="Grain size"
        value={grain.size}
        min={EFFECT_LIMITS.grain.size.min}
        max={EFFECT_LIMITS.grain.size.max}
        step={0.1}
        format={(value) => `${value.toFixed(1)}px`}
        onChange={(value) => setGrain({ size: value })}
      />
      <GradeSlider
        label="Glow intensity"
        value={glow.intensity}
        min={EFFECT_LIMITS.glow.intensity.min}
        max={EFFECT_LIMITS.glow.intensity.max}
        step={0.05}
        format={percent}
        onChange={(value) => setGlow({ intensity: value })}
      />
      <GradeSlider
        label="Glow radius"
        value={glow.radius}
        min={EFFECT_LIMITS.glow.radius.min}
        max={EFFECT_LIMITS.glow.radius.max}
        step={1}
        format={px}
        onChange={(value) => setGlow({ radius: value })}
      />
      <GradeSlider
        label="Glow threshold"
        value={glow.threshold}
        min={EFFECT_LIMITS.glow.threshold.min}
        max={EFFECT_LIMITS.glow.threshold.max}
        step={0.05}
        format={percent}
        onChange={(value) => setGlow({ threshold: value })}
      />
      <GradeSlider
        label="Glow warmth"
        value={glow.warmth}
        min={EFFECT_LIMITS.glow.warmth.min}
        max={EFFECT_LIMITS.glow.warmth.max}
        step={0.05}
        format={percent}
        onChange={(value) => setGlow({ warmth: value })}
      />
    </div>
  );
}

function GradeSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between">
        <span className="text-2xs text-text-muted uppercase tracking-wide">{label}</span>
        <span className="text-2xs tabular-nums text-text-secondary">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={`Color grade ${label.toLowerCase()}`}
        className="w-full accent-accent"
      />
    </div>
  );
}

/**
 * Chroma key / green-blue screen removal (upstream issue #97).
 *
 * A checkbox arms the key at a default green with sensible tolerance/
 * softness/spill; the three sliders and color swatch only render once
 * armed. Clearing the checkbox drops the field entirely (tolerance 0 is
 * the single deactivation switch shared with the executor and export/
 * preview readers), matching the Edge Rounding block's pattern below.
 */
/**
 * Shape style (tutorial overlays): kind select, stroke color/width, and an
 * optional fill with its own alpha. Mechanical controls only — each writes
 * one field through `applyClipProperties` as one undo step, mirroring the
 * edge/chroma rows above. No canvas manipulation lives here; direct
 * manipulation is a designer-lane follow-up.
 */
function ShapeControls({
  clipId,
  clip,
  controller,
}: {
  clipId: string;
  clip: Clip;
  controller: EditorController;
}) {
  const kind = clip.shapeKind ?? 'rect';
  const strokeWidth = clip.shapeStrokeWidth ?? 0;
  const fill = clip.shapeFillColor ?? null;
  const fillRgb = fill ? fill.slice(0, 7) : '#ffffff';
  const fillAlphaPct = fill
    ? Math.round((parseInt(fill.slice(7, 9), 16) / 255) * 100)
    : 50;

  const setFill = (rgb: string, alphaPct: number): void => {
    const alpha = Math.round((Math.max(0, Math.min(100, alphaPct)) / 100) * 255)
      .toString(16)
      .padStart(2, '0');
    const value = `${rgb}${alpha}`;
    controller.applyClipProperties([clipId], 'Shape fill', (draft) => {
      if (draft.type !== 'shape') return false;
      draft.shapeFillColor = value;
      return true;
    });
  };

  return (
    <div className="flex flex-col gap-2 border-t border-white/10 pt-1">
      <div className="flex flex-col gap-1">
        <label className="text-2xs text-text-muted uppercase tracking-wide">Shape Kind</label>
        <select
          value={kind}
          onChange={(e) => {
            const next = sanitizeShapeKind(e.target.value) ?? 'rect';
            controller.applyClipProperties([clipId], 'Shape kind', (draft) => {
              if (draft.type !== 'shape') return false;
              draft.shapeKind = next;
              draft.label = next.charAt(0).toUpperCase() + next.slice(1);
              return true;
            });
          }}
          className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
        >
          {SHAPE_KINDS.map((mode) => (
            <option key={mode} value={mode}>
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-between gap-2">
        <label className="text-2xs text-text-muted uppercase tracking-wide">Stroke Color</label>
        <input
          type="color"
          value={clip.shapeStrokeColor ?? '#ffffff'}
          onChange={(e) => {
            const value = e.target.value;
            controller.applyClipProperties([clipId], 'Shape stroke', (draft) => {
              if (draft.type !== 'shape') return false;
              draft.shapeStrokeColor = value;
              return true;
            });
          }}
          aria-label="Shape stroke color"
          className="h-6 w-10 cursor-pointer rounded border border-surface-3 bg-surface-2"
        />
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label className="text-2xs text-text-muted uppercase tracking-wide">Stroke Width</label>
          <span className="text-2xs text-text-secondary tabular-nums">{strokeWidth}px</span>
        </div>
        <input
          type="range"
          min={0}
          max={SHAPE_STROKE_WIDTH_MAX}
          value={strokeWidth}
          onChange={(e) => {
            const v = Number(e.target.value);
            controller.applyClipProperties([clipId], 'Shape stroke width', (draft) => {
              if (draft.type !== 'shape') return false;
              if (v > 0) draft.shapeStrokeWidth = v;
              else delete draft.shapeStrokeWidth;
              return true;
            });
          }}
          aria-label="Shape stroke width"
          className="w-full accent-accent"
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={fill !== null}
            onChange={(e) => {
              if (e.target.checked) {
                setFill(clip.shapeStrokeColor ?? '#ffffff', 50);
              } else {
                controller.applyClipProperties([clipId], 'Shape fill', (draft) => {
                  if (draft.type !== 'shape') return false;
                  delete draft.shapeFillColor;
                  return true;
                });
              }
            }}
            className="accent-[var(--color-accent)]"
          />
          <span className="text-2xs text-text-muted uppercase tracking-wide">Fill</span>
        </label>
        {fill !== null && (
          <input
            type="color"
            value={fillRgb}
            onChange={(e) => setFill(e.target.value, fillAlphaPct)}
            aria-label="Shape fill color"
            className="h-6 w-10 cursor-pointer rounded border border-surface-3 bg-surface-2"
          />
        )}
      </div>
      {fill !== null && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <label className="text-2xs text-text-muted uppercase tracking-wide">Fill Opacity</label>
            <span className="text-2xs text-text-secondary tabular-nums">{fillAlphaPct}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={fillAlphaPct}
            onChange={(e) => setFill(fillRgb, Number(e.target.value))}
            aria-label="Shape fill opacity"
            className="w-full accent-accent"
          />
        </div>
      )}
    </div>
  );
}

/**
 * Variable-font axes (upstream issue #50).
 *
 * Mechanical only: four shared GradeSliders writing one axis each through
 * `applyClipProperties` as one undo step. A slider at its default deletes
 * the field (sanitize maps defaults to undefined), so a stored axis is
 * always non-default — which is exactly the bake-routing condition
 * `hasTitleVariations` pins. No fonts ship with the app; the axes apply to
 * whatever variable font the title family resolves to, and any other font
 * ignores them.
 */
function TitleVariationControls({
  clipId,
  clip,
  controller,
}: {
  clipId: string;
  clip: Clip;
  controller: EditorController;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-white/10 pt-1">
      <GradeSlider
        label="Variation weight"
        value={clip.titleVariationWght ?? TITLE_VARIATION_WGHT_DEFAULT}
        min={TITLE_VARIATION_WGHT_MIN}
        max={TITLE_VARIATION_WGHT_MAX}
        step={1}
        format={(value) => `${Math.round(value)}`}
        onChange={(value) => {
          const clean = sanitizeTitleVariationWght(Math.round(value));
          controller.applyClipProperties([clipId], 'Variation weight', (draft) => {
            if (draft.type !== 'title') return false;
            if (clean === undefined) delete draft.titleVariationWght;
            else draft.titleVariationWght = clean;
            return true;
          });
        }}
      />
      <GradeSlider
        label="Variation width"
        value={clip.titleVariationWdth ?? TITLE_VARIATION_WDTH_DEFAULT}
        min={TITLE_VARIATION_WDTH_MIN}
        max={TITLE_VARIATION_WDTH_MAX}
        step={1}
        format={(value) => `${Math.round(value)}%`}
        onChange={(value) => {
          const clean = sanitizeTitleVariationWdth(Math.round(value));
          controller.applyClipProperties([clipId], 'Variation width', (draft) => {
            if (draft.type !== 'title') return false;
            if (clean === undefined) delete draft.titleVariationWdth;
            else draft.titleVariationWdth = clean;
            return true;
          });
        }}
      />
      <GradeSlider
        label="Variation slant"
        value={clip.titleVariationSlnt ?? TITLE_VARIATION_SLNT_DEFAULT}
        min={-90}
        max={90}
        step={1}
        format={(value) => `${Math.round(value)}°`}
        onChange={(value) => {
          const clean = sanitizeTitleVariationSlnt(value);
          controller.applyClipProperties([clipId], 'Variation slant', (draft) => {
            if (draft.type !== 'title') return false;
            if (clean === undefined) delete draft.titleVariationSlnt;
            else draft.titleVariationSlnt = clean;
            return true;
          });
        }}
      />
      <GradeSlider
        label="Variation italic"
        value={clip.titleVariationItal ?? TITLE_VARIATION_ITAL_DEFAULT}
        min={0}
        max={1}
        step={0.05}
        format={(value) => `${Math.round(value * 100)}%`}
        onChange={(value) => {
          const clean = sanitizeTitleVariationItal(value);
          controller.applyClipProperties([clipId], 'Variation italic', (draft) => {
            if (draft.type !== 'title') return false;
            if (clean === undefined) delete draft.titleVariationItal;
            else draft.titleVariationItal = clean;
            return true;
          });
        }}
      />
    </div>
  );
}

function ChromaKeyControls({  clipId,
  chromaKey,
  controller,
}: {
  clipId: string;
  chromaKey: Clip['chromaKey'];
  controller: EditorController;
}) {
  const active = (chromaKey?.tolerance ?? 0) > 0;
  const tolerancePct = Math.round((chromaKey?.tolerance ?? 0) * 100);
  const softnessPct = Math.round((chromaKey?.softness ?? 0.05) * 100);
  const spillPct = Math.round((chromaKey?.spill ?? 0.5) * 100);
  const [eyedropSupported, setEyedropSupported] = useState(false);
  useEffect(() => {
    setEyedropSupported(typeof window !== 'undefined' && 'EyeDropper' in window);
  }, []);

  const update = (fields: { keyColor?: string; tolerance?: number; softness?: number; spill?: number }) => {
    controller.applyClipProperties([clipId], 'Set chroma key', (draft) => {
      const merged = mergeChromaKey(draft.chromaKey, fields);
      if (merged) draft.chromaKey = merged;
      else delete draft.chromaKey;
      return true;
    });
  };

  const pickColor = async () => {
    try {
      const eyeDropper = new (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper();
      const result = await eyeDropper.open();
      if (result?.sRGBHex) update({ keyColor: result.sRGBHex });
    } catch {
      // User cancelled the picker or API unavailable — no state change.
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-white/10 pt-1">
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => {
            if (e.target.checked) {
              update({ keyColor: chromaKey?.keyColor ?? DEFAULT_CHROMA_KEY_COLOR, tolerance: 0.15 });
            } else {
              update({ tolerance: 0 });
            }
          }}
          className="accent-[var(--color-accent)]"
        />
        <span className="text-2xs text-text-muted uppercase tracking-wide">Chroma Key</span>
      </label>
      {active && (
        <div className="flex flex-col gap-2 pl-0.5">
          <div className="flex items-center justify-between gap-2">
            <label className="text-2xs text-text-muted uppercase tracking-wide">Key Color</label>
            <div className="flex items-center gap-1.5">
              <input
                type="color"
                value={chromaKey?.keyColor ?? DEFAULT_CHROMA_KEY_COLOR}
                onChange={(e) => update({ keyColor: e.target.value })}
                aria-label="Chroma key color"
                className="h-6 w-10 cursor-pointer rounded border border-surface-3 bg-surface-2"
              />
              {eyedropSupported && (
                <button
                  type="button"
                  onClick={pickColor}
                  title="Pick color from preview"
                  aria-label="Pick chroma key color from preview"
                  className="flex h-6 w-6 items-center justify-center rounded border border-surface-3 bg-surface-2 text-text-muted transition hover:bg-surface-3 hover:text-text-primary"
                >
                  <Pipette size={12} />
                </button>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-2xs text-text-muted uppercase tracking-wide">Tolerance</label>
              <span className="text-2xs text-text-secondary tabular-nums">{tolerancePct}%</span>
            </div>
            <input
              type="range"
              min={1}
              max={100}
              value={Math.max(1, tolerancePct)}
              onChange={(e) => update({ tolerance: Number(e.target.value) / 100 })}
              aria-label="Chroma key tolerance"
              className="w-full accent-accent"
            />
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-2xs text-text-muted uppercase tracking-wide">Softness</label>
              <span className="text-2xs text-text-secondary tabular-nums">{softnessPct}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={softnessPct}
              onChange={(e) => update({ softness: Number(e.target.value) / 100 })}
              aria-label="Chroma key softness"
              className="w-full accent-accent"
            />
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-2xs text-text-muted uppercase tracking-wide">Spill</label>
              <span className="text-2xs text-text-secondary tabular-nums">{spillPct}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={spillPct}
              onChange={(e) => update({ spill: Number(e.target.value) / 100 })}
              aria-label="Chroma key spill suppression"
              className="w-full accent-accent"
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Three-band EQ (upstream #158): low 100 Hz shelf, mid 1 kHz bell, high
 * 3 kHz shelf, each ±15 dB with 0 as neutral. Preview biquads and the
 * FFmpeg export chain read the same bands, so a boost sounds the same live
 * and delivered. Each change is one undo step and a band returned to 0
 * deletes the field, matching the color grade.
 */
function EqControls({ clipId, clip }: { clipId: string; clip: Clip }) {
  const controller = useTimelineStore((s) => s.controller);
  const current = {
    lowDb: clip.eqLowDb ?? 0,
    midDb: clip.eqMidDb ?? 0,
    highDb: clip.eqHighDb ?? 0,
  };

  const set = (field: 'eqLowDb' | 'eqMidDb' | 'eqHighDb', value: number) => {
    controller.applyClipProperties([clipId], 'Audio EQ', (draft) => {
      if (value === 0) delete draft[field];
      else draft[field] = value;
      return true;
    });
  };

  const reset = () => {
    controller.applyClipProperties([clipId], 'Reset audio EQ', (draft) => {
      delete draft.eqLowDb;
      delete draft.eqMidDb;
      delete draft.eqHighDb;
      return true;
    });
  };

  const modified = current.lowDb !== 0 || current.midDb !== 0 || current.highDb !== 0;
  const db = (value: number) => `${value > 0 ? '+' : ''}${value} dB`;

  return (
    <div className="flex flex-col gap-1.5 border-t border-white/10 pt-1" data-audio-eq>
      <div className="flex items-center justify-between">
        <label className="text-2xs uppercase tracking-wide text-text-muted">EQ</label>
        {modified && (
          <button
            onClick={reset}
            className="text-2xs text-text-muted underline decoration-dotted transition hover:text-text-secondary"
          >
            Reset
          </button>
        )}
      </div>
      {([
        ['Low 100 Hz', current.lowDb, 'eqLowDb'],
        ['Mid 1 kHz', current.midDb, 'eqMidDb'],
        ['High 3 kHz', current.highDb, 'eqHighDb'],
      ] as const).map(([label, value, field]) => (
        <GradeSlider
          key={field}
          label={label}
          value={value}
          min={-15}
          max={15}
          step={0.5}
          format={db}
          onChange={(next) => set(field, next)}
        />
      ))}
    </div>
  );
}

/**
 * Compressor / limiter (upstream #158's remaining audio tool).
 *
 * The checkbox arms a defaulted compressor; ratio 1 is the off switch, so
 * unchecking clears the field the same way the chroma-key checkbox clears
 * its tolerance. All five values are shared with the preview
 * `DynamicsCompressorNode` and the export `acompressor` filter, so what is
 * auditioned is what renders.
 */
function CompressorControls({ clipId, clip }: { clipId: string; clip: Clip }) {
  const controller = useTimelineStore((s) => s.controller);
  const active = hasCompressor(clip);
  const config = normalizeCompressor(clip.compressor);

  const update = (patch: Partial<CompressorConfig>) => {
    controller.applyClipProperties([clipId], 'Compressor', (draft) => {
      const merged = mergeCompressor(draft.compressor, patch);
      if (merged) draft.compressor = merged;
      else delete draft.compressor;
      return true;
    });
  };

  const fields: Array<[string, keyof CompressorConfig, number, number, number, (v: number) => string]> = [
    ['Threshold', 'thresholdDb', COMPRESSOR_LIMITS.thresholdDb.min, COMPRESSOR_LIMITS.thresholdDb.max, 1, (v) => `${v} dB`],
    ['Ratio', 'ratio', COMPRESSOR_LIMITS.ratio.min, COMPRESSOR_LIMITS.ratio.max, 0.5, (v) => `${v}:1`],
    ['Attack', 'attackMs', 1, 500, 1, (v) => `${v} ms`],
    ['Release', 'releaseMs', 10, 2000, 10, (v) => `${v} ms`],
    ['Makeup', 'makeupDb', COMPRESSOR_LIMITS.makeupDb.min, COMPRESSOR_LIMITS.makeupDb.max, 0.5, (v) => `${v > 0 ? '+' : ''}${v} dB`],
  ];

  return (
    <div className="flex flex-col gap-1.5 border-t border-white/10 pt-1" data-compressor>
      <label className="flex cursor-pointer items-center gap-1.5">
        <input
          type="checkbox"
          checked={active}
          onChange={(event) => update(event.target.checked ? DEFAULT_COMPRESSOR : { ratio: 1 })}
          className="accent-[var(--color-accent)]"
        />
        <span className="text-2xs uppercase tracking-wide text-text-muted">Compressor</span>
      </label>
      {active && fields.map(([label, field, min, max, step, format]) => (
        <GradeSlider
          key={field}
          label={label}
          value={config[field]}
          min={min}
          max={max}
          step={step}
          format={format}
          onChange={(value) => update({ [field]: value })}
        />
      ))}
    </div>
  );
}

/**
 * Noise reduction (upstream #165): a checkbox arms the stage at the 60%
 * default and one strength slider scales it. Sliding to 0 (or clearing the
 * checkbox) deletes the field entirely — absent and 0 are both "off" for
 * the shared export/preview readers, so an unarmed clip stays structurally
 * unarmed exactly like the EQ and compressor stages.
 */
function NoiseReductionControls({ clipId, clip }: { clipId: string; clip: Clip }) {
  const controller = useTimelineStore((s) => s.controller);
  const amount = noiseReductionOf(clip);

  const update = (next: number | null) => {
    controller.applyClipProperties([clipId], 'Noise reduction', (draft) => {
      if (next !== null) draft.noiseReduction = next;
      else delete draft.noiseReduction;
      return true;
    });
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-white/10 pt-1" data-noise-reduction>
      <label className="flex cursor-pointer items-center gap-1.5">
        <input
          type="checkbox"
          checked={amount !== null}
          onChange={(event) => update(event.target.checked ? DEFAULT_NOISE_REDUCTION : null)}
          className="accent-[var(--color-accent)]"
        />
        <span className="text-2xs uppercase tracking-wide text-text-muted">Noise Reduction</span>
      </label>
      {amount !== null && (
        <GradeSlider
          label="Strength"
          value={amount}
          min={NOISE_REDUCTION_LIMITS.min}
          max={NOISE_REDUCTION_LIMITS.max}
          step={1}
          format={(value) => `${value}%`}
          onChange={(value) => update(value <= 0 ? null : value)}
        />
      )}
    </div>
  );
}

/**
 * Volume keyframes (upstream #535/#539-#541 audio slice): a dB automation
 * track on audio clips, mirroring MotionControls' chip/add-keyframe pattern
 * for one axis. "Set" captures the clip's current effective level at the
 * playhead as a keyframe; an active track overrides the static volume
 * entirely, so removing the last chip restores static control.
 */
function VolumeKeyframeControls({ clipId }: { clipId: string }) {
  const clip = useTimelineStore((s) => s.getScopeTimeline().clips.find((c) => c.id === clipId));
  const playhead = useTimelineStore((s) => s.getScopeTimeline().playheadFrame);
  const applyClipProperties = useTimelineStore((s) => s.controller.applyClipProperties);

  if (!clip) return null;
  const track = clip.volumeDb;
  const staticDb = linearToDb(clip.volume ?? 1);

  const setTrack = (points: typeof track | undefined) => {
    applyClipProperties([clipId], 'Volume keyframes', (draft) => {
      if (points && points.length > 0) draft.volumeDb = points;
      else delete draft.volumeDb;
      return true;
    });
  };

  const addKeyframe = () => {
    const evaluated = evaluateMotion(track, playhead) ?? (Number.isFinite(staticDb) ? staticDb : 0);
    const others = (track ?? []).filter((p) => p.frame !== playhead);
    const clamped = Math.min(15, Math.max(-60, Math.round(evaluated * 10) / 10));
    setTrack([...others, { frame: playhead, value: clamped }]);
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-white/10 pt-1">
      <div className="flex items-center justify-between">
        <label className="text-2xs uppercase tracking-wide text-text-muted">Volume Keyframes</label>
        <button
          onClick={addKeyframe}
          data-add-keyframe="volumeDb"
          className="rounded border border-surface-4 px-1 py-0.5 text-[9px] text-text-secondary hover:bg-white/10 hover:text-text-primary"
        >
          + Keyframe
        </button>
      </div>
      {track && track.length > 0 ? (
        <div className="rounded border border-surface-3 bg-surface-2 px-2 py-1">
          <div className="flex flex-wrap items-center gap-1">
            {track.map((point) => (
              <button
                key={point.frame}
                title={`Frame ${point.frame}: ${point.value} dB â€” click to remove`}
                onClick={() => setTrack(track.filter((p) => p.frame !== point.frame))}
                className="rounded bg-surface-4/60 px-1 py-0.5 font-mono text-[8px] text-text-secondary hover:bg-red-500/20 hover:text-red-300"
              >
                f{point.frame}:{point.value}dBÃ—
              </button>
            ))}
          </div>
          {track.length >= 2 && (
            <select
              value={track[0].easing ?? 'linear'}
              onChange={(event) =>
                setTrack(track.map((p, index) => ({
                  ...p,
                  ...(index < track.length - 1
                    ? { easing: event.target.value as 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' }
                    : {}),
                })))}
              data-easing="volumeDb"
              aria-label="Volume keyframe easing"
              className="mt-1 w-full rounded border border-surface-3 bg-surface-1 px-1 py-0.5 text-[9px] text-text-secondary focus:border-accent focus:outline-none"
            >
              <option value="linear">Linear</option>
              <option value="easeIn">Ease in</option>
              <option value="easeOut">Ease out</option>
              <option value="easeInOut">Ease in-out</option>
            </select>
          )}
        </div>
      ) : (
        <p className="text-[10px] text-text-muted">
          No keyframes â€” volume follows the clip's static level. Add two or more to animate.
        </p>
      )}
    </div>
  );
}

/**
 * Motion keyframes (keyframes v1): per-axis position tracks. "Set" captures
 * the clip's current position at the playhead as a keyframe (or updates the
 * existing one on that frame); chips list the points with remove buttons.
 * Evaluation/sanitization live in shared/media/motion.ts â€” this UI only
 * collects intent.
 */
function MotionControls({ clipId }: { clipId: string }) {
  const clip = useTimelineStore((s) =>
    s.getScopeTimeline().clips.find((c) => c.id === clipId));
  const playhead = useTimelineStore((s) => s.project.timeline.playheadFrame);
  const applyClipProperties = useTimelineStore((s) => s.controller.applyClipProperties);

  const Hint = ({ children }: { children: React.ReactNode }) => (
    <p className="mt-1 text-[10px] text-text-muted">{children}</p>
  );

  if (!clip) return null;
  type MotionAxis = 'x' | 'y' | 'r' | 'sx' | 'sy';
  type MotionPointWithEasing = { frame: number; value: number; easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' };
  const axes: Array<{ axis: MotionAxis; label: string; track: MotionPointWithEasing[] | undefined; base: number }> = [
    { axis: 'x', label: 'X', track: clip.motionX, base: clip.x },
    { axis: 'y', label: 'Y', track: clip.motionY, base: clip.y },
    { axis: 'r', label: 'Rotation', track: clip.motionRot, base: clip.rotation },
    { axis: 'sx', label: 'Scale X', track: clip.motionScaleX, base: clip.scaleX },
    { axis: 'sy', label: 'Scale Y', track: clip.motionScaleY, base: clip.scaleY },
  ];

  const setAxis = (axis: MotionAxis, points: Array<{ frame: number; value: number }> | undefined) => {
    const motionField = axis === 'x' ? 'motionX' : axis === 'y' ? 'motionY' : axis === 'sx' ? 'motionScaleX' : axis === 'sy' ? 'motionScaleY' : 'motionRot';
    applyClipProperties([clipId], `Motion ${axis.toUpperCase()}`, (draft) => {
      if (points) {
        (draft as any)[motionField] = points;
      } else {
        delete (draft as any)[motionField];
      }
      return true;
    });
  };

  const addKeyframe = (axis: MotionAxis) => {
    const info = axes.find((a) => a.axis === axis)!;
    const evaluated = evaluateMotion(info.track, playhead) ?? info.base;
    const others = (info.track ?? []).filter((p) => p.frame !== playhead);
    const newVal = axis === 'sx' || axis === 'sy' ? parseFloat(evaluated.toFixed(3)) : Math.round(evaluated);
    setAxis(axis, [...others, { frame: playhead, value: newVal }]);
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-white/10 pt-1" data-motion-controls>
      <label className="text-2xs uppercase tracking-wide text-text-muted">Motion</label>
      <Hint>Keyframes interpolate position, rotation, and scale between frames.</Hint>
      {axes.map(({ axis, label, track, base }) => (
        <div key={axis} className="rounded border border-surface-3 bg-surface-2 px-2 py-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-text-secondary">{label}</span>
            <div className="flex items-center gap-1">
              {(track ?? []).map((point) => (
                <button
                  key={point.frame}
                  title={`Frame ${point.frame}: ${point.value}px â€” click to remove`}
                  onClick={() =>
                    setAxis(axis, (track ?? []).filter((p) => p.frame !== point.frame))}
                  className="rounded bg-surface-4/60 px-1 py-0.5 font-mono text-[8px] text-text-secondary hover:bg-red-500/20 hover:text-red-300"
                >
                  f{point.frame}:{Math.round(point.value)}Ã—
                </button>
              ))}
              <button
                onClick={() => addKeyframe(axis)}
                data-add-keyframe={axis}
                className="rounded border border-surface-4 px-1 py-0.5 text-[9px] text-text-secondary hover:bg-white/10 hover:text-text-primary"
              >
                + Keyframe
              </button>
            </div>
          </div>
          {track && track.length >= 2 && (
            <select
              value={track[0].easing ?? 'linear'}
              onChange={(event) =>
                setAxis(axis, (track ?? []).map((p, index) => ({
                  ...p,
                  ...(index < track.length - 1
                    ? { easing: event.target.value as 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' }
                    : {}),
                })))}
              data-easing={axis}
              aria-label={`${label} axis easing`}
              className="mt-1 w-full rounded border border-surface-3 bg-surface-1 px-1 py-0.5 text-[9px] text-text-secondary focus:border-accent focus:outline-none"
            >
              <option value="linear">Linear</option>
              <option value="easeIn">Ease in</option>
              <option value="easeOut">Ease out</option>
              <option value="easeInOut">Ease in-out</option>
            </select>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Opacity keyframes — a sibling of the Motion rows above, same chip /
 * + Keyframe / easing-select pattern, for `Clip.opacityTrack` (the automation
 * track the preview and the media exporter already evaluate).
 *
 * Every edit goes through `controller.setClipOpacityTrack`, the only sanctioned
 * writer, so each one is a single undo step and the controller's refusal of a
 * no-op adds no history. The controller also requires at least two points, so
 * the point arithmetic (seeding the first pair, clearing instead of leaving a
 * lone keyframe, segment easing) lives in `lib/opacity-track` rather than here.
 *
 * Fades are a separate control above and are deliberately not folded in: the
 * two multiply independently.
 */
function OpacityKeyframeControls({ clipId }: { clipId: string }) {
  const clip = useTimelineStore((s) =>
    s.getScopeTimeline().clips.find((c) => c.id === clipId));
  const playhead = useTimelineStore((s) => s.project.timeline.playheadFrame);
  const fps = useTimelineStore((s) => s.project.settings.fps);
  const setClipOpacityTrack = useTimelineStore((s) => s.controller.setClipOpacityTrack);

  if (!clip) return null;

  const track = clip.opacityTrack;
  const animated = hasOpacityTrack(track);

  // undefined means "clear the track", which the controller takes as [].
  const submit = (points: ReturnType<typeof nextOpacityTrack> | undefined) => {
    setClipOpacityTrack(clipId, points ?? []);
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-white/10 pt-1" data-opacity-keyframes>
      <div className="flex items-center justify-between">
        <label className="text-2xs uppercase tracking-wide text-text-muted">Opacity Keyframes</label>
        {animated && (
          <button
            onClick={() => submit(undefined)}
            data-reset-opacity-track
            className="text-2xs text-text-muted underline decoration-dotted transition hover:text-text-secondary"
          >
            Reset
          </button>
        )}
      </div>
      <div className="rounded border border-surface-3 bg-surface-2 px-2 py-1">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <div className="flex flex-wrap items-center gap-1">
            {(track ?? []).map((point) => (
              <button
                key={point.frame}
                title={`Frame ${point.frame}: ${opacityPercent(point.value)}% — click to remove`}
                onClick={() => submit(removeOpacityKeyframe(track, point.frame))}
                data-opacity-keyframe={point.frame}
                className="rounded bg-surface-4/60 px-1 py-0.5 font-mono text-[8px] text-text-secondary hover:bg-red-500/20 hover:text-red-300"
              >
                f{point.frame}:{opacityPercent(point.value)}%
              </button>
            ))}
          </div>
          <button
            onClick={() => submit(nextOpacityTrack(track, playhead, clip.opacity, fps))}
            data-add-keyframe="opacity"
            className="rounded border border-surface-4 px-1 py-0.5 text-[9px] text-text-secondary hover:bg-white/10 hover:text-text-primary"
          >
            + Keyframe
          </button>
        </div>
        {track && track.length >= 2 && (
          <select
            value={track[0].easing ?? 'linear'}
            onChange={(event) =>
              submit(withOpacityEasing(track, event.target.value as MotionEasing))}
            data-easing="opacity"
            aria-label="Opacity keyframe easing"
            className="mt-1 w-full rounded border border-surface-3 bg-surface-1 px-1 py-0.5 text-[9px] text-text-secondary focus:border-accent focus:outline-none"
          >
            <option value="linear">Linear</option>
            <option value="easeIn">Ease in</option>
            <option value="easeOut">Ease out</option>
            <option value="easeInOut">Ease in-out</option>
          </select>
        )}
      </div>
      {!animated && (
        <p className="text-[10px] text-text-muted">
          No keyframes — opacity follows the clip's static value. Add two or more to animate.
        </p>
      )}
    </div>
  );
}

/**
 * Silence removal, with its settings exposed (upstream PR #426).
 *
 * Before this the button ran with hardcoded values, so a pass that cut too much
 * or too little could not be adjusted â€” the only recourse was undo. The two
 * duration controls mirror upstream's Minimum Pause and Speech Padding, in
 * milliseconds. Threshold has no upstream counterpart: upstream decides silence
 * from an on-device speech mask, while this port measures an RMS envelope, which
 * makes the level itself a real user-facing decision.
 *
 * Ranges come from `SILENCE_LIMITS`, the same bounds the main process and the
 * Agent tool schema use, so the slider cannot express a value a removal would
 * refuse. Values are saved by the main process, not here, so a removal the Agent
 * runs with no arguments uses exactly what these controls show.
 */
function SilenceRemovalControls({
  onRemove,
  working,
  status,
}: {
  onRemove: () => void;
  working: boolean;
  status: string | null;
}) {
  const { settings, update, reset, isModified } = useSilenceSettings();
  const showSilenceSpans = useMediaPanelStore((state) => state.showSilenceSpans);
  const toggleSilenceSpans = useMediaPanelStore((state) => state.toggleSilenceSpans);

  return (
    <div className="flex flex-col gap-1.5 border-t border-white/10 pt-1">
      <div className="flex items-center justify-between pt-1">
        <label className="text-2xs text-text-muted uppercase tracking-wide">Audio</label>
        {isModified && (
          <button
            onClick={reset}
            className="text-2xs text-text-muted underline decoration-dotted transition hover:text-text-secondary"
          >
            Reset
          </button>
        )}
      </div>

      <SilenceSlider
        id="silence-minimum-pause"
        label="Minimum Pause"
        title="Silent gaps shorter than this are left alone."
        value={settings?.minSilenceSec ?? DEFAULT_SILENCE_CONFIG.minSilenceSec}
        min={SILENCE_LIMITS.minSilenceSec.min}
        max={SILENCE_LIMITS.minSilenceSec.max}
        step={0.05}
        disabled={settings === null || working}
        format={formatMilliseconds}
        onChange={(minSilenceSec) => update({ minSilenceSec })}
      />
      <SilenceSlider
        id="silence-speech-padding"
        label="Speech Padding"
        title="Audio kept either side of speech, so a transient is not clipped. Not applied where the silence reaches the start or end of the source."
        value={settings?.edgePaddingSec ?? DEFAULT_SILENCE_CONFIG.edgePaddingSec}
        min={SILENCE_LIMITS.edgePaddingSec.min}
        max={SILENCE_LIMITS.edgePaddingSec.max}
        step={0.025}
        disabled={settings === null || working}
        format={formatMilliseconds}
        onChange={(edgePaddingSec) => update({ edgePaddingSec })}
      />
      <SilenceSlider
        id="silence-threshold"
        label="Threshold"
        title="Audio quieter than this counts as silence. Lower values cut only near-digital silence."
        value={settings?.thresholdDb ?? DEFAULT_SILENCE_CONFIG.thresholdDb}
        min={SILENCE_LIMITS.thresholdDb.min}
        max={SILENCE_LIMITS.thresholdDb.max}
        step={1}
        disabled={settings === null || working}
        format={(value) => `${Math.round(value)} dB`}
        onChange={(thresholdDb) => update({ thresholdDb })}
      />

      <button
        onClick={onRemove}
        disabled={working}
        className="mt-0.5 rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs text-text-primary transition hover:border-surface-4 hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {working ? 'Analyzingâ€¦' : 'Remove Silence'}
      </button>
      <label
        className="flex cursor-pointer items-center gap-1.5 text-2xs text-text-secondary"
        title="Shade the silent spans on audio clips; click a shaded span to remove just that gap."
      >
        <input
          type="checkbox"
          checked={showSilenceSpans}
          onChange={(event) => toggleSilenceSpans(event.target.checked)}
          className="accent-[var(--color-accent)]"
        />
        Mark silent spans on the timeline
      </label>
      {status && (
        <span className="text-2xs text-text-muted" role="status">
          {status}
        </span>
      )}
    </div>
  );
}

/** Milliseconds read better than fractional seconds at these magnitudes. */
function formatMilliseconds(seconds: number): string {
  return `${Math.round(seconds * 1000)} ms`;
}

/**
 * One bounded silence control: label, live value, and a range input.
 *
 * A range input rather than a free-text number field, because `min`/`max`/`step`
 * make an out-of-range value unreachable rather than something to reject after
 * the fact. The readout carries the units so the label stays short enough for
 * the panel at its narrowest.
 */
function SilenceSlider({
  id,
  label,
  title,
  value,
  min,
  max,
  step,
  disabled,
  format,
  onChange,
}: {
  id: string;
  label: string;
  title: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="truncate text-2xs text-text-muted" title={title}>
          {label}
        </label>
        <span className="text-2xs tabular-nums text-text-secondary">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        title={title}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-accent disabled:opacity-40"
      />
    </div>
  );
}

/**
 * Bulk editor for a multi-clip selection.
 *
 * Every control writes the whole selection through the controller's batched
 * property path, so restyling a selection is one undo step. Controls show the
 * shared value when the selection agrees and "Mixed" when it does not, matching
 * upstream's multi-select behaviour rather than pretending one clip is authoritative.
 */
function MultiClipInspector() {
  const getSelectedClips = useTimelineStore((s) => s.getSelectedClips);
  const setSelectedClipsBlendMode = useTimelineStore((s) => s.setSelectedClipsBlendMode);
  const setSelectedClipsOpacity = useTimelineStore((s) => s.setSelectedClipsOpacity);
  const setSelectedClipsFade = useTimelineStore((s) => s.setSelectedClipsFade);
  const controller = useTimelineStore((s) => s.controller);
  const fps = useTimelineStore((s) => s.project.settings.fps);

  const clips = getSelectedClips();
  const visualClips = clips.filter((item) => item.type !== 'audio');
  const userPresets = useGradePresetsStore((state) => state.presets);
  const sharedBlendMode = sharedValue(visualClips.map((item) => item.blendMode ?? 'normal'));
  const sharedOpacity = sharedValue(visualClips.map((item) => item.opacity));
  const sharedFadeIn = sharedValue(clips.map((item) => item.fadeInFrames ?? 0));
  const sharedFadeOut = sharedValue(clips.map((item) => item.fadeOutFrames ?? 0));

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="panel-header flex items-center justify-between px-3">
        <h2 className="text-[11px] font-medium text-text-secondary">Inspector</h2>
        <span className="text-[10px] text-text-muted">{clips.length} clips</span>
      </div>

      <div className="space-y-3 px-3 py-3">
        <p className="text-2xs text-text-muted">
          Changes apply to all {clips.length} selected clips as one undoable edit.
        </p>

        {visualClips.length > 0 && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-2xs text-text-muted uppercase tracking-wide">Blend Mode</label>
              <select
                value={sharedBlendMode ?? 'mixed'}
                onChange={(e) => {
                  if (e.target.value !== 'mixed') {
                    setSelectedClipsBlendMode(e.target.value as BlendMode);
                  }
                }}
                className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
              >
                {sharedBlendMode === undefined && (
                  <option value="mixed">Mixed</option>
                )}
                {BLEND_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {BLEND_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label className="text-2xs text-text-muted uppercase tracking-wide">Opacity</label>
                <span className="text-2xs text-text-secondary tabular-nums">
                  {sharedOpacity === undefined ? 'Mixed' : `${Math.round(sharedOpacity * 100)}%`}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={sharedOpacity === undefined ? 100 : Math.round(sharedOpacity * 100)}
                onChange={(e) => setSelectedClipsOpacity(parseInt(e.target.value, 10) / 100)}
                aria-label="Opacity for the selected clips"
                className="w-full accent-accent"
              />
            </div>

            {/* Grade a whole selection with one named look (upstream #157).
                A shot-carrying row reframes every selected clip as well as
                recoloring it — the option text says so. */}
            {visualClips.length > 0 && visualClips.every((clip) => supportsMediaAdjustmentControls(clip.type)) && (
              <div className="flex flex-col gap-1">
                <label className="text-2xs text-text-muted uppercase tracking-wide">Grade Preset</label>
                <select
                  value=""
                  onChange={(event) => {
                    const preset = [...GRADE_PRESETS, ...userPresets]
                      .find((candidate) => candidate.id === event.target.value);
                    if (preset) {
                      // Saved presets link the whole selection in the same one
                      // undo step; a built-in clears the link (see
                      // ColorGradeControls.applyPreset). The selection is
                      // already explicit, so the opt-in propagation boxes live
                      // in the single-clip block only.
                      const isUserPreset = userPresets.some((candidate) => candidate.id === preset.id);
                      applyGradePresetTo(controller, visualClips.map((item) => item.id), preset, isUserPreset);
                    }
                  }}
                  aria-label="Apply grade preset to the selected clips"
                  data-grade-preset-multi
                  className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
                >
                  <option value="" disabled>
                    Apply to all {visualClips.length} clips…
                  </option>
                  <optgroup label="Built-in">
                    {GRADE_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </optgroup>
                  {userPresets.length > 0 && (
                    <optgroup label="My presets">
                      {userPresets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {presetOptionLabel(preset)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
            )}
          </>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-2xs text-text-muted uppercase tracking-wide">Fades (seconds)</label>
          <div className="flex gap-2">
            <div className="flex flex-1 flex-col gap-0.5">
              <span className="text-2xs text-text-muted">In{sharedFadeIn === undefined ? ' (mixed)' : ''}</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={sharedFadeIn === undefined ? '' : (sharedFadeIn / fps).toFixed(1)}
                onChange={(e) =>
                  setSelectedClipsFade(Math.round(parseFloat(e.target.value || '0') * fps), undefined)
                }
                aria-label="Fade in seconds for the selected clips"
                className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
              />
            </div>
            <div className="flex flex-1 flex-col gap-0.5">
              <span className="text-2xs text-text-muted">Out{sharedFadeOut === undefined ? ' (mixed)' : ''}</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={sharedFadeOut === undefined ? '' : (sharedFadeOut / fps).toFixed(1)}
                onChange={(e) =>
                  setSelectedClipsFade(undefined, Math.round(parseFloat(e.target.value || '0') * fps))
                }
                aria-label="Fade out seconds for the selected clips"
                className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
              />
            </div>
          </div>
        </div>

        {visualClips.length > 0 && (
          <div className="flex flex-col gap-1">
            <label className="text-2xs text-text-muted uppercase tracking-wide">Label Color</label>
            <div className="flex flex-wrap gap-1">
              {CLIP_LABEL_COLORS.map(({ color, label }) => (
                <button
                  key={label}
                  title={label}
                  onClick={() => {
                    controller.applyClipProperties(
                      visualClips.map((c) => c.id),
                      'Set clip color',
                      (draft) => {
                        if (color) draft.color = color;
                        else delete draft.color;
                        return true;
                      },
                    );
                  }}
                  className="h-5 w-5 rounded-full border-2 border-transparent transition hover:border-white/40"
                  style={{
                    backgroundColor: color || '#1e1e2e',
                    ...(color ? {} : {
                      backgroundImage: 'linear-gradient(45deg, #333 25%, transparent 25%, transparent 75%, #333 75%), linear-gradient(45deg, #333 25%, transparent 25%, transparent 75%, #333 75%)',
                      backgroundSize: '6px 6px',
                      backgroundPosition: '0 0, 3px 3px',
                    }),
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {visualClips.length === 0 && (
          <p className="text-2xs text-text-muted">
            Audio only â€” compositing properties don't apply.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Editable project settings: resolution, frame rate and aspect ratio
 * (upstream PR #417).
 *
 * Aspect ratio offers the preset ratios plus a custom `width:height` entry that
 * preserves the current short edge. Quality scales the short edge while keeping
 * the ratio. Every change is one undoable edit and re-fits existing clips, so
 * preview and export follow the new canvas.
 */
function ProjectSettingsSection() {
  const settings = useTimelineStore((s) => s.project.settings);
  const applyProjectSettings = useTimelineStore((s) => s.applyProjectSettings);
  const [customOpen, setCustomOpen] = useState(false);

  const { width, height, fps } = settings;

  const handleAspectPreset = useCallback(
    (id: string) => {
      if (id === 'custom') {
        setCustomOpen(true);
        return;
      }
      const preset = findAspectPreset(id);
      if (preset) applyProjectSettings({ width: preset.width, height: preset.height });
    },
    [applyProjectSettings],
  );

  const handleQualityPreset = useCallback(
    (id: string) => {
      const quality = findQualityPreset(id);
      if (!quality) return;
      applyProjectSettings(resolutionForQuality(quality, { width, height }));
    },
    [applyProjectSettings, width, height],
  );

  const currentAspectPreset = ASPECT_PRESETS.find((preset) =>
    aspectPresetMatches(preset, width, height),
  );
  const currentQualityPreset = QUALITY_PRESETS.find((preset) =>
    qualityPresetMatches(preset, { width, height }),
  );

  return (
    <>
      <InspectorSection title="Settings">
        <div className="flex items-center gap-3 text-[10px]">
          <label htmlFor="project-quality" className="text-text-muted">
            Resolution
          </label>
          <span className="ml-auto flex items-center gap-2">
            <span className="text-text-secondary tabular-nums">
              {width} x {height}
            </span>
            <select
              id="project-quality"
              value={currentQualityPreset?.id ?? 'custom'}
              onChange={(e) => handleQualityPreset(e.target.value)}
              className="rounded border border-surface-3 bg-surface-2 px-1 py-0.5 text-[10px] text-text-primary focus:border-accent focus:outline-none"
            >
              {!currentQualityPreset && <option value="custom">Custom</option>}
              {QUALITY_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </span>
        </div>

        <div className="flex items-center gap-3 text-[10px]">
          <label htmlFor="project-fps" className="text-text-muted">
            Frame Rate
          </label>
          <select
            id="project-fps"
            value={String(fps)}
            onChange={(e) => applyProjectSettings({ fps: Number(e.target.value) })}
            className="ml-auto rounded border border-surface-3 bg-surface-2 px-1 py-0.5 text-[10px] text-text-primary focus:border-accent focus:outline-none"
          >
            {FPS_OPTIONS.includes(fps) ? null : <option value={String(fps)}>{fps} fps</option>}
            {FPS_OPTIONS.map((option) => (
              <option key={option} value={String(option)}>
                {option} fps
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3 text-[10px]">
          <label htmlFor="project-aspect" className="text-text-muted">
            Aspect Ratio
          </label>
          <span className="ml-auto flex items-center gap-2">
            <span className="text-text-secondary tabular-nums">
              {aspectRatioLabel(width, height)}
            </span>
            <select
              id="project-aspect"
              value={currentAspectPreset?.id ?? 'current'}
              onChange={(e) => handleAspectPreset(e.target.value)}
              className="rounded border border-surface-3 bg-surface-2 px-1 py-0.5 text-[10px] text-text-primary focus:border-accent focus:outline-none"
            >
              {!currentAspectPreset && <option value="current">Custom</option>}
              {ASPECT_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">Customâ€¦</option>
            </select>
          </span>
        </div>
      </InspectorSection>

      {customOpen && (
        <CustomAspectRatioEditor
          width={width}
          height={height}
          onClose={() => setCustomOpen(false)}
        />
      )}
    </>
  );
}

const FPS_OPTIONS = [24, 25, 30, 48, 50, 60];

/**
 * Custom `width:height` entry. Shows the resolution the ratio resolves to, or
 * the refusal reason, and only enables Apply for a valid edited ratio â€” the same
 * gating as upstream's CustomAspectRatioSheet.
 */
function CustomAspectRatioEditor({
  width,
  height,
  onClose,
}: {
  width: number;
  height: number;
  onClose: () => void;
}) {
  const applyProjectSettings = useTimelineStore((s) => s.applyProjectSettings);
  const context = { width, height };
  const initial = customRatioInput(context);
  const [horizontal, setHorizontal] = useState(initial.horizontal);
  const [vertical, setVertical] = useState(initial.vertical);

  const changed = horizontal !== initial.horizontal || vertical !== initial.vertical;
  let resolution: { width: number; height: number } | null = null;
  let message: string | null = null;
  try {
    resolution = customRatioResolution(context, horizontal, vertical);
  } catch (err) {
    message = err instanceof Error ? err.message : 'Enter a valid aspect ratio.';
  }

  return (
    <section className="border-b border-white/10 px-3 py-3">
      <h3 className="mb-1 text-[10px] font-semibold text-text-primary">Custom Aspect Ratio</h3>
      <p className="mb-2 text-2xs text-text-muted">Changing the ratio preserves the shorter edge.</p>
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-0.5">
          <label htmlFor="aspect-horizontal" className="text-2xs text-text-muted">
            Width
          </label>
          <input
            id="aspect-horizontal"
            value={horizontal}
            onChange={(e) => setHorizontal(e.target.value)}
            inputMode="decimal"
            className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs tabular-nums text-text-primary focus:border-accent focus:outline-none"
          />
        </div>
        <span className="pb-1.5 text-xs text-text-muted">:</span>
        <div className="flex flex-1 flex-col gap-0.5">
          <label htmlFor="aspect-vertical" className="text-2xs text-text-muted">
            Height
          </label>
          <input
            id="aspect-vertical"
            value={vertical}
            onChange={(e) => setVertical(e.target.value)}
            inputMode="decimal"
            className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs tabular-nums text-text-primary focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      <p
        className={`mt-2 text-2xs ${message ? 'text-red-400' : 'text-text-muted'}`}
        role={message ? 'alert' : undefined}
      >
        {message ?? `Resolution ${resolution!.width} x ${resolution!.height}`}
      </p>

      <div className="mt-2 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded border border-surface-3 bg-surface-2 px-2 py-1 text-2xs text-text-primary transition hover:bg-surface-3"
        >
          Cancel
        </button>
        <button
          disabled={!resolution || !changed}
          onClick={() => {
            if (!resolution) return;
            applyProjectSettings(resolution);
            onClose();
          }}
          className="rounded border border-accent bg-accent/20 px-2 py-1 text-2xs text-text-primary transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Apply
        </button>
      </div>
    </section>
  );
}

/** The one value every entry shares, or undefined when they differ. */
function sharedValue<T>(values: T[]): T | undefined {
  if (values.length === 0) return undefined;
  const [first] = values;
  return values.every((value) => value === first) ? first : undefined;
}

function InspectorSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-white/10 px-3 py-3">
      <h3 className="mb-2 text-[10px] font-semibold text-text-primary">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}


/**
 * Color label picker — assigns a visual tag color to clips for timeline organization.
 * Uses the existing clip.color field (hex string).
 */
const CLIP_LABEL_COLORS = [
  { color: '', label: 'None' },
  { color: '#ef4444', label: 'Red' },
  { color: '#f97316', label: 'Orange' },
  { color: '#eab308', label: 'Yellow' },
  { color: '#22c55e', label: 'Green' },
  { color: '#06b6d4', label: 'Cyan' },
  { color: '#3b82f6', label: 'Blue' },
  { color: '#8b5cf6', label: 'Purple' },
  { color: '#ec4899', label: 'Pink' },
  { color: '#78716c', label: 'Gray' },
];

function ColorLabelPicker({ clipId, currentColor }: { clipId: string; currentColor?: string }) {
  const controller = useTimelineStore((s) => s.controller);

  const handleColorChange = (color: string) => {
    controller.applyClipProperties([clipId], 'Set clip color', (draft) => {
      if (color) draft.color = color;
      else delete draft.color;
      return true;
    });
  };

  return (
    <div className="flex flex-col gap-1 border-t border-white/10 pt-1">
      <label className="text-2xs text-text-muted uppercase tracking-wide">Label</label>
      <div className="flex flex-wrap gap-1">
        {CLIP_LABEL_COLORS.map(({ color, label }) => (
          <button
            key={label}
            title={label}
            onClick={() => handleColorChange(color)}
            className={`h-5 w-5 rounded-full border-2 transition ${
              (currentColor ?? '') === color
                ? 'border-white scale-110'
                : 'border-transparent hover:border-white/40'
            }`}
            style={{
              backgroundColor: color || '#1e1e2e',
              ...(color ? {} : {
                backgroundImage: 'linear-gradient(45deg, #333 25%, transparent 25%, transparent 75%, #333 75%), linear-gradient(45deg, #333 25%, transparent 25%, transparent 75%, #333 75%)',
                backgroundSize: '6px 6px',
                backgroundPosition: '0 0, 3px 3px',
              }),
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * AI description for the clip's asset (#118 AI half).
 * Explicit Describe only (button or `describe_media` tool) — never
 * automatic. Shows the stored sentence when present, otherwise the
 * provider/model that will be billed before submission (mirroring the
 * Generated row's `provider / model` wording), with progress, failure,
 * and retry states on the button itself.
 */
function AssetDescription({ clipId }: { clipId: string }) {
  const asset = useTimelineStore((s) => {
    const clip = s.getScopeTimeline().clips.find((c) => c.id === clipId);
    if (!clip) return undefined;
    return s.project.media.find((m) => m.id === clip.assetId);
  });
  const controller = useTimelineStore((s) => s.controller);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [visionLabel, setVisionLabel] = useState('');

  useEffect(() => {
    if (visionLabel || asset?.type === 'audio') return;
    void window.palmier.ai.getProviders().then((res) => {
      const list = res as Array<{ name?: string; hasKey?: boolean; model?: string }> | undefined;
      const usable = Array.isArray(list) ? list.find((p) => p.hasKey && p.model) : undefined;
      if (usable?.name && usable?.model) setVisionLabel(`${usable.name} / ${usable.model}`);
    }).catch(() => {});
  }, [visionLabel, asset?.type]);

  if (!asset || asset.type === 'audio') return null;
  const description = asset.aiDescription ?? '';

  async function handleDescribe() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await window.palmier.media.describe({
        assetId: asset!.id,
        assetPath: asset!.path,
        assetType: asset!.type,
        ...(asset!.thumbnailPath ? { thumbnailPath: asset!.thumbnailPath } : {}),
        ...(typeof asset!.width === 'number' ? { assetWidth: asset!.width } : {}),
        ...(typeof asset!.height === 'number' ? { assetHeight: asset!.height } : {}),
      }) as { success: boolean; description?: string; provider?: string; model?: string; error?: string };
      if (!res.success || typeof res.description !== 'string') {
        setError(res.error ?? 'Description failed.');
        return;
      }
      controller.setAssetDescription(asset!.id, res.description);
      useProjectStore.getState().markDirty();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 border-t border-white/10 pt-1">
      <label className="text-2xs text-text-muted uppercase tracking-wide">Description</label>
      {description ? (
        <p className="text-[10px] leading-4 text-text-secondary" title={description}>
          {description}
        </p>
      ) : (
        <p className="text-[10px] text-text-muted">
          No description — {visionLabel ? `uses ${visionLabel}, billed to your key.` : 'uses your AI provider, billed to your key.'}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleDescribe()}
          disabled={busy}
          title={
            visionLabel
              ? `Describe with ${visionLabel} — billed to your key (one vision request)`
              : 'Describe with your AI provider — billed to your key (one vision request)'
          }
          className="rounded border border-white/15 px-2 py-0.5 text-[10px] text-text-secondary hover:bg-white/10 disabled:opacity-60"
        >
          {busy ? 'Describing…' : error ? 'Retry description' : description ? 'Refresh description' : 'Describe (AI)'}
        </button>
        {visionLabel && !description && (
          <span className="text-[10px] tabular-nums text-text-muted">{visionLabel}</span>
        )}
      </div>
      {error && (
        <p role="alert" className="text-[10px] text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Generation provenance display (upstream PR #570).
 * Shows provider, model, cost, and the reference image the run was
 * conditioned on, when the clip was AI-generated.
 */
export function GenerationInfo({ clipId }: { clipId: string }) {
  const asset = useTimelineStore((s) => {
    const clip = s.getScopeTimeline().clips.find((c) => c.id === clipId);
    if (!clip) return undefined;
    return s.project.media.find((m) => m.id === clip.assetId);
  });

  if (!asset?.generatedBy) return null;

  const { provider, model, costCredits } = asset.generatedBy;
  // Provenance stores the local path the generation read; the row shows the
  // file name and keeps the full path in the tooltip, as other paths do here.
  const reference = asset.generatedBy.referenceImagePath?.trim() ?? '';
  const referenceName = reference ? reference.split(/[\\/]/).pop() : '';

  return (
    <div className="flex flex-col gap-1 border-t border-white/10 pt-1">
      <label className="text-2xs text-text-muted uppercase tracking-wide">Generated</label>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
        <span className="text-text-secondary">
          {provider} / {model}
        </span>
        {typeof costCredits === "number" && (
          <span className="text-text-muted tabular-nums">
            {costCredits} cr
          </span>
        )}
        {referenceName && (
          <span className="max-w-[190px] truncate text-text-muted" title={reference}>
            ref {referenceName}
          </span>
        )}
      </div>
    </div>
  );
}
function InspectorValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 text-[10px]">
      <span className="text-text-muted">{label}</span>
      <span className="ml-auto max-w-[190px] truncate text-right text-text-secondary">
        {value}
      </span>
    </div>
  );
}



