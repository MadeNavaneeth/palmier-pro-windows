/**
 * Regression coverage for the workspace layout presets (upstream PR #430).
 *
 * The presets are shared by the store, the shortcut catalogue and the title bar
 * control, so the invariants worth pinning are that the table covers every preset
 * exactly once, that the key bindings are unique, and that an untrusted stored
 * value is narrowed rather than trusted — upstream validates on read from
 * UserDefaults for the same reason.
 */
import { describe, it, expect } from 'vitest';
import {
  LAYOUT_PRESETS,
  LAYOUT_PRESET_INFO,
  DEFAULT_LAYOUT,
  asLayoutPreset,
  layoutPresetInfo,
} from './workspace-layout';

describe('layout preset table', () => {
  it('describes every preset exactly once', () => {
    expect(LAYOUT_PRESET_INFO.map((entry) => entry.id)).toEqual([...LAYOUT_PRESETS]);
  });

  it('gives each preset a distinct digit', () => {
    const digits = LAYOUT_PRESET_INFO.map((entry) => entry.digit);
    expect(new Set(digits).size).toBe(digits.length);
  });

  it('matches upstream on the digits, so muscle memory carries over', () => {
    expect(LAYOUT_PRESET_INFO.map((entry) => `${entry.id}:${entry.digit}`)).toEqual([
      'default:1', 'media:2', 'vertical:3',
    ]);
  });

  it('labels and describes every preset', () => {
    for (const entry of LAYOUT_PRESET_INFO) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('resolves info for any preset', () => {
    for (const preset of LAYOUT_PRESETS) {
      expect(layoutPresetInfo(preset).id).toBe(preset);
    }
  });

  it('defaults to an arrangement that exists', () => {
    expect(LAYOUT_PRESETS).toContain(DEFAULT_LAYOUT);
  });
});

describe('asLayoutPreset', () => {
  it('accepts every known preset', () => {
    for (const preset of LAYOUT_PRESETS) {
      expect(asLayoutPreset(preset)).toBe(preset);
    }
  });

  it('rejects anything else', () => {
    // A stored value can come from a hand-edited file or an older build, so a
    // preset that no longer exists must not become the active layout.
    for (const bad of ['Default', 'grid', '', 'DEFAULT', 1, null, undefined, {}, ['default']]) {
      expect(asLayoutPreset(bad), String(bad)).toBeNull();
    }
  });
});
