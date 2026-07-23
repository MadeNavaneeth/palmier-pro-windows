import React from 'react';
import {
  Magnet,
  MousePointer2,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useTimelineStore } from '../../store/timeline';

export function TimelineToolbar() {
  const viewport = useTimelineStore((state) => state.viewport);
  const zoomIn = useTimelineStore((state) => state.zoomIn);
  const zoomOut = useTimelineStore((state) => state.zoomOut);
  const snapEnabled = useTimelineStore((state) => state.snapEnabled);
  const splitAtPlayhead = useTimelineStore((state) => state.splitAtPlayhead);
  const removeSelectedClips = useTimelineStore((state) => state.removeSelectedClips);
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);
  const canUndo = useTimelineStore((state) => state.canUndo());
  const canRedo = useTimelineStore((state) => state.canRedo());
  const undo = useTimelineStore((state) => state.undo);
  const redo = useTimelineStore((state) => state.redo);

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
    <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-white/10 bg-surface-1 px-2.5">
      <ToolButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
        <Undo2 size={14} />
      </ToolButton>
      <ToolButton label="Redo (Ctrl+Y)" onClick={redo} disabled={!canRedo}>
        <Redo2 size={14} />
      </ToolButton>

      <Divider />

      <ToolButton
        label="Pointer (V)"
        onClick={() => useTimelineStore.getState().deselectAll()}
        active
      >
        <MousePointer2 size={14} />
      </ToolButton>
      <ToolButton label="Split at playhead (C)" onClick={splitAtPlayhead}>
        <Scissors size={14} />
      </ToolButton>
      <ToolButton
        label="Delete selected clips"
        onClick={removeSelectedClips}
        disabled={selectedClipIds.size === 0}
      >
        <Trash2 size={14} />
      </ToolButton>

      <Divider />

      <ToolButton
        label={`Snapping ${snapEnabled ? 'on' : 'off'}`}
        onClick={() => useTimelineStore.setState({ snapEnabled: !snapEnabled })}
        active={snapEnabled}
      >
        <Magnet size={14} />
      </ToolButton>

      <div className="ml-auto flex items-center gap-1">
        <ToolButton label="Zoom out" onClick={zoomOut}>
          <ZoomOut size={14} />
        </ToolButton>
        <input
          type="range"
          min={viewport.minPxPerFrame}
          max={viewport.maxPxPerFrame}
          step={0.01}
          value={viewport.pixelsPerFrame}
          onChange={(event) => setZoom(Number(event.target.value))}
          className="h-1 w-24 accent-accent"
          aria-label="Timeline zoom"
        />
        <ToolButton label="Zoom in" onClick={zoomIn}>
          <ZoomIn size={14} />
        </ToolButton>
      </div>
    </div>
  );
}

function Divider() {
  return <div className="mx-1 h-5 w-px bg-white/12" />;
}

function ToolButton({
  label,
  onClick,
  children,
  disabled = false,
  active = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-active={active}
      className="icon-button disabled:cursor-not-allowed disabled:opacity-25"
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}
