/**
 * Renderer view of the saved silence-removal controls (upstream PR #426).
 *
 * The main process owns the values so the Agent resolves the same settings the
 * Inspector shows, which makes this a cache rather than the authority. Writes
 * are optimistic for a responsive slider, then reconciled with whatever main
 * returns — main clamps into `SILENCE_LIMITS`, so a rejected value corrects
 * itself in the UI instead of silently disagreeing with the next removal.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SILENCE_CONFIG,
  type SilenceConfig,
} from '../../shared/audio/silence-detector';

export interface SilenceSettingsHandle {
  /** Null until the first read resolves, so controls can stay disabled. */
  settings: SilenceConfig | null;
  /** Apply and persist a partial change. */
  update: (patch: Partial<SilenceConfig>) => void;
  /** Restore the built-in values. */
  reset: () => void;
  /** True once the saved values differ from the defaults. */
  isModified: boolean;
}

export function useSilenceSettings(): SilenceSettingsHandle {
  const [settings, setSettings] = useState<SilenceConfig | null>(null);
  // Guards a resolved write from repopulating state after unmount, and keeps a
  // slow read from overwriting an edit the user made while it was in flight.
  const mounted = useRef(true);
  const edited = useRef(false);

  useEffect(() => {
    mounted.current = true;
    void window.palmier.media
      .getSilenceSettings()
      .then((result) => {
        if (!mounted.current || edited.current) return;
        setSettings(result?.settings ?? { ...DEFAULT_SILENCE_CONFIG });
      })
      .catch(() => {
        if (mounted.current) setSettings({ ...DEFAULT_SILENCE_CONFIG });
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  const write = useCallback((patch: Partial<SilenceConfig>) => {
    edited.current = true;
    setSettings((current) => (current ? { ...current, ...patch } : current));
    void window.palmier.media
      .setSilenceSettings(patch)
      .then((result) => {
        if (mounted.current && result?.settings) setSettings(result.settings);
      })
      .catch(() => {
        // The optimistic value still governs this session; a failed write only
        // means it will not survive a restart.
      });
  }, []);

  const reset = useCallback(() => write({ ...DEFAULT_SILENCE_CONFIG }), [write]);

  const isModified =
    settings !== null &&
    (settings.thresholdDb !== DEFAULT_SILENCE_CONFIG.thresholdDb ||
      settings.minSilenceSec !== DEFAULT_SILENCE_CONFIG.minSilenceSec ||
      settings.edgePaddingSec !== DEFAULT_SILENCE_CONFIG.edgePaddingSec);

  return { settings, update: write, reset, isModified };
}
