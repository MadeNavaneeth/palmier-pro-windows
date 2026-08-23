import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Grid2x2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  ZoomIn,
} from 'lucide-react';
import { PreviewCanvas } from './PreviewCanvas';
import { useTimelineStore } from '../store/timeline';
import { useUiStore } from '../store/ui';
import { getPlaybackEngine } from '../engine/PlaybackEngine';
import { getAudioPreviewManager } from '../engine/audio-preview';
import { frameToTimecode } from '../../shared/utils/time';
import {
  PLAYBACK_RATE_PRESETS as RATE_PRESETS,
  playbackRateLabel,
} from '../../shared/editor/playback-rate';
import { GUIDE_KINDS, GUIDE_LABELS, type GuideKind } from '../../shared/preview/guides';

export { PLAYBACK_RATE_PRESETS } from '../../shared/editor/playback-rate';

export function Preview() {
  const isPlaying = useTimelineStore((state) => state.isPlaying);
  const playhead = useTimelineStore((state) => state.project.timeline.playheadFrame);
  const projectUpdatedAt = useTimelineStore((state) => state.project.updatedAt);
  const fps = useTimelineStore((state) => state.getProjectFps());
  const togglePlayback = useTimelineStore((state) => state.togglePlayback);
  const stepFrame = useTimelineStore((state) => state.stepFrame);
  const setPlayhead = useTimelineStore((state) => state.setPlayhead);
  const width = useTimelineStore((state) => state.project.settings.width);
  const height = useTimelineStore((state) => state.project.settings.height);
  const playbackRate = useTimelineStore((state) => state.playbackRate);
  const setPlaybackRate = useTimelineStore((state) => state.setPlaybackRate);
  const durationFrames = useTimelineStore((state) =>
    Math.max(
      1,
      ...state.project.timeline.clips.map(
        (clip) => clip.startFrame + clip.durationFrames,
      ),
    ),
  );
  const hasVisualClipAtPlayhead = useTimelineStore((state) =>
    state.project.timeline.clips.some(
      (clip) =>
        clip.type !== 'audio'
        && playhead >= clip.startFrame
        && playhead < clip.startFrame + clip.durationFrames,
    ),
  );

  const engine = useRef(getPlaybackEngine());

  // Preview audio: reconcile the HTML audio pool from every engine tick and
  // on seeks; pause everything whenever playback stops.
  useEffect(() => {
    const manager = getAudioPreviewManager();
    const engineRef = engine.current;
    const unsubscribe = engineRef.addTickListener((playhead) => {
      manager.sync(playhead, true);
    });
    return () => {
      unsubscribe();
      manager.stopAll();
    };
  }, []);

  useEffect(() => {
    if (!isPlaying) getAudioPreviewManager().stopAll();
  }, [isPlaying]);

  useEffect(() => {
    if (isPlaying) engine.current.start();
    else engine.current.stop();
  }, [isPlaying]);

  useEffect(() => {
    if (!isPlaying) engine.current.seek(playhead);
  }, [playhead, isPlaying, projectUpdatedAt]);

  useEffect(() => () => engine.current.dispose(), []);

  const handleTogglePlay = useCallback(() => {
    togglePlayback();
  }, [togglePlayback]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-1">
      <div className="panel-header flex items-center px-2">
        <div className="flex h-full items-center border-b border-white/80 px-2 text-[10px] font-medium text-text-primary">
          Timeline
        </div>
      </div>

      <PreviewCanvas
        width={width}
        height={height}
        emptyMessage={
          hasVisualClipAtPlayhead
            ? undefined
            : 'Drop video or an image onto a video track to preview it'
        }
      />

      <div className="flex h-5 shrink-0 items-center border-t border-white/10 px-3">
        <input
          type="range"
          min={0}
          max={durationFrames}
          value={Math.min(playhead, durationFrames)}
          onChange={(event) => setPlayhead(Number(event.target.value))}
          aria-label="Preview playhead"
          className="h-1 w-full accent-accent"
        />
      </div>

      {/* Container query, not a viewport one: what decides whether this row fits
          is its own width, which depends on which side panels are open. With the
          Agent panel open a 1600px window leaves it about 480px wide, so viewport
          breakpoints kept the wide layout and clipped the right-hand controls
          while pushing the transport off centre. */}
      <div className="@container flex h-9 shrink-0 items-center justify-between px-3">
        {/* Both side columns share a width so the transport stays centered; it
            has to hold the guides control without pushing the transport off.
            Below ~384px the matched width is what does not fit any more, so the
            columns collapse to their content and the transport gives up being
            exactly centred rather than being clipped. */}
        <div className="w-44 whitespace-nowrap @max-xl:w-24 @max-sm:w-auto">
          <span className="font-mono text-[11px] text-text-secondary tabular-nums">
            {frameToTimecode(playhead, fps)}
          </span>
          <span className="ml-1 font-mono text-[10px] text-text-muted @max-xl:hidden">
            / {frameToTimecode(durationFrames, fps)}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <TransportButton label="Go to beginning" onClick={() => setPlayhead(0)}>
            <SkipBack size={13} fill="currentColor" />
          </TransportButton>
          <TransportButton label="Previous frame" onClick={() => stepFrame(-1)}>
            <ChevronLeft size={15} strokeWidth={2} />
          </TransportButton>
          <button
            onClick={handleTogglePlay}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-primary hover:bg-white/[0.08]"
            title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying
              ? <Pause size={13} fill="currentColor" />
              : <Play size={13} fill="currentColor" />}
          </button>
          <TransportButton label="Next frame" onClick={() => stepFrame(1)}>
            <ChevronRight size={15} strokeWidth={2} />
          </TransportButton>
          <TransportButton label="Go to end" onClick={() => setPlayhead(durationFrames)}>
            <SkipForward size={13} fill="currentColor" />
          </TransportButton>
        </div>

        <div className="flex w-44 items-center justify-end gap-1 @max-xl:w-24 @max-sm:w-auto">
          <label
            className="flex h-7 items-center gap-1 px-1.5 text-[10px] text-text-muted @max-xl:hidden"
            title="Playback speed"
          >
            <Gauge size={13} />
            <select
              aria-label="Playback speed"
              value={String(Math.abs(playbackRate))}
              onChange={(event) => setPlaybackRate(Number(event.target.value))}
              className="cursor-pointer bg-transparent text-[10px] text-text-muted outline-none hover:text-text-primary"
            >
              {RATE_PRESETS.map((rate) => (
                <option key={rate} value={rate} className="bg-surface-2 text-text-primary">
                  {playbackRateLabel(rate)}
                </option>
              ))}
            </select>
          </label>
          <GuidesMenu />
          <div
            className="flex h-7 items-center gap-1 px-1.5 text-[10px] text-text-muted @max-xl:hidden"
            title="Canvas zoom"
          >
            <ZoomIn size={13} />
            Fit
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Composition guide toggles (#167).
 *
 * A checkable menu rather than a single cycling button: thirds and safe areas are
 * routinely wanted together, and a cycle would force the user through states
 * they did not ask for to reach the one they did.
 */
function GuidesMenu() {
  const guides = useUiStore((state) => state.guides);
  const toggleGuide = useUiStore((state) => state.toggleGuide);
  const clearGuides = useUiStore((state) => state.clearGuides);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss on a press anywhere else. Bound while open only, so the editor is
  // not paying for a document-level listener the rest of the time.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const active = guides.size > 0;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        // Escape closes the menu without also reaching the global shortcut
        // layer, where it would clear the timeline selection.
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
        className={`flex h-7 items-center gap-1 rounded-md px-1.5 text-[10px] transition hover:bg-white/[0.08] hover:text-text-primary ${
          active ? 'text-text-primary' : 'text-text-muted'
        }`}
        title="Composition guides"
        aria-label="Composition guides"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <Grid2x2 size={13} />
        {/* Container-queried against the transport row that holds this menu, so
            the label drops when that row is narrow rather than when the window is. */}
        <span className="@max-xl:hidden">Guides</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Composition guides"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
          }}
          className="absolute bottom-full right-0 z-40 mb-1 w-52 overflow-hidden rounded-md border border-surface-3 bg-surface-2 py-1 shadow-2xl"
        >
          {GUIDE_KINDS.map((kind) => (
            <GuideMenuItem
              key={kind}
              kind={kind}
              checked={guides.has(kind)}
              onToggle={() => toggleGuide(kind)}
            />
          ))}
          <div className="my-1 h-px bg-white/10" />
          <button
            role="menuitem"
            onClick={clearGuides}
            disabled={!active}
            className="flex w-full items-center px-2 py-1.5 text-left text-[11px] text-text-secondary transition hover:bg-white/[0.06] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <span className="ml-5">Hide all guides</span>
          </button>
        </div>
      )}
    </div>
  );
}

function GuideMenuItem({
  kind,
  checked,
  onToggle,
}: {
  kind: GuideKind;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] text-text-secondary transition hover:bg-white/[0.06] hover:text-text-primary"
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {checked && <Check size={12} />}
      </span>
      {GUIDE_LABELS[kind]}
    </button>
  );
}

function TransportButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-white/[0.08] hover:text-text-primary"
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}
