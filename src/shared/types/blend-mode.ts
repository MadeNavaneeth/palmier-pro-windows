/**
 * Blend modes (upstream feature parity, Palmier Pro #203/#213).
 *
 * Blend modes are applied at the LAYER COMPOSITING stage — a clip blends with
 * the accumulated result of the tracks below it — not as a per-clip pixel
 * effect. `undefined` / 'normal' means standard source-over and is the
 * backward-compatible default (old .vproj files have no blendMode field).
 *
 * We implement the 12 separable W3C blend modes, which have exact per-channel
 * formulas. This lets the GPU shader (composite.wgsl), the Rust CPU fallback,
 * and any JS path produce pixel-identical results. The numeric index MUST stay
 * in sync with the `BLEND_*` constants in native/src/shaders/composite.wgsl
 * and the match arm in native/src/lib.rs.
 */

export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

/** The default blend mode (source-over). */
export const DEFAULT_BLEND_MODE: BlendMode = 'normal';

/**
 * Map a blend mode to the integer index used by the shader/native code.
 * Order is the source of truth — do not reorder without updating the shader.
 */
export function blendModeToIndex(mode: BlendMode | undefined): number {
  if (!mode) return 0;
  const idx = BLEND_MODES.indexOf(mode);
  return idx < 0 ? 0 : idx;
}

/** Human-readable labels for the inspector dropdown. */
export const BLEND_MODE_LABELS: Record<BlendMode, string> = {
  normal: 'Normal',
  multiply: 'Multiply',
  screen: 'Screen',
  overlay: 'Overlay',
  darken: 'Darken',
  lighten: 'Lighten',
  'color-dodge': 'Color Dodge',
  'color-burn': 'Color Burn',
  'hard-light': 'Hard Light',
  'soft-light': 'Soft Light',
  difference: 'Difference',
  exclusion: 'Exclusion',
};

/** Type guard for validating untrusted input (e.g. agent tool args). */
export function isBlendMode(value: unknown): value is BlendMode {
  return typeof value === 'string' && (BLEND_MODES as readonly string[]).includes(value);
}
