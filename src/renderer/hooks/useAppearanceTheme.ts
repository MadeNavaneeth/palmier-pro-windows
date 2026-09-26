/**
 * useAppearanceTheme — apply the stored theme preference to the document.
 *
 * The stylesheet re-skins itself from the `light` class on `<html>`; this hook
 * is the only place that writes it. An explicit light/dark override applies
 * immediately, while `system` tracks the OS `prefers-color-scheme` value live,
 * so flipping the OS theme re-skins the app without a reload.
 */

import { useEffect } from 'react';
import { useUiStore } from '../store/ui';
import { resolveAppearance } from '../lib/appearance';

function systemIsDark(): boolean {
  try {
    // No matchMedia (unit tests, odd embeds): keep today's dark look rather
    // than guessing light.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

export function useAppearanceTheme() {
  const appearance = useUiStore((s) => s.appearance);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const apply = () => {
      document.documentElement.classList.toggle(
        'light',
        resolveAppearance(appearance, systemIsDark()) === 'light',
      );
    };
    apply();

    let media: MediaQueryList | null = null;
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      media = null;
    }
    if (media && typeof media.addEventListener === 'function') {
      media.addEventListener('change', apply);
    }
    // Re-check when the window regains focus: the change event above is the
    // primary path, but a theme flipped while the app was in the background
    // must still land the moment the user comes back to it.
    window.addEventListener('focus', apply);
    return () => {
      media?.removeEventListener('change', apply);
      window.removeEventListener('focus', apply);
    };
  }, [appearance]);
}
