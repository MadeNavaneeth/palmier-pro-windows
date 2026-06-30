/**
 * Inspector — properties for the currently selected clip.
 * Currently exposes blend mode (upstream #203) and opacity. Shown only when
 * exactly one clip is selected.
 */

import React, { useCallback, useState } from 'react';
import { useTimelineStore } from '../store/timeline';
import { BLEND_MODES, BLEND_MODE_LABELS, type BlendMode } from '../../shared/types/blend-mode';

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
  const fps = useTimelineStore((s) => s.project.settings.fps);

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
    if (result.error) {
      setSilenceStatus(result.error);
    } else if (result.removed === 0) {
      setSilenceStatus('No silence found.');
    } else {
      setSilenceStatus(`Removed ${result.removed} silent gap${result.removed === 1 ? '' : 's'}.`);
    }
  }, [clip, removeSilenceForClip]);

  // Nothing useful to show unless exactly one clip is selected.
  if (!clip) {
    if (selectedClipIds.size > 1) {
      return (
        <div className="border-b border-surface-3 px-3 py-3">
          <p className="text-2xs text-text-muted">{selectedClipIds.size} clips selected</p>
        </div>
      );
    }
    return null;
  }

  const isAudio = clip.type === 'audio';
  const opacityPct = Math.round(clip.opacity * 100);

  return (
    <div className="border-b border-surface-3">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-3">
        <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
          Inspector
        </h2>
        <span className="text-2xs text-text-muted capitalize">{clip.type}</span>
      </div>

      <div className="px-3 py-3 space-y-3">
        {/* Clip label */}
        <div className="truncate text-xs text-text-primary" title={clip.label || clip.id}>
          {clip.label || clip.id}
        </div>

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
          </>
        )}

        {isAudio && (
          <p className="text-2xs text-text-muted">
            Audio clip — compositing properties don't apply.
          </p>
        )}

        {/* Audio tools — available for audio and video clips (both can carry sound). */}
        {clip.type !== 'image' && clip.type !== 'title' && (
          <div className="flex flex-col gap-1.5 pt-1 border-t border-surface-3">
            <label className="text-2xs text-text-muted uppercase tracking-wide pt-1">Audio</label>
            <button
              onClick={handleRemoveSilence}
              disabled={working}
              className="rounded border border-surface-3 bg-surface-2 px-2 py-1 text-xs text-text-primary transition hover:border-surface-4 hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {working ? 'Analyzing…' : 'Remove Silence'}
            </button>
            {silenceStatus && (
              <span className="text-2xs text-text-muted">{silenceStatus}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
