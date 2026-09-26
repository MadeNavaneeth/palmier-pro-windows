import React from 'react';
import {
  ArrowRight,
  Circle,
  CircleX,
  Copy,
  Flag,
  Keyboard,
  Magnet,
  Minus,
  Search,
  ListCollapse,
  Maximize2,
  Minimize2,
  MoveLeft,
  MoveRight,
  MousePointer2,
  Redo2,
  Scissors,
  Shapes,
  Square,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useTimelineStore } from '../../store/timeline';
import { useUiStore } from '../../store/ui';
import { primaryShortcutLabel, shortcutsForPreset } from '../../../shared/editor/shortcuts';
import { SHAPE_KINDS, type ShapeKind } from '../../../shared/editor/shape';

export function TimelineToolbar() {
  const viewport = useTimelineStore((state) => state.viewport);
  const zoomIn = useTimelineStore((state) => state.zoomIn);
  const zoomOut = useTimelineStore((state) => state.zoomOut);
  const snapEnabled = useTimelineStore((state) => state.snapEnabled);
  const splitAtPlayhead = useTimelineStore((state) => state.splitAtPlayhead);
  const removeSelectedClips = useTimelineStore((state) => state.removeSelectedClips);
  const rippleDelete = useTimelineStore((state) => state.rippleDelete);
  const addTitleAtPlayhead = useTimelineStore((state) => state.addTitleAtPlayhead);
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);
  const selectedGap = useTimelineStore((state) => state.selectedGap);
  const inFrame = useTimelineStore((state) => state.getScopeTimeline().inFrame);
  const outFrame = useTimelineStore((state) => state.getScopeTimeline().outFrame);
  const setInFrame = useTimelineStore((state) => state.setInFrame);
  const setOutFrame = useTimelineStore((state) => state.setOutFrame);
  const extractMarkedRange = useTimelineStore((state) => state.extractMarkedRange);
  const clearMarkedRange = useTimelineStore((state) => state.clearMarkedRange);
  const canUndo = useTimelineStore((state) => state.canUndo());
  const canRedo = useTimelineStore((state) => state.canRedo());
  const undo = useTimelineStore((state) => state.undo);
  const redo = useTimelineStore((state) => state.redo);
  const lastOp = useTimelineStore((state) => state.controller.getLastCommandDescription());
  const toggleSnap = useTimelineStore((state) => state.toggleSnap);
  const rippleMarkers = useTimelineStore((state) => state.rippleMarkers);
  const setRippleMarkers = useTimelineStore((state) => state.setRippleMarkers);
  const loadRippleMarkers = useTimelineStore((state) => state.loadRippleMarkers);
  const duplicateSelected = useTimelineStore((state) => state.duplicateSelected);
  const openPalette = useUiStore((state) => state.openCommandPalette);
  const deselectAll = useTimelineStore((state) => state.deselectAll);
  const timelinePath = useTimelineStore((state) => state.timelinePath);
  const navigateScopeTo = useTimelineStore((state) => state.navigateScopeTo);  const fitToViewport = useTimelineStore((state) => state.fitToViewport);
  const openShortcutHelp = useUiStore((state) => state.openShortcutHelp);
  const shortcutPreset = useUiStore((state) => state.shortcutPreset);

  // Tooltip text with the live chord appended.
  //
  // Reading the chord from the catalogue through the active preset (#579) means
  // a rebinding — default or Final Cut Pro — cannot leave a stale hint on a
  // button; the labels here used to name keys the handler no longer had.
  const definitions = React.useMemo(() => shortcutsForPreset(shortcutPreset), [shortcutPreset]);
  const withChord = (label: string, id: Parameters<typeof primaryShortcutLabel>[0]): string => {
    const chord = primaryShortcutLabel(id, definitions);
    return chord ? `${label} (${chord})` : label;
  };

  // Pull the saved marker-ripple preference into the store controller once.
  React.useEffect(() => {
    loadRippleMarkers();
  }, [loadRippleMarkers]);

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
      {/* Nested-timeline breadcrumb (#155 slice 2): rendered only while a
          nest is open, so the root toolbar is byte-for-byte the old layout.
          Ancestors navigate up; the leaf is the current scope. */}
      {timelinePath.length > 1 && (
        <>
          <nav aria-label="Nested timeline" className="flex min-w-0 items-center gap-0.5">
            {timelinePath.map((crumb, index) => {
              const last = index === timelinePath.length - 1;
              return (
                <span key={crumb.id ?? 'main'} className="flex min-w-0 items-center gap-0.5">
                  {index > 0 && <span className="shrink-0 text-[10px] text-text-muted">›</span>}
                  {last ? (
                    <span aria-current="page" className="max-w-28 truncate text-[10px] font-medium text-text-primary">
                      {crumb.name}
                    </span>
                  ) : (
                    <button
                      onClick={() => navigateScopeTo(crumb.id)}
                      title={`Back to ${crumb.name}`}
                      className="max-w-28 truncate text-[10px] text-text-secondary hover:text-text-primary hover:underline"
                    >
                      {crumb.name}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
          <Divider />
        </>
      )}
      <ToolButton
        label={canUndo && lastOp ? `Undo: ${lastOp}` : withChord('Undo', 'undo')}
        onClick={undo}
        disabled={!canUndo}
      >
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
        label="Add title at the playhead (double-click the clip to edit)"
        onClick={() => addTitleAtPlayhead()}
      >
        <Type size={14} />
      </ToolButton>
      <ShapePicker />
      <ToolButton
        label={withChord('Duplicate selected clips', 'duplicateSelected')}
        onClick={duplicateSelected}
        disabled={selectedClipIds.size === 0}
      >
        <Copy size={14} />
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
      <ToolButton
        label={rippleMarkers ? 'Ripple markers with edits (on)' : 'Ripple markers with edits (off)'}
        onClick={() => setRippleMarkers(!rippleMarkers)}
        active={rippleMarkers}
        pressed={rippleMarkers}
      >
        <Flag size={14} />
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
        <ToolButton label={withChord('Command palette', 'showCommandPalette')} onClick={openPalette}>
          <Search size={14} />
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
 * cannot container-query itself Ã¢â‚¬â€ only its descendants can.
 */
function Divider() {
  return <div className="mx-1 h-5 w-px bg-white/12 @max-md:mx-0.5" />;
}

/** Icons for the shape kinds, in `SHAPE_KINDS` order. */
const SHAPE_ICONS: Readonly<Record<ShapeKind, React.ReactNode>> = {
  rect: <Square size={12} />,
  ellipse: <Circle size={12} />,
  line: <Minus size={12} />,
  arrow: <ArrowRight size={12} />,
};

const SHAPE_LABELS: Readonly<Record<ShapeKind, string>> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
};

/**
 * Shape-kind menu: pick a kind and insert a 3s clip at the playhead. Same
 * open/dismiss/Escape contract as the Preview's GuidesMenu; the menu opens
 * downward because this row sits above the tracks.
 */
function ShapePicker() {
  const addShapeAtPlayhead = useTimelineStore((state) => state.addShapeAtPlayhead);
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        // Escape closes the menu without reaching the global shortcut layer,
        // where it would clear the timeline selection.
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
        className="icon-button disabled:cursor-not-allowed disabled:opacity-25"
        title="Add a shape at the playhead"
        aria-label="Add a shape at the playhead"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <Shapes size={14} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Add shape"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
          }}
          className="absolute left-0 top-full z-40 mt-1 w-36 overflow-hidden rounded-md border border-surface-3 bg-surface-2 py-1 shadow-2xl"
        >
          {SHAPE_KINDS.map((kind) => (
            <button
              key={kind}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                addShapeAtPlayhead(kind);
              }}
              className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] text-text-secondary transition hover:bg-white/[0.06] hover:text-text-primary"
            >
              {SHAPE_ICONS[kind]}
              {SHAPE_LABELS[kind]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
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
