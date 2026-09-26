/**
 * Display metadata for named grade/shot presets in the Inspector list
 * (upstream #157).
 *
 * A stored preset is `{ id, label, grade, shot? }` where `shot` is an optional
 * sibling of `grade`. Applying one with a shot reframes the clip (position,
 * scale, rotation, opacity, crop) as well as recoloring it, so the picker
 * needs to mark those rows or the user cannot tell a recolor-only look from a
 * full framing look before clicking. The preset picker is a native
 * `<select>`, whose only metadata channel is the option's text, so the
 * distinction is a plain suffix on the label rather than a badge or icon the
 * control cannot draw.
 *
 * The same module resolves the clip→preset link (`Clip.gradePresetId`) so the
 * Inspector can say which saved look a clip uses, and can say so without
 * drift detection (which is deliberately out of scope).
 */

import {
  normalizeGradePresetId,
  normalizeShotSettings,
} from '../../shared/editor/grade-preset-store';

/**
 * Whether applying this preset also reframes the clip.
 *
 * Narrowed the same way the store narrows a stored shot, so a hostile or
 * empty payload can never claim to carry framing. Reads only `shot`, the
 * optional sibling of `grade`.
 */
export function presetCarriesShot(preset: { shot?: unknown }): boolean {
  return normalizeShotSettings(preset.shot) !== undefined;
}

/**
 * The option text for one preset row: the stored label, plus a plain suffix
 * naming both halves when the preset also carries shot settings. Grade-only
 * presets (including every built-in) keep their bare label.
 */
export function presetOptionLabel(preset: { label: string; shot?: unknown }): string {
  return presetCarriesShot(preset) ? `${preset.label} · grade + framing` : preset.label;
}

/**
 * What the Inspector should say about the clip's named-preset link.
 *
 * - `none`      the clip carries no usable link
 * - `linked`    the link resolves to a saved preset, so its name can be shown
 * - `dangling`  a valid link whose preset no longer exists (deleted elsewhere)
 *
 * A link is metadata only — a hand-edited grade makes it stale, but drift is
 * deliberately not detected, so `linked` never claims the clip still matches
 * the preset. A dangling link stays quiet: the caller shows a neutral note and
 * a way to clear it rather than rendering a name that cannot be resolved.
 */
export type ClipPresetLinkState =
  | { kind: 'none' }
  | { kind: 'linked'; label: string }
  | { kind: 'dangling' };

/** Resolve a clip's optional preset link against the saved-preset list. */
export function clipPresetLink(
  clip: { gradePresetId?: unknown },
  presets: readonly { id: string; label: string }[],
): ClipPresetLinkState {
  const id = normalizeGradePresetId(clip.gradePresetId);
  if (id === undefined) return { kind: 'none' };
  const preset = presets.find((candidate) => candidate.id === id);
  return preset ? { kind: 'linked', label: preset.label } : { kind: 'dangling' };
}
