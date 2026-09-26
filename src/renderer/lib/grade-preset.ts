/**
 * Renderer-facing color-grade preset helpers (upstream #157).
 *
 * The contract and snapshot implementation are shared with the main-process
 * repository and Agent/MCP executor. Keeping this re-export layer preserves
 * the existing renderer import path without maintaining a second schema.
 */

export {
  GRADE_PRESET_PROPAGATE_MODES,
  applyGradePatch,
  applyGradePresetTo,
  applyShotSettings,
  capturePresetFromClip,
  gradeFromClip,
  gradePresetPatch,
  normalizeShotSettings,
  parseGradePresetPropagateMode,
  resolveGradePresetPropagation,
  shotFromClip,
  type CapturedPreset,
  type GradePresetPropagationCover,
  type GradePresetPropagateMode,
  type ShotCanvasSize,
  type ShotSettings,
} from '../../shared/editor/grade-preset-store';
