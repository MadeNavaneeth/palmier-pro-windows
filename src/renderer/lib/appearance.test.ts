/**
 * Appearance preference tests (upstream PR #430's Theme half).
 *
 * The first blocks pin the pure rules: an unknown stored value degrades to
 * `system`, every choice has UI info, and explicit overrides always beat the
 * OS value. The last block is this port's analogue of upstream's
 * `lightPaletteMaintainsReadableContrast`: it parses the real token values
 * out of `styles/index.css` (both the `@theme` dark block and the
 * `html.light` scope) and checks the WCAG ratios of the pairs the UI actually
 * renders, so a token edit that breaks light-mode legibility fails here
 * instead of in a screenshot.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  APPEARANCES,
  APPEARANCE_INFO,
  DEFAULT_APPEARANCE,
  appearanceInfo,
  narrowAppearance,
  resolveAppearance,
  type Appearance,
} from './appearance';

describe('narrowAppearance', () => {
  it('accepts each stored choice', () => {
    for (const choice of APPEARANCES) {
      expect(narrowAppearance(choice)).toBe(choice);
    }
  });

  it('degrades anything unrecognized to following the system', () => {
    for (const stored of [undefined, null, '', 'sepia', 'Dark', 'LIGHT', 0, {}, ['dark']]) {
      expect(narrowAppearance(stored), JSON.stringify(stored)).toBe(DEFAULT_APPEARANCE);
    }
  });
});

describe('resolveAppearance', () => {
  it('follows the OS when the preference is system', () => {
    expect(resolveAppearance('system', true)).toBe('dark');
    expect(resolveAppearance('system', false)).toBe('light');
  });

  it('lets an explicit override beat either OS value', () => {
    for (const systemDark of [true, false]) {
      expect(resolveAppearance('light', systemDark)).toBe('light');
      expect(resolveAppearance('dark', systemDark)).toBe('dark');
    }
  });
});

describe('appearanceInfo', () => {
  it('covers every choice with a label', () => {
    const ids = APPEARANCE_INFO.map((entry) => entry.id);
    expect([...ids].sort()).toEqual([...APPEARANCES].sort());
    for (const entry of APPEARANCE_INFO) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
    expect(appearanceInfo('system' as Appearance).label).toBe('System');
  });
});

// ─── Stylesheet token contrast ─────────────────────────────────────────────

type Rgb = [number, number, number];

/** Parse `#rgb`, `#rrggbb` and `rgba(r, g, b, a)` into components. */
function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const text = value.trim();
  const rgba = text.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgba) {
    return {
      rgb: [Number(rgba[1]) / 255, Number(rgba[2]) / 255, Number(rgba[3]) / 255],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  const hex = text.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!hex) throw new Error(`unsupported token value ${JSON.stringify(value)}`);
  const digits = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
  return {
    rgb: [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255) as Rgb,
    alpha: 1,
  };
}

/** Extract `--color-*` pairs from a brace block (scope checked by caller). */
function readScope(css: string, opener: RegExp): Record<string, string> {
  const start = css.search(opener);
  if (start < 0) throw new Error(`scope ${opener} not found`);
  const open = css.indexOf('{', start);
  let depth = 0;
  let close = open;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const tokens: Record<string, string> = {};
  const body = css.slice(open + 1, close);
  for (const match of body.matchAll(/--(color-[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG ratio of `foreground` painted over an opaque `background`. */
function contrastRatio(foreground: string, background: string): number {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (bg.alpha !== 1) throw new Error('background must be opaque');
  const blended: Rgb = fg.rgb.map((v, i) => v * fg.alpha + bg.rgb[i] * (1 - fg.alpha)) as Rgb;
  const lighter = Math.max(relativeLuminance(blended), relativeLuminance(bg.rgb));
  const darker = Math.min(relativeLuminance(blended), relativeLuminance(bg.rgb));
  return (lighter + 0.05) / (darker + 0.05);
}

const EXPECTED_TOKENS = [
  'color-surface-0',
  'color-surface-1',
  'color-surface-2',
  'color-surface-3',
  'color-surface-4',
  'color-accent',
  'color-accent-hover',
  'color-accent-muted',
  'color-timecode',
  'color-text-primary',
  'color-text-secondary',
  'color-text-muted',
];

function themeTokens(): { dark: Record<string, string>; light: Record<string, string> } {
  const css = readFileSync(fileURLToPath(new URL('../styles/index.css', import.meta.url)), 'utf8');
  return {
    dark: readScope(css, /@theme\s*\{/),
    light: readScope(css, /html\.light\s*\{/),
  };
}

describe('theme token contrast', () => {
  it('both scopes declare the same token inventory', () => {
    const { dark, light } = themeTokens();
    expect(Object.keys(dark).sort()).toEqual([...EXPECTED_TOKENS].sort());
    expect(Object.keys(light).sort()).toEqual([...EXPECTED_TOKENS].sort());
    expect(light).not.toEqual(dark);
  });

  it('keeps primary text at AA on every surface, both themes', () => {
    const { dark, light } = themeTokens();
    for (const theme of [dark, light]) {
      for (const surface of ['color-surface-0', 'color-surface-1', 'color-surface-2', 'color-surface-3']) {
        expect(
          contrastRatio(theme['color-text-primary'], theme[surface]),
          `primary on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps secondary text at AA and muted text legible on panels, both themes', () => {
    const { dark, light } = themeTokens();
    for (const theme of [dark, light]) {
      for (const surface of ['color-surface-0', 'color-surface-1', 'color-surface-2']) {
        expect(
          contrastRatio(theme['color-text-secondary'], theme[surface]),
          `secondary on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
        // Upstream's muted rule is 3:1; this port's light muted clears AA too.
        expect(
          contrastRatio(theme['color-text-muted'], theme[surface]),
          `muted on ${surface}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('keeps the accent readable as text and as a button fill, both themes', () => {
    const { dark, light } = themeTokens();
    for (const theme of [dark, light]) {
      // `text-accent` on a panel, and `text-surface-0` on `bg-accent`.
      expect(contrastRatio(theme['color-accent'], theme['color-surface-1'])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme['color-surface-0'], theme['color-accent'])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme['color-surface-0'], theme['color-accent-hover'])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the timecode and curve-master tints legible in light mode', () => {
    const { light } = themeTokens();
    expect(contrastRatio(light['color-timecode'], light['color-surface-1'])).toBeGreaterThanOrEqual(4.5);
    // The master curve is drawn in the secondary tint over the graph fill.
    expect(contrastRatio(light['color-text-secondary'], light['color-surface-2'])).toBeGreaterThanOrEqual(4.5);
  });
});
