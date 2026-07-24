import React, { useCallback, useEffect, useRef } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Gauge,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  ZoomIn,
} from 'lucide-react';
import { PreviewCanvas } from './PreviewCanvas';
import { useTimelineStore } from '../store/timeline';
import { getPlaybackEngine } from '../engine/PlaybackEngine';
import { frameToTimecode } from '../../shared/utils/time';

export const PLAYBACK_RATE_PRESETS = [0.5, 0.75, 1, 1.5, 2, 4, 10] as const;

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

      <div className="flex h-9 shrink-0 items-center justify-between px-3">
        <div className="w-36 whitespace-nowrap max-[1200px]:w-24">
          <span className="font-mono text-[11px] text-text-secondary tabular-nums">
            {frameToTimecode(playhead, fps)}
          </span>
          <span className="ml-1 font-mono text-[10px] text-text-muted max-[1200px]:hidden">
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

        <div className="flex w-36 items-center justify-end gap-1 max-[1200px]:w-24">
          <label
            className="flex h-7 items-center gap-1 px-1.5 text-[10px] text-text-muted max-[1200px]:hidden"
            title="Playback speed"
          >
            <Gauge size={13} />
            <select
              aria-label="Playback speed"
              value={String(Math.abs(playbackRate))}
              onChange={(event) => setPlaybackRate(Number(event.target.value))}
              className="cursor-pointer bg-transparent text-[10px] text-text-muted outline-none hover:text-text-primary"
            >
              {PLAYBACK_RATE_PRESETS.map((rate) => (
                <option key={rate} value={rate} className="bg-surface-2 text-text-primary">
                  {rate}x
                </option>
              ))}
            </select>
          </label>
          <div
            className="flex h-7 items-center gap-1 px-1.5 text-[10px] text-text-muted"
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
