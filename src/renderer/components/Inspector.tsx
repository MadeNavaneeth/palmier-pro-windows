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
import { useTimelineStore } from '../store/timeline';
import { useProjectStore } from '../store/project';
import { BLEND_MODES, BLEND_MODE_LABELS, type BlendMode } from '../../shared/types/blend-mode';
import { DEFAULT_SILENCE_CONFIG, SILENCE_LIMITS } from '../../shared/audio/silence-detector';
import { useSilenceSettings } from '../hooks/useSilenceSettings';
import { useMediaPanelStore } from '../store/media-panel';
import { evaluateMotion } from '../../shared/media/motion';
import { mergeChromaKey, DEFAULT_CHROMA_KEY_COLOR } from '../../shared/editor/chroma-key';
import {
  COLOR_GRADE_LIMITS,
  DEFAULT_COLOR_GRADE,
  GRADE_PRESETS,
  GRADE_PRESET_NAME_MAX,
  sanitizeColorGrade,
  type ColorGrade,
  type GradePreset,
} from '../../shared/editor/color-grade';
import { useGradePresetsStore } from '../store/grade-presets';
import {
  COMPRESSOR_LIMITS,
  DEFAULT_COMPRESSOR,
  hasCompressor,
  mergeCompressor,
  normalizeCompressor,
  type CompressorConfig,
} from '../../shared/audio/compressor';
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
    setSilenceStatus('Analyzing audioâ€¦');
    const result = await removeSilenceForClip(clip.id);
    setWorking(false);
    if (result.error) {
      setSilenceStatus(result.error);
    } else if (result.removed === 0) {
      setSilenceStatus('No silence found.');
    } else {
      setSilenceStatus(`Removed ${result.removed} silent gap${result.removed === 1 ? '' : 's'}.`);
    }
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

            {/* Invert Colors (upstream PR #408) */}
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

        {isAudio && (
          <>
            <p className="text-2xs text-text-muted">
              Audio clip — compositing properties don't apply.
            </p>
            <EqControls clipId={clip.id} clip={clip} />
            <CompressorControls clipId={clip.id} clip={clip} />
            <VolumeKeyframeControls clipId={clip.id} />
          </>
        )}

        {(clip.type === 'video' || clip.type === 'image') && (
          <MotionControls clipId={clip.id} />
        )}

        {/* Audio tools â€” available for audio and video clips (both can carry sound). */}
        {clip.type !== 'image' && clip.type !== 'title' && (
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
 * Write a preset's whole grade onto one or more clips in one undo step.
 * Fields the preset does not define are cleared, which is what makes the
 * built-in "Neutral" a real reset rather than a no-op.
 */
function applyGradePresetTo(
  controller: EditorController,
  clipIds: string[],
  preset: GradePreset,
): void {
  const grade = sanitizeColorGrade(preset.grade);
  controller.applyClipProperties(clipIds, `Grade: ${preset.label}`, (draft) => {
    for (const field of Object.keys(COLOR_GRADE_LIMITS) as Array<keyof typeof COLOR_GRADE_LIMITS>) {
      if (grade[field] === undefined) delete draft[field];
      else draft[field] = grade[field];
    }
    return true;
  });
}

/**
 * Color grade + named presets (upstream #157).
 *
 * The grade fields (brightness/contrast/saturation/hue) were rendered by both
 * preview and export since R4 but had no way to be set from the UI — only the
 * model knew them. Each slider writes one field through `applyClipProperties`
 * as one undo step and removes the field at its default, so a neutral clip
 * still reads as ungraded everywhere (`hasColorGrade`). Presets apply the
 * whole grade at once; the built-in list and the user's own saved looks share
 * one picker, and a saved look can be deleted from the same row.
 */
function ColorGradeControls({
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

  const current: ColorGrade = {
    brightness: clip.brightness ?? DEFAULT_COLOR_GRADE.brightness,
    contrast: clip.contrast ?? DEFAULT_COLOR_GRADE.contrast,
    saturation: clip.saturation ?? DEFAULT_COLOR_GRADE.saturation,
    hueRotation: clip.hueRotation ?? DEFAULT_COLOR_GRADE.hueRotation,
  };
  const graded =
    clip.brightness !== undefined
    || clip.contrast !== undefined
    || clip.saturation !== undefined
    || clip.hueRotation !== undefined;

  const setField = (field: keyof typeof COLOR_GRADE_LIMITS, value: number) => {
    const sanitized = sanitizeColorGrade({ [field]: value });
    if (sanitized[field] === undefined) return;
    controller.applyClipProperties([clipId], 'Color grade', (draft) => {
      if (sanitized[field] === DEFAULT_COLOR_GRADE[field]) delete draft[field];
      else draft[field] = sanitized[field];
      return true;
    });
  };

  const applyPreset = (preset: GradePreset) => {
    applyGradePresetTo(controller, [clipId], preset);
    setLastPresetId(preset.id);
  };

  const lastUserPreset = lastPresetId
    ? userPresets.find((preset) => preset.id === lastPresetId) ?? null
    : null;

  const commitSave = () => {
    const stored = saveUserPreset(presetName, { ...current });
    if (!stored) {
      setSaveError(`Enter a name (max ${GRADE_PRESET_NAME_MAX} characters).`);
      return;
    }
    setLastPresetId(stored.id);
    setSaving(false);
    setPresetName('');
    setSaveError('');
  };

  const reset = () => {
    controller.applyClipProperties([clipId], 'Reset color grade', (draft) => {
      delete draft.brightness;
      delete draft.contrast;
      delete draft.saturation;
      delete draft.hueRotation;
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
                {preset.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            setSaving((value) => !value);
            setSaveError('');
          }}
          data-grade-preset-save
          className="rounded border border-surface-4 px-1.5 py-0.5 text-[9px] text-text-secondary hover:bg-white/10 hover:text-text-primary"
        >
          Save current as preset…
        </button>
        {lastUserPreset && (
          <button
            type="button"
            onClick={() => {
              removeUserPreset(lastUserPreset.id);
              setLastPresetId(null);
            }}
            data-grade-preset-delete
            className="rounded px-1.5 py-0.5 text-[9px] text-red-400 hover:bg-red-500/10"
          >
            Delete “{lastUserPreset.label}”
          </button>
        )}
      </div>
      {saving && (
        <div className="flex items-center gap-1.5">
          <input
            value={presetName}
            onChange={(event) => setPresetName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitSave();
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
function ChromaKeyControls({
  clipId,
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
 * Volume keyframes (upstream #535/#539-#541 audio slice): a dB automation
 * track on audio clips, mirroring MotionControls' chip/add-keyframe pattern
 * for one axis. "Set" captures the clip's current effective level at the
 * playhead as a keyframe; an active track overrides the static volume
 * entirely, so removing the last chip restores static control.
 */
function VolumeKeyframeControls({ clipId }: { clipId: string }) {
  const clip = useTimelineStore((s) => s.project.timeline.clips.find((c) => c.id === clipId));
  const playhead = useTimelineStore((s) => s.project.timeline.playheadFrame);
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
    s.project.timeline.clips.find((c) => c.id === clipId));
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

            {/* Grade a whole selection with one named look (upstream #157). */}
            <div className="flex flex-col gap-1">
              <label className="text-2xs text-text-muted uppercase tracking-wide">Grade Preset</label>
              <select
                value=""
                onChange={(event) => {
                  const preset = [...GRADE_PRESETS, ...userPresets]
                    .find((candidate) => candidate.id === event.target.value);
                  if (preset) {
                    applyGradePresetTo(controller, visualClips.map((item) => item.id), preset);
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
                        {preset.label}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
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
 * Generation provenance display (upstream PR #570).
 * Shows provider, model, and cost when the clip was AI-generated.
 */
function GenerationInfo({ clipId }: { clipId: string }) {
  const asset = useTimelineStore((s) => {
    const clip = s.project.timeline.clips.find((c) => c.id === clipId);
    if (!clip) return undefined;
    return s.project.media.find((m) => m.id === clip.assetId);
  });

  if (!asset?.generatedBy) return null;

  const { provider, model, costCredits } = asset.generatedBy;

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



