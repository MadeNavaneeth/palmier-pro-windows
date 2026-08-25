import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownUp,
  AudioLines,
  Film,
  Folder,
  Grid2X2,
  Image as ImageIcon,
  ListFilter,
  MoreHorizontal,
  Music2,
  Plus,
  Search,
  Subtitles,
  Upload,
} from 'lucide-react';
import { useProjectStore } from '../store/project';
import { useTimelineStore } from '../store/timeline';
import { canExtractAudio, useMediaPanelStore } from '../store/media-panel';
import { selectionModeFromModifiers } from '../../shared/media-panel/selection';
import type { MediaAsset } from '../../shared/types/project';
import { formatImportErrors } from '../../shared/media/import-summary';
import { formatDuration } from '../../shared/utils/time';
import { ASSET_DND_MIME, getDroppedFilePath, setDraggingAsset } from '../lib/dnd';

/** Minimum tile width in the media grid; must match the grid template below. */
const MEDIA_TILE_MIN_WIDTH = 112;
const MEDIA_GRID_GAP = 8;

/** Stable DOM id for a media tile, used for aria-activedescendant. */
function mediaOptionId(assetId: string): string {
  return `media-option-${assetId}`;
}

type PanelTab = 'media' | 'captions' | 'audio';

const panelTabs = [
  { id: 'media' as const, label: 'Media', Icon: Folder },
  { id: 'captions' as const, label: 'Captions', Icon: Subtitles },
  { id: 'audio' as const, label: 'Audio', Icon: AudioLines },
];

export function MediaBin() {
  const project = useTimelineStore((state) => state.project);
  const controller = useTimelineStore((state) => state.controller);
  const offlinePaths = useTimelineStore((state) => state.offlinePaths);
  const refreshOfflineStatus = useTimelineStore((state) => state.refreshOfflineStatus);
  const offlineAssets = useMemo(
    () => project.media.filter((asset) => offlinePaths.has(asset.path)),
    [project.media, offlinePaths],
  );
  const [scanning, setScanning] = useState(false);

  async function handleScanRelink() {
    if (offlineAssets.length === 0) return;
    setScanning(true);
    try {
      const folderRes = await window.palmier.media.chooseFolder();
      if (!folderRes.success || !folderRes.folder) return;
      const scan = await window.palmier.media.scanRelink(
        offlineAssets.map((a) => a.filename),
        folderRes.folder,
      );
      const byId: Record<string, string> = {};
      for (const asset of offlineAssets) {
        const found = scan.matches[asset.filename];
        if (found) byId[asset.id] = found;
      }
      const matched = Object.keys(byId).length;
      if (matched === 0) {
        useMediaPanelStore.getState().setNotice('No matching files found in that folder.');
        return;
      }
      controller.relinkAssetsBatch(byId);
      await refreshOfflineStatus();
      useMediaPanelStore
        .getState()
        .setNotice(`Relinked ${matched} of ${offlineAssets.length} offline items.`);
    } finally {
      setScanning(false);
    }
  }

  const importAssets = useTimelineStore((state) => state.importAssets);
  const fps = project.settings.fps;
  const [activeTab, setActiveTab] = useState<PanelTab>('media');
  const [query, setQuery] = useState('');
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const [importError, setImportError] = useState('');

  const mediaItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return project.media;
    return project.media.filter((item) => item.filename.toLowerCase().includes(normalized));
  }, [project.media, query]);

  function addImportedFiles(result: {
    success: boolean;
    files: Parameters<typeof importAssets>[0];
    errors?: string[];
  }) {
    if (result.success && result.files.length > 0) {
      importAssets(result.files);
      useProjectStore.getState().markDirty();
    }
    setImportError(
      formatImportErrors(result.errors) || (result.success ? '' : 'No supported media files found.'),
    );
  }

  async function handleImport() {
    addImportedFiles(await window.palmier.media.import());
  }

  async function handleFileDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setIsFileDragActive(false);

    const paths = Array.from(event.dataTransfer.files)
      .map((file) => getDroppedFilePath(file, window.palmier.media.getPathForFile))
      .filter((filePath): filePath is string => Boolean(filePath));

    if (paths.length === 0) {
      setImportError('Windows did not provide a readable path for the dropped file.');
      return;
    }

    addImportedFiles(await window.palmier.media.importPaths(paths));
  }

  return (
    <div className="flex min-h-0 flex-1 bg-surface-1">
      <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-white/10 bg-surface-2 py-1.5">
        {panelTabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            className="icon-button relative"
            data-active={activeTab === id}
            onClick={() => setActiveTab(id)}
            title={label}
            aria-label={label}
          >
            {activeTab === id && <span className="absolute left-0 h-4 w-0.5 rounded-r bg-white/60" />}
            <Icon size={15} strokeWidth={1.7} />
          </button>
        ))}
      </nav>

      {activeTab === 'media' ? (
        <div
          className="relative flex min-w-0 flex-1 flex-col"
          onDragEnter={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault();
              setIsFileDragActive(true);
            }
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setIsFileDragActive(false);
            }
          }}
          onDrop={handleFileDrop}
        >
          <div className="flex h-9 shrink-0 items-center gap-1.5 px-2">
            <button
              onClick={handleImport}
              className="flex h-7 items-center gap-1 rounded-md border border-white/15 px-2 text-[11px] font-medium text-text-secondary hover:bg-white/[0.08] hover:text-text-primary"
            >
              <Plus size={13} strokeWidth={1.8} />
              Import
            </button>
            <button className="icon-button" title="More media actions" aria-label="More media actions">
              <MoreHorizontal size={15} />
            </button>
          </div>

          <div className="flex h-9 shrink-0 items-center gap-1.5 px-2">
            <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-white/12 bg-surface-0 px-2 text-text-muted focus-within:border-white/30">
              <Search size={13} strokeWidth={1.7} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
                className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-muted"
              />
            </label>
            <button className="icon-button" title="Grid view" aria-label="Grid view">
              <Grid2X2 size={14} />
            </button>
            <button className="icon-button" title="Sort media" aria-label="Sort media">
              <ArrowDownUp size={14} />
            </button>
            <button className="icon-button" title="Filter media" aria-label="Filter media">
              <ListFilter size={14} />
            </button>
          </div>

          <div className="flex h-6 shrink-0 items-center border-b border-white/10 px-2 text-[10px]">
            <span className="font-semibold text-text-primary">Library</span>
            <MediaLibraryCount visibleCount={mediaItems.length} />
            <ProxyModeToggle />
          </div>

          {/* Three-point placement strip for the single selected asset */}
          <SourcePlaceStrip />

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {offlineAssets.length > 0 && (
            <div className="mb-2 flex items-center gap-2 border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-200">
              <span className="min-w-0 flex-1 truncate">
                {offlineAssets.length} media offline
              </span>
              <button
                type="button"
                onClick={handleScanRelink}
                disabled={scanning}
                className="shrink-0 rounded border border-amber-400/50 px-1.5 py-0.5 text-[9px] font-medium hover:bg-amber-400/10 disabled:opacity-60"
              >
                {scanning ? 'Scanning…' : 'Scan folder to relink'}
              </button>
            </div>
          )}
          {importError && (
              <div className="mb-2 border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-300">
                {importError}
              </div>
            )}
            <PanelNotice />
            <ArmedSwapBanner />
            {mediaItems.length === 0 ? (
              <div className="flex h-full min-h-44 flex-col items-center justify-center px-5 text-center">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-surface-2 text-text-muted">
                  <Upload size={18} strokeWidth={1.5} />
                </div>
                <p className="text-[11px] font-medium text-text-secondary">
                  {query ? 'No matching media' : 'Import media to begin'}
                </p>
                {!query && (
                  <p className="mt-1 max-w-48 text-[10px] leading-4 text-text-muted">
                    Drop video, audio, or images here
                  </p>
                )}
              </div>
            ) : (
              <MediaGrid items={mediaItems} fps={fps} />
            )}
          </div>

          {isFileDragActive && (
            <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-md border border-dashed border-white/60 bg-surface-1/95 text-center shadow-2xl">
              <div>
                <Upload size={22} className="mx-auto mb-2 text-accent" />
                <p className="text-[12px] font-medium text-text-primary">Drop media to import</p>
                <p className="mt-1 text-[10px] text-text-muted">Video, audio, and image files</p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <PanelPlaceholder tab={activeTab} />
      )}
    </div>
  );
}

/** Item count plus the selection size, so bulk actions are legible (#409). */
function MediaLibraryCount({ visibleCount }: { visibleCount: number }) {
  const selectedCount = useMediaPanelStore((state) => state.selection.selectedIds.length);
  return (
    <span className="ml-auto text-text-muted">
      {selectedCount > 1 && <span className="text-text-secondary">{selectedCount} selected · </span>}
      {visibleCount} {visibleCount === 1 ? 'item' : 'items'}
    </span>
  );
}

/**
 * Selectable, keyboard-navigable media grid (upstream PR #409).
 *
 * The grid publishes its visible order and column count so arrow keys move
 * through what the user can actually see, and so a search or a delete prunes the
 * selection instead of leaving stale ids behind.
 */
function MediaGrid({ items, fps }: { items: MediaAsset[]; fps: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const publishVisibleItems = useMediaPanelStore((state) => state.publishVisibleItems);
  const moveSelection = useMediaPanelStore((state) => state.moveSelection);
  const selectAll = useMediaPanelStore((state) => state.selectAll);
  const clearSelection = useMediaPanelStore((state) => state.clearSelection);
  const deleteSelection = useMediaPanelStore((state) => state.deleteSelection);
  const consumeScrollTarget = useMediaPanelStore((state) => state.consumeScrollTarget);
  const scrollTargetId = useMediaPanelStore((state) => state.selection.scrollTargetId);
  const anchorId = useMediaPanelStore((state) => state.selection.anchorId);

  const orderedIds = useMemo(() => items.map((item) => item.id), [items]);
  const [columnCount, setColumnCount] = useState(1);

  // Track the rendered column count: arrow up/down must step by a real row.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = (containerWidth: number) => {
      const columns = Math.max(
        1,
        Math.floor((containerWidth + MEDIA_GRID_GAP) / (MEDIA_TILE_MIN_WIDTH + MEDIA_GRID_GAP)),
      );
      setColumnCount(columns);
    };
    measure(container.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) measure(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    publishVisibleItems(orderedIds, columnCount);
  }, [publishVisibleItems, orderedIds, columnCount]);

  // Scroll a keyboard-selected tile into view.
  useEffect(() => {
    if (!scrollTargetId) return;
    containerRef.current
      ?.querySelector(`[data-asset-id="${CSS.escape(scrollTargetId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
    consumeScrollTarget();
  }, [scrollTargetId, consumeScrollTarget]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          event.preventDefault();
          const direction = event.key.replace('Arrow', '').toLowerCase() as
            | 'left'
            | 'right'
            | 'up'
            | 'down';
          moveSelection(direction);
          return;
        }
        case 'a':
        case 'A':
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            selectAll();
          }
          return;
        case 'Escape':
          if (useMediaPanelStore.getState().armedSwap) {
            useMediaPanelStore.getState().cancelMediaSwap();
          }
          clearSelection();
          return;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          deleteSelection();
          return;
        default:
      }
    },
    [moveSelection, selectAll, clearSelection, deleteSelection],
  );

  return (
    <div
      ref={containerRef}
      id="media-library-listbox"
      role="listbox"
      aria-label="Media library"
      aria-multiselectable
      aria-activedescendant={anchorId ? mediaOptionId(anchorId) : undefined}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={(event) => {
        // A click on the empty area of the grid clears the selection.
        if (event.target === event.currentTarget) clearSelection();
      }}
      className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2 rounded outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
    >
      {items.map((item) => (
        <MediaCard key={item.id} item={item} fps={fps} />
      ))}
    </div>
  );
}

/**
 * Three-point placement strip (R1 source-viewer, minimal form): with one
 * video/audio asset selected, set an optional source window in seconds and
 * land it on a compatible track via insert/overwrite/append. The timeline
 * playhead is the default landing frame.
 */
function SourcePlaceStrip() {
  const project = useTimelineStore((s) => s.project);
  const controller = useTimelineStore((s) => s.controller);
  const selectedIds = useMediaPanelStore((s) => s.selection.selectedIds);
  const fps = project.settings.fps;

  const asset =
    selectedIds.length === 1
      ? project.media.find((m) => m.id === selectedIds[0])
      : undefined;
  const placeable = asset !== undefined && (asset.type === 'video' || asset.type === 'audio');
  const compatibleTracks = project.timeline.tracks.filter((t) =>
    asset ? (t.type === 'audio' ? asset.type === 'audio' : t.type === 'video') : false,
  );

  const [inSec, setInSec] = useState('0');
  const [outSec, setOutSec] = useState('');
  const [mode, setMode] = useState<'overwrite' | 'insert' | 'append'>('overwrite');
  const [trackId, setTrackId] = useState('');
  const activeTrackId = trackId || compatibleTracks[0]?.id || '';
  if (!placeable) return null;
  const maxSeconds = asset.duration > 0 ? asset.duration / fps : Infinity;
  const videoRef = useRef<HTMLVideoElement>(null);

  // Source-monitor In/Out: capture the <video> element's current playhead.
  const setInFromVideo = useCallback(() => {
    if (videoRef.current) setInSec(videoRef.current.currentTime.toFixed(2));
  }, []);
  const setOutFromVideo = useCallback(() => {
    if (!videoRef.current) return;
    let t = videoRef.current.currentTime;
    if (inSec !== '' && Number.isFinite(Number(inSec)) && t <= Number(inSec)) {
      t = Math.min(maxSeconds, Number(inSec) + 0.1);
    }
    setOutSec(t.toFixed(2));
  }, [inSec, maxSeconds]);

  function fileUrl(p: string): string {
    return encodeURI(`file:///${p.replace(/\\/g, '/')}`).replace(/#/g, '%23');
  }

  function handlePlace() {
    if (!asset || !activeTrackId) return;
    const s = parseFloat(inSec);
    const e = parseFloat(outSec);
    const hasWindow =
      Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e > s && s < maxSeconds;
    const clampedEnd = hasWindow && Number.isFinite(maxSeconds) ? Math.min(e, maxSeconds) : e;

    const placed = controller.placeClipWithMode({
      assetId: asset.id,
      trackId: activeTrackId,
      mode,
      ...(mode !== 'append'
        ? { startFrame: useTimelineStore.getState().getPlayhead() }
        : {}),
      ...(hasWindow ? { source: [s, clampedEnd] as [number, number] } : {}),
    });
    if (placed) {
      useTimelineStore.setState({ selectedClipIds: new Set(placed.clipIds) });
      useMediaPanelStore.getState().setNotice(null);
    } else {
      useMediaPanelStore.getState().setNotice('Cannot place on that track (locked or incompatible).');
    }
  }

  const inputCls = 'w-14 rounded border border-white/15 bg-surface-0 px-1 py-0.5 text-[9px] text-text-primary outline-none focus:border-accent/60';

  return (
    <div
      className="mb-2 flex flex-col gap-1.5 rounded border border-white/10 bg-surface-2 px-2 py-1.5"
      data-source-place-strip
    >
      {/* Source monitor (video assets): native playback + In/Out capture */}
      {asset?.type === 'video' && (
        <div className="flex flex-col gap-1" data-source-monitor>
          <video
            ref={videoRef}
            src={fileUrl(asset.path)}
            controls
            className="w-full rounded bg-black"
            style={{ maxHeight: 200 }}
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={setInFromVideo}
              className="rounded border border-white/15 px-2 py-0.5 text-[9px] text-text-secondary hover:bg-white/10"
              title="Set source In at the video's current position"
            >
              Set In here
            </button>
            <button
              type="button"
              onClick={setOutFromVideo}
              className="rounded border border-white/15 px-2 py-0.5 text-[9px] text-text-secondary hover:bg-white/10"
              title="Set source Out at the video's current position"
            >
              Set Out here
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[9px] font-semibold uppercase tracking-wide text-text-muted">
        Source
      </span>
      <label className="flex items-center gap-1 text-[9px] text-text-secondary">
        In
        <input value={inSec} onChange={(e) => setInSec(e.target.value)} className={inputCls} inputMode="decimal" />
      </label>
      <label className="flex items-center gap-1 text-[9px] text-text-secondary">
        Out
        <input
          value={outSec}
          onChange={(e) => setOutSec(e.target.value)}
          placeholder={Number.isFinite(maxSeconds) ? maxSeconds.toFixed(2) : '—'}
          className={inputCls}
          inputMode="decimal"
        />
      </label>
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value as typeof mode)}
        className="rounded border border-white/15 bg-surface-0 px-1 py-0.5 text-[9px] text-text-primary outline-none"
        aria-label="Placement mode"
      >
        <option value="overwrite">Overwrite</option>
        <option value="insert">Insert</option>
        <option value="append">Append</option>
      </select>
      <select
        value={activeTrackId}
        onChange={(e) => setTrackId(e.target.value)}
        className="max-w-28 rounded border border-white/15 bg-surface-0 px-1 py-0.5 text-[9px] text-text-primary outline-none"
        aria-label="Target track"
      >
        {compatibleTracks.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={handlePlace}
        className="ml-auto rounded border border-accent/50 px-2 py-0.5 text-[9px] font-medium text-text-primary hover:bg-accent/10"
      >
        Place at playhead
      </button>
      </div>
    </div>
  );
}

/**
 * Proxy decode policy toggle (R2): auto uses ready proxies for preview
 * decoding, off forces originals. Persisted in the main process.
 */
function ProxyModeToggle() {
  const [mode, setMode] = useState<'auto' | 'off'>('auto');

  useEffect(() => {
    void window.palmier.media.getProxyMode().then((res: unknown) => {
      const r = res as { mode?: 'auto' | 'off' } | undefined;
      if (r?.mode === 'auto' || r?.mode === 'off') setMode(r.mode);
    });
  }, []);

  return (
    <select
      value={mode}
      onChange={(e) => {
        const next = e.target.value as 'auto' | 'off';
        setMode(next);
        void window.palmier.media.setProxyMode(next);
      }}
      className="ml-auto rounded border border-white/15 bg-surface-0 px-1 py-0.5 text-[9px] text-text-secondary outline-none"
      aria-label="Proxy decoding"
      title="Proxy decoding: auto uses generated proxies for smoother scrubbing; off always decodes originals"
    >
      <option value="auto">Proxy: auto</option>
      <option value="off">Proxy: off</option>
    </select>
  );
}

/** One-line status for panel actions; click to dismiss. */
function PanelNotice() {  const notice = useMediaPanelStore((state) => state.notice);
  const setNotice = useMediaPanelStore((state) => state.setNotice);
  if (!notice) return null;
  return (
    <button
      type="button"
      onClick={() => setNotice(null)}
      title="Click to dismiss"
      className="mb-2 block w-full border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-left text-[10px] text-amber-200"
    >
      {notice}
    </button>
  );
}

function PanelPlaceholder({ tab }: { tab: Exclude<PanelTab, 'media'> }) {  const Icon = tab === 'captions' ? Subtitles : AudioLines;
  const title = tab === 'captions' ? 'Captions' : 'Audio';
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="panel-header flex items-center px-3 text-[11px] font-medium text-text-secondary">
        {title}
      </div>
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <Icon size={20} strokeWidth={1.5} className="mb-3 text-text-muted" />
        <p className="text-[11px] text-text-secondary">{title}</p>
      </div>
    </div>
  );
}

/**
 * Armed media swap banner (#500): names the clip waiting for a replacement
 * and how to leave the mode. The grid's tiles are the pick targets while
 * this is up.
 */
function ArmedSwapBanner() {
  const armedSwap = useMediaPanelStore((state) => state.armedSwap);
  const cancelMediaSwap = useMediaPanelStore((state) => state.cancelMediaSwap);
  const project = useTimelineStore((s) => s.project);
  if (!armedSwap) return null;
  const clip = project.timeline.clips.find((candidate) => candidate.id === armedSwap.clipId);
  return (
    <div
      className="mb-2 flex items-center gap-2 border border-accent/50 bg-accent/10 px-2 py-1.5 text-[10px] text-accent"
      data-armed-swap-banner
    >
      <span className="min-w-0 flex-1 truncate">
        Picking a replacement for{' '}
        <span className="font-semibold">{clip?.label || clip?.assetId || 'clip'}</span> — click
        media to swap, Esc to cancel
      </span>
      <button
        type="button"
        onClick={cancelMediaSwap}
        className="shrink-0 rounded border border-accent/60 px-1.5 py-0.5 text-[9px] font-medium hover:bg-accent/20"
      >
        Cancel
      </button>
    </div>
  );
}

function MediaCard({ item, fps }: { item: MediaAsset; fps: number }) {
  const TypeIcon = item.type === 'video' ? Film : item.type === 'audio' ? Music2 : ImageIcon;
  const selectItem = useMediaPanelStore((state) => state.selectItem);
  const deleteSelection = useMediaPanelStore((state) => state.deleteSelection);
  const extractAudioSelection = useMediaPanelStore((state) => state.extractAudioSelection);
  const isSelected = useMediaPanelStore((state) => state.selection.selectedIds.includes(item.id));
  const selectedIds = useMediaPanelStore((state) => state.selection.selectedIds);
  const [menuOpen, setMenuOpen] = useState(false);
  const [extracting, setExtracting] = useState(false);

  // ─── Armed swap pick mode (#500) ────────────────────────────────────────────
  const armedSwap = useMediaPanelStore((state) => state.armedSwap);
  const completeArmedSwap = useMediaPanelStore((state) => state.completeArmedSwap);
  const controller = useTimelineStore((state) => state.controller);
  const swapVerdict = useMemo(
    () => (armedSwap ? controller.canSwapClipMedia(armedSwap.clipId, item.id) : null),
    [armedSwap, controller, item.id],
  );

  const project = useTimelineStore((state) => state.project);

  const selectedCount = useMediaPanelStore((state) => state.selection.selectedIds.length);
  const deleteLabel =
    isSelected && selectedCount > 1 ? `Delete ${selectedCount} items` : 'Delete';

  // Extraction acts on the whole selection when the right-clicked tile is part
  // of it, mirroring the delete targeting rule.
  const extractTargets = useMemo(() => {
    const ids = isSelected && selectedCount > 1 ? [...selectedIds] : [item.id];
    return ids
      .map((id) => project.media.find((asset) => asset.id === id))
      .filter((asset): asset is MediaAsset => Boolean(asset))
      .filter(canExtractAudio);
  }, [isSelected, selectedCount, selectedIds, item.id, project.media]);
  const extractLabel =
    extracting
      ? 'Extracting audio…'
      : extractTargets.length > 1
        ? `Extract audio from ${extractTargets.length} items`
        : 'Extract audio';

  async function handleExtractAudio() {
    setMenuOpen(false);
    setExtracting(true);
    try {
      await extractAudioSelection(item.id);
    } finally {
      setExtracting(false);
    }
  }

  // ─── Proxies (R2) ─────────────────────────────────────────────────────────
  const isVideo = item.type === 'video';
  const hasProxy = Boolean(item.proxyPath);

  function handleGenerateProxy() {
    setMenuOpen(false);
    void window.palmier.media.generateProxy(item.id).then((res) => {
      if (res.success && (res as { started?: boolean }).started) {
        useMediaPanelStore.getState().setNotice('Proxy generation started — the badge appears when it is ready.');
      } else if (!res.success && res.error) {
        useMediaPanelStore.getState().setNotice(res.error);
      }
    });
  }

  async function handleRemoveProxy() {
    setMenuOpen(false);
    await window.palmier.media.removeProxy(item.id);
    useMediaPanelStore.getState().setNotice(null);
  }

  return (
    <div
      draggable
      data-asset-id={item.id}
      id={mediaOptionId(item.id)}
      role="option"
      aria-selected={isSelected}
      aria-label={item.filename}
      onClick={(event) => {
        // While a swap is armed, a plain click picks this asset as the
        // replacement (refusals keep the arm and surface the reason);
        // modifier clicks keep their selection semantics.
        if (armedSwap && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
          completeArmedSwap(item.id);
          return;
        }
        selectItem(item.id, selectionModeFromModifiers(event));
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        // Right-clicking outside the selection retargets it, so the menu always
        // acts on what the user pointed at.
        if (!isSelected) selectItem(item.id, 'replacing');
        setMenuOpen(true);
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData(ASSET_DND_MIME, item.id);
        event.dataTransfer.effectAllowed = 'copy';
        setDraggingAsset({ id: item.id, type: item.type });
      }}
      onDragEnd={() => setDraggingAsset(null)}
      title={
        swapVerdict
          ? swapVerdict.ok
            ? `Click to swap this media in — ${item.filename}`
            : `Not eligible: ${swapVerdict.reason}`
          : `Drag onto the timeline to add - ${item.filename}`
      }
      data-swap-eligible={armedSwap ? (swapVerdict?.ok ? 'yes' : 'no') : undefined}
      className={`group relative min-w-0 cursor-grab active:cursor-grabbing ${armedSwap && !swapVerdict?.ok ? 'opacity-40' : ''}`}
    >
      <div
        data-selected={isSelected}
        className={`relative aspect-video overflow-hidden rounded-md border border-black bg-surface-2 outline outline-1 outline-white/10 transition group-hover:outline-white/30 data-[selected=true]:outline-2 data-[selected=true]:outline-accent ${
          armedSwap && swapVerdict?.ok ? 'outline-dashed outline-accent/70' : ''
        }`}
      >
        {item.thumbnailPath ? (
          <img
            src={`file://${item.thumbnailPath}`}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-text-muted">
            <TypeIcon size={19} strokeWidth={1.4} />
          </div>
        )}
        {item.duration > 0 && (
          <span className="absolute bottom-1 right-1 rounded-sm bg-black/75 px-1 py-0.5 font-mono text-[8px] text-white/85">
            {formatDuration(item.duration, fps)}
          </span>
        )}
        {item.proxyPath && (
          <span
            className="absolute top-1 left-1 rounded-sm bg-sky-500/80 px-1 py-0.5 text-[8px] font-semibold uppercase text-white"
            title="Proxy attached — exports use the original"
            data-proxy-badge
          >
            PX
          </span>
        )}
      </div>
      <p
        data-selected={isSelected}
        className="mt-1 truncate px-0.5 text-[10px] text-text-secondary data-[selected=true]:text-text-primary"
        title={item.filename}
      >
        {item.filename}
      </p>

      {menuOpen && (
        <>
          {/* Click-away layer so the menu closes without a global listener. */}
          <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
          <div
            role="menu"
            className="absolute left-1 top-1 z-30 min-w-28 rounded border border-white/15 bg-surface-2 py-0.5 shadow-lg"
          >
            {canExtractAudio(item) && (
              <button
                role="menuitem"
                disabled={extracting}
                onClick={handleExtractAudio}
                className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10 disabled:text-text-muted"
              >
                {extractLabel}
              </button>
            )}
            {isVideo && !hasProxy && (
              <button
                role="menuitem"
                onClick={handleGenerateProxy}
                className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
              >
                Generate proxy
              </button>
            )}
            {isVideo && hasProxy && (
              <button
                role="menuitem"
                onClick={handleRemoveProxy}
                className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
              >
                Remove proxy (use original)
              </button>
            )}
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                deleteSelection(item.id);
              }}
              className="block w-full px-2 py-1 text-left text-[10px] text-red-300 hover:bg-white/10"
            >
              {deleteLabel}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
