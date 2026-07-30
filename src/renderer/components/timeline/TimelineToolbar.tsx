import React from 'react';
import {
  CircleX,
  Keyboard,
  Magnet,
  ListCollapse,
  Maximize2,
  Minimize2,
  MoveLeft,
  MoveRight,
  MousePointer2,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useTimelineStore } from '../../store/timeline';
import { useUiStore } from '../../store/ui';
import { primaryShortcutLabel } from '../../../shared/editor/shortcuts';

/**
 * Tooltip text with the live chord appended.
 *
 * Reading the chord from the catalogue means a rebinding cannot leave a stale
 * hint on a button — the labels here used to name keys the handler no longer had.
 */
function withChord(label: string, id: Parameters<typeof primaryShortcutLabel>[0]): string {
  const chord = primaryShortcutLabel(id);
  return chord ? `${label} (${chord})` : label;
}

export function TimelineToolbar() {
  const viewport = useTimelineStore((state) => state.viewport);
  const zoomIn = useTimelineStore((state) => state.zoomIn);
  const zoomOut = useTimelineStore((state) => state.zoomOut);
  const snapEnabled = useTimelineStore((state) => state.snapEnabled);
  const splitAtPlayhead = useTimelineStore((state) => state.splitAtPlayhead);
  const removeSelectedClips = useTimelineStore((state) => state.removeSelectedClips);
  const rippleDelete = useTimelineStore((state) => state.rippleDelete);
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);
  const selectedGap = useTimelineStore((state) => state.selectedGap);
  const inFrame = useTimelineStore((state) => state.project.timeline.inFrame);
  const outFrame = useTimelineStore((state) => state.project.timeline.outFrame);
  const setInFrame = useTimelineStore((state) => state.setInFrame);
  const setOutFrame = useTimelineStore((state) => state.setOutFrame);
  const extractMarkedRange = useTimelineStore((state) => state.extractMarkedRange);
  const clearMarkedRange = useTimelineStore((state) => state.clearMarkedRange);
  const canUndo = useTimelineStore((state) => state.canUndo());
  const canRedo = useTimelineStore((state) => state.canRedo());
  const undo = useTimelineStore((state) => state.undo);
  const redo = useTimelineStore((state) => state.redo);
  const toggleSnap = useTimelineStore((state) => state.toggleSnap);
  const deselectAll = useTimelineStore((state) => state.deselectAll);
  const fitToViewport = useTimelineStore((state) => state.fitToViewport);
  const openShortcutHelp = useUiStore((state) => state.openShortcutHelp);

  const setZoom = (value: number) => {
    useTimelineStore.setState({
      viewport: {
        ...viewport,
        pixelsPerFrame: Math.max(
          viewport.minPxPerFrame,
          Math.min(viewport.maxPxPerFrame, value),
        ),
      },
    });
  };

  return (
    // gap-1.5 rather than gap-2, and the zoom slider hides when the row is
    // narrow: the full row does not fit, and clipping it silently put the
    // rightmost controls out of reach.
    //
    // A container query, not a viewport one. What decides whether the row fits
    // is the row's own width, and that is set by which side panels are open, not
    // by the window: with the Agent panel open, a 1600px window leaves this row
    // about 480px wide, so a viewport breakpoint kept the slider and clipped the
    // controls again.
    // The tighter gap below 28rem is the last 400px case: with all four panels
    // open in a 1024px window this row is 400px wide, and at gap-1.5 the
    // shortcuts button sat 1px past the panel edge.
    <div className="@container flex h-[38px] shrink-0 items-center gap-1.5 border-b border-white/10 bg-surface-1 px-2.5">
      <ToolButton label={withChord('Undo', 'undo')} onClick={undo} disabled={!canUndo}>
        <Undo2 size={14} />
      </ToolButton>
      <ToolButton label={withChord('Redo', 'redo')} onClick={redo} disabled={!canRedo}>
        <Redo2 size={14} />
      </ToolButton>

      <Divider />

      <ToolButton label={withChord('Mark In at playhead', 'setInPoint')} onClick={setInFrame}>
        <MoveRight size={14} />
      </ToolButton>
      <ToolButton label={withChord('Mark Out at playhead', 'setOutPoint')} onClick={setOutFrame}>
        <MoveLeft size={14} />
      </ToolButton>
      <ToolButton
        label={withChord('Extract marked range', 'extractMarkedRange')}
        onClick={extractMarkedRange}
        disabled={inFrame === undefined || outFrame === undefined || outFrame <= inFrame}
      >
        <Minimize2 size={14} />
      </ToolButton>
      <ToolButton
        label={withChord('Clear In and Out marks', 'clearMarkedRange')}
        onClick={clearMarkedRange}
        disabled={inFrame === undefined && outFrame === undefined}
      >
        <CircleX size={14} />
      </ToolButton>

      <Divider />

      <ToolButton label="Pointer" onClick={deselectAll} active>
        <MousePointer2 size={14} />
      </ToolButton>
      <ToolButton label={withChord('Split at playhead', 'splitAtPlayhead')} onClick={splitAtPlayhead}>
        <Scissors size={14} />
      </ToolButton>
      <ToolButton
        label={withChord('Delete selected clips', 'deleteSelected')}
        onClick={removeSelectedClips}
        disabled={selectedClipIds.size === 0}
      >
        <Trash2 size={14} />
      </ToolButton>
      <ToolButton
        label={withChord('Ripple delete selection', 'rippleDeleteSelected')}
        onClick={rippleDelete}
        disabled={selectedClipIds.size === 0 && !selectedGap}
      >
        <ListCollapse size={14} />
      </ToolButton>

      <Divider />

      <ToolButton
        label={withChord(`Snapping ${snapEnabled ? 'on' : 'off'}`, 'toggleSnap')}
        onClick={toggleSnap}
        active={snapEnabled}
        pressed={snapEnabled}
      >
        <Magnet size={14} />
      </ToolButton>

      <div className="ml-auto flex items-center gap-1">
        <ToolButton label={withChord('Fit timeline to window', 'fitToWindow')} onClick={fitToViewport}>
          <Maximize2 size={14} />
        </ToolButton>
        <ToolButton label={withChord('Zoom out', 'zoomOut')} onClick={zoomOut}>
          <ZoomOut size={14} />
        </ToolButton>
        {/* Hidden once the row itself is under 36rem: the zoom buttons either
            side cover the same ground, and keeping the slider pushed the rest of
            the row out of the panel. */}
        <input
          type="range"
          min={viewport.minPxPerFrame}
          max={viewport.maxPxPerFrame}
          step={0.01}
          value={viewport.pixelsPerFrame}
          onChange={(event) => setZoom(Number(event.target.value))}
          className="h-1 w-24 accent-accent @max-xl:hidden"
          aria-label="Timeline zoom"
        />
        <ToolButton label={withChord('Zoom in', 'zoomIn')} onClick={zoomIn}>
          <ZoomIn size={14} />
        </ToolButton>

        <Divider />

        <ToolButton
          label={withChord('Keyboard shortcuts', 'showShortcuts')}
          onClick={openShortcutHelp}
        >
          <Keyboard size={14} />
        </ToolButton>
      </div>
    </div>
  );
}

/**
 * Tighter margins once the row is under 28rem.
 *
 * That is the all-panels-open case: at 1024px wide with the Agent, Media and
 * Inspector panels all showing, this row is 400px and the shortcuts button at
 * the far right sat one pixel past the panel edge. The margin lives here rather
 * than as a smaller `gap` on the row, because an element declaring `@container`
 * cannot container-query itself — only its descendants can.
 */
function Divider() {
  return <div className="mx-1 h-5 w-px bg-white/12 @max-md:mx-0.5" />;
}

function ToolButton({
  label,
  onClick,
  children,
  disabled = false,
  active = false,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  /** Visual emphasis only. */
  active?: boolean;
  /**
   * Set for real on/off toggles. `data-active` is a style hook a screen reader
   * cannot see, so a toggle's state has to be announced separately.
   */
  pressed?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-active={active}
      aria-pressed={pressed}
      className="icon-button disabled:cursor-not-allowed disabled:opacity-25"
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}
