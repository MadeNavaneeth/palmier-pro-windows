import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownUp,
  AudioLines,
  FileInput,
  Film,
  Flag,
  Folder,
  Grid2X2,
  Image as ImageIcon,
  ListFilter,
  Loader2,
  MoreHorizontal,
  Music2,
  Plus,
  Search,
  Sparkles,
  Subtitles,
  Upload,
} from 'lucide-react';
import { useProjectStore } from '../store/project';
import { useTimelineStore } from '../store/timeline';
import { canExtractAudio, useMediaPanelStore } from '../store/media-panel';
import { MarkerIndexBrowser } from './timeline/MarkerIndexBrowser';
import { deriveTags } from '../../shared/media/tags';
import {
  MEDIA_FOLDER_NAME_MAX_LENGTH,
  filterLibraryAssets,
  folderAssetCount,
} from '../../shared/media/folders';
import { selectionModeFromModifiers } from '../../shared/media-panel/selection';
import type { MediaAsset, MediaFolder } from '../../shared/types/project';
import { formatImportErrors } from '../../shared/media/import-summary';
import { formatDuration } from '../../shared/utils/time';
import { ASSET_DND_MIME, getDroppedFilePath, setDraggingAsset } from '../lib/dnd';
import { GenerateDialog } from './GenerateDialog';
import { applyFcpxmlPlan } from '../../shared/fcpxml/apply';
import { applyCaptionCues } from '../../shared/captions/apply';
import {
  CAPTION_PLAN_LIMITS,
  normalizeCaptionPlanOptions,
  type CaptionPlanOptions,
} from '../../shared/captions/planner';
import { WHISPER_LANGUAGES } from '../../shared/stt/languages';

/** Minimum tile width in the media grid; must match the grid template below. */
const MEDIA_TILE_MIN_WIDTH = 112;
const MEDIA_GRID_GAP = 8;

/** Stable DOM id for a media tile, used for aria-activedescendant. */
function mediaOptionId(assetId: string): string {
  return `media-option-${assetId}`;
}

type PanelTab = 'media' | 'markers' | 'captions' | 'audio';

const panelTabs = [
  { id: 'media' as const, label: 'Media', Icon: Folder },
  { id: 'markers' as const, label: 'Markers', Icon: Flag },
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
  const [importNotes, setImportNotes] = useState<string[]>([]);
  const [generateOpen, setGenerateOpen] = useState(false);

  // Folder layer (#156): which folder scopes the grid; null = library root
  // (unfiled). A folder id that no longer exists (deleted, or undone while a
  // rename/delete was pending) falls back to root instead of stranding the
  // view on a filter that can never match.
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const folders = project.mediaFolders ?? [];
  const activeFolderId = folders.some((folder) => folder.id === selectedFolderId)
    ? selectedFolderId
    : null;

  const mediaItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return filterLibraryAssets(project.media, normalized, activeFolderId);
  }, [project.media, query, activeFolderId]);

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

  /** FCPXML import (#154): main parses+probes; we materialize the plan. */
  const handleImportXml = useCallback(async () => {
    setImportError('');
    setImportNotes([]);
    const res = await window.palmier.media.openFcpxml() as {
      success: boolean;
      canceled?: boolean;
      error?: string;
      plan?: Parameters<typeof applyFcpxmlPlan>[1];
      assets?: Array<{
        path: string;
        assetId: string | null;
        probe: MediaAsset | null;
      }>;
    };
    if (!res.success || !res.plan) {
      if (!res.canceled) setImportError(res.error || 'Could not import the XML file.');
      return;
    }

    // Register probed assets first so the applier can resolve paths→ids.
    const assetIdByPath = new Map<string, string>();
    const dimsByPath = new Map<string, { width?: number; height?: number }>();
    for (const entry of res.assets ?? []) {
      if (entry.assetId && entry.probe) {
        const id = `fcpxml-${entry.assetId}`;
        useTimelineStore.getState().controller.addMedia({
          ...entry.probe,
          id,
          addedAt: new Date().toISOString(),
        });
        assetIdByPath.set(entry.path, id);
        dimsByPath.set(entry.path, { width: entry.probe.width, height: entry.probe.height });
      }
    }

    const result = applyFcpxmlPlan(
      useTimelineStore.getState().controller,
      res.plan,
      assetIdByPath,
      dimsByPath,
    );
    useProjectStore.getState().markDirty();
    const skipped = (res.assets ?? []).filter((a) => !a.assetId).length;
    const parts = [`${result.placedClips} clips`, `${result.titles} titles`, `${result.tracksCreated} tracks`];
    if (skipped > 0) parts.push(`${skipped} offline`);
    // Reuse the notice banner as the outcome surface; success clears itself.
    setImportError(`Imported: ${parts.join(', ')}.`);
    // What the document carried that this editor cannot place, in the
    // importer's own words. Read after the apply because the applier adds its
    // own refusals to the same list.
    setImportNotes(res.plan.unsupported);
  }, []);

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
            <button
              onClick={() => setGenerateOpen(true)}
              className="icon-button"
              title="AI Generate media"
              aria-label="AI Generate media"
              data-generate-open
            >
              <Sparkles size={14} strokeWidth={1.7} />
            </button>
            <button
              onClick={handleImportXml}
              className="icon-button"
              title="Import Final Cut XML"
              aria-label="Import Final Cut XML"
              data-import-xml
            >
              <FileInput size={14} strokeWidth={1.7} />
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

          {/* Folder layer (#156): root + named folders scope the grid below;
              search stays global. */}
          <FolderLayer activeFolderId={activeFolderId} onSelect={setSelectedFolderId} />

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
            <FcpxmlImportNotes notes={importNotes} />
            <PanelNotice />
            <ArmedSwapBanner />
            {mediaItems.length === 0 ? (
              <div className="flex h-full min-h-44 flex-col items-center justify-center px-5 text-center">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-surface-2 text-text-muted">
                  <Upload size={18} strokeWidth={1.5} />
                </div>
                <p className="text-[11px] font-medium text-text-secondary">
                  {query
                    ? 'No matching media'
                    : activeFolderId === null
                      ? 'Import media to begin'
                      : 'No media in this folder'}
                </p>
                {!query && activeFolderId === null && (
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

          {generateOpen && (
            <GenerateDialog
              projectFps={fps}
              onClose={() => setGenerateOpen(false)}
              onImported={(asset) => {
                controller.importMediaAssets([asset]);
                useProjectStore.getState().markDirty();
              }}
            />
          )}
        </div>
        ) : activeTab === 'markers' ? (
        <MarkerIndexBrowser />
      ) : activeTab === 'captions' ? (
        <CaptionsPanel />
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
 * Folder layer for the media library (#156): a chip row of the library root
 * ("Unfiled") plus each named folder with its `folderAssetCount`. Clicking a
 * chip scopes the grid (a search still matches globally across folders);
 * right-clicking one opens the same menu vocabulary the bin's tiles use, and
 * rename runs inline the way a track header renames. Delete confirms in the
 * standard dialog shell — the bin has no confirm for media delete, so a
 * destructive organization action gets an explicit refuse-with-confirm here
 * (media itself is never deleted; members fall back to the root).
 */
function FolderLayer({
  activeFolderId,
  onSelect,
}: {
  activeFolderId: string | null;
  onSelect: (folderId: string | null) => void;
}) {
  const project = useTimelineStore((s) => s.project);
  const controller = useTimelineStore((s) => s.controller);
  const folders = project.mediaFolders ?? [];
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MediaFolder | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!creating && renamingId === null) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [creating, renamingId]);

  const notice = (message: string) => useMediaPanelStore.getState().setNotice(message);

  const startCreate = () => {
    setRenamingId(null);
    setDraft('');
    setCreating(true);
  };

  const startRename = (folder: MediaFolder) => {
    setCreating(false);
    setDraft(folder.name);
    setRenamingId(folder.id);
  };

  const commitCreate = () => {
    if (!creating) return;
    const name = draft.trim();
    setCreating(false);
    if (name.length === 0) return;
    try {
      controller.createMediaFolder(name);
      useProjectStore.getState().markDirty();
    } catch (err) {
      notice(err instanceof Error ? err.message : String(err));
    }
  };

  const commitRename = () => {
    if (renamingId === null) return;
    const folder = folders.find((candidate) => candidate.id === renamingId);
    setRenamingId(null);
    if (!folder) return;
    const name = draft.trim();
    // An identical name is a controller no-op; skip markDirty so a pure view
    // commit does not flag the project unsaved.
    if (name.length === 0 || name === folder.name) return;
    try {
      controller.renameMediaFolder(folder.id, name);
      useProjectStore.getState().markDirty();
    } catch (err) {
      notice(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmDelete = () => {
    const folder = pendingDelete;
    setPendingDelete(null);
    if (!folder) return;
    try {
      const result = controller.deleteMediaFolder(folder.id);
      useProjectStore.getState().markDirty();
      if (result.movedAssetIds.length > 0) {
        const count = result.movedAssetIds.length;
        notice(
          `Folder deleted — ${count} item${count === 1 ? '' : 's'} moved to the library root.`,
        );
      }
    } catch (err) {
      notice(err instanceof Error ? err.message : String(err));
    }
  };

  const chipCls = (active: boolean) =>
    `flex h-5 items-center gap-1 rounded-md border px-1.5 text-[10px] font-medium outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
      active
        ? 'border-accent bg-accent/10 text-text-primary'
        : 'border-white/15 text-text-secondary hover:bg-white/[0.08] hover:text-text-primary'
    }`;

  const rootCount = folderAssetCount(project, undefined);
  const pendingDeleteCount = pendingDelete ? folderAssetCount(project, pendingDelete.id) : 0;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 px-2 py-1" data-folder-layer>
      <button
        type="button"
        onClick={() => onSelect(null)}
        aria-pressed={activeFolderId === null}
        className={chipCls(activeFolderId === null)}
        title={`Library root — ${rootCount} item${rootCount === 1 ? '' : 's'} not in a folder`}
      >
        Unfiled
        <span className="tabular-nums text-text-muted">{rootCount}</span>
      </button>

      {folders.map((folder) => {
        const count = folderAssetCount(project, folder.id);
        const renaming = renamingId === folder.id;
        return (
          <div key={folder.id} className="relative">
            {renaming ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitRename();
                  if (event.key === 'Escape') setRenamingId(null);
                }}
                maxLength={MEDIA_FOLDER_NAME_MAX_LENGTH}
                aria-label={`Rename folder ${folder.name}`}
                className="h-5 w-32 rounded-md border border-accent/60 bg-surface-0 px-1.5 text-[10px] text-text-primary outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => onSelect(folder.id)}
                onDoubleClick={() => startRename(folder)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenuId(folder.id);
                }}
                aria-pressed={activeFolderId === folder.id}
                className={chipCls(activeFolderId === folder.id)}
                title={`${folder.name} — ${count} item${count === 1 ? '' : 's'} · double-click to rename`}
              >
                <Folder size={11} strokeWidth={1.7} className="shrink-0" />
                <span className="max-w-28 truncate">{folder.name}</span>
                <span className="tabular-nums text-text-muted">{count}</span>
              </button>
            )}
            {menuId === folder.id && (
              <>
                {/* Click-away layer so the menu closes without a global listener. */}
                <div className="fixed inset-0 z-20" onClick={() => setMenuId(null)} />
                <div
                  role="menu"
                  className="absolute left-0 top-full z-30 mt-0.5 min-w-32 rounded border border-white/15 bg-surface-2 py-0.5 shadow-lg"
                >
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuId(null);
                      startRename(folder);
                    }}
                    className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
                  >
                    Rename
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuId(null);
                      setPendingDelete(folder);
                    }}
                    className="block w-full px-2 py-1 text-left text-[10px] text-red-300 hover:bg-red-500/10"
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}

      {creating ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitCreate}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitCreate();
            if (event.key === 'Escape') setCreating(false);
          }}
          maxLength={MEDIA_FOLDER_NAME_MAX_LENGTH}
          placeholder="Folder name"
          aria-label="New folder name"
          className="h-5 w-32 rounded-md border border-accent/60 bg-surface-0 px-1.5 text-[10px] text-text-primary outline-none placeholder:text-text-muted"
        />
      ) : (
        <button
          type="button"
          onClick={startCreate}
          className={chipCls(false) + ' w-8 justify-center'}
          title="New folder"
          aria-label="New folder"
        >
          <Plus size={11} strokeWidth={1.8} />
        </button>
      )}

      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="folder-delete-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setPendingDelete(null);
            }}
            className="w-[340px] rounded-lg border border-surface-3 bg-surface-1 shadow-2xl"
          >
            <div className="border-b border-white/10 px-4 py-3">
              <h2 id="folder-delete-title" className="text-sm font-medium text-text-primary">
                Delete “{pendingDelete.name}”?
              </h2>
            </div>
            <div className="px-4 py-3 text-[11px] leading-5 text-text-secondary">
              {pendingDeleteCount > 0
                ? `${pendingDeleteCount} item${pendingDeleteCount === 1 ? '' : 's'} move to the library root — media in the library is never deleted.`
                : 'This folder is empty.'}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-white/10 px-4 py-3">
              <button
                type="button"
                autoFocus
                onClick={() => setPendingDelete(null)}
                className="rounded px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                className="rounded border border-red-500/50 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
              >
                Delete folder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
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
        case 'ContextMenu': {
          // Keyboard route into the same context menu a right-click opens,
          // anchored on the keyboard selection (aria-activedescendant).
          if (!anchorId) return;
          event.preventDefault();
          document
            .getElementById(mediaOptionId(anchorId))
            ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
          return;
        }
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

/**
 * FCPXML import omissions (#154): the plan's own sentences for what the
 * document carried but this editor cannot place — a refused timeMap, a rate
 * that maps to no frames, a skipped effect. The counts line reports only what
 * arrived, so a document refused wholesale reads as "0 clips" with no reason
 * given; these notes are that reason.
 *
 * Amber like the panel's other notices and like the export dialog's XML
 * omission box, never red: the import ran, and this is what it left out. The
 * list is capped with its own scrollbar (the ChatPanel idiom) so a document
 * that accumulates notes cannot push the library off the panel, and no note is
 * dropped to make room.
 */
export function FcpxmlImportNotes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <div
      data-import-xml-notes
      className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber-300"
    >
      <p>{`Not imported (${notes.length}):`}</p>
      <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto break-words pr-0.5">
        {notes.map((note, index) => (
          <li key={index}>{note}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Captions tab (#39/#91): transcribe a library audio/video asset over the
 * BYOK whisper-compatible runtime and materialize the planned cues as title
 * clips on one fresh track.
 */
const CAPTION_PLAN_STORAGE_KEY = 'palmier.captions.plan';

/** Persisted caption controls (#91), narrowed on read like every UI key. */
function loadCaptionPlan(): Partial<CaptionPlanOptions> {
  try {
    const raw = window.localStorage?.getItem(CAPTION_PLAN_STORAGE_KEY);
    if (!raw) return {};
    return normalizeCaptionPlanOptions(JSON.parse(raw) as Partial<CaptionPlanOptions>);
  } catch {
    return {};
  }
}

function saveCaptionPlan(plan: Partial<CaptionPlanOptions>): void {
  try {
    window.localStorage?.setItem(CAPTION_PLAN_STORAGE_KEY, JSON.stringify(plan));
  } catch {
    // A full or unavailable storage quota must not break the controls.
  }
}

type SttEngineChoice = 'auto' | 'local' | 'custom' | 'cloud';

interface LocalModelStatus {
  id: string;
  sizeLabel: string;
  approxBytes: number;
  downloaded: boolean;
  bytesOnDisk: number;
}

interface LocalSttStatus {
  arch: string;
  binary: {
    present: boolean;
    path: string | null;
    source: 'override' | 'user-data' | 'path' | null;
    missingOverride: boolean;
    download: { url: string; bytes: number; sizeLabel: string; sha256: string } | null;
  };
  models: LocalModelStatus[];
  storage: { usedBytes: number; capBytes: number };
}

function CaptionsPanel() {
  const project = useTimelineStore((s) => s.project);
  const controller = useTimelineStore((s) => s.controller);
  const candidates = project.media.filter(
    (m) => m.type === 'audio' || (m.type === 'video' && Boolean(m.audioCodec)),
  );
  const [assetId, setAssetId] = useState('');
  const [language, setLanguage] = useState('');
  const [model, setModel] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [serverKey, setServerKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);

  // Transcription engine (#39 local half): persisted like the server fields,
  // so the agent and the UI resolve the same engine through the same config.
  const [engine, setEngine] = useState<SttEngineChoice>('auto');
  const [localModel, setLocalModel] = useState('base');
  const [localBinaryPath, setLocalBinaryPath] = useState('');
  const [sttStatus, setSttStatus] = useState<LocalSttStatus | null>(null);
  const [downloading, setDownloading] = useState<{
    kind: 'model' | 'binary'; modelId?: string;
    receivedBytes: number; totalBytes: number | null; ratio: number | null;
  } | null>(null);
  const [runProgress, setRunProgress] = useState<{
    completedSec: number; totalSec: number | null; ratio: number | null;
  } | null>(null);

  const refreshLocalStatus = useCallback(async () => {
    try {
      const res = await window.palmier.media.getLocalSttStatus() as {
        success: boolean;
        status?: LocalSttStatus;
        config?: { engine?: SttEngineChoice; localModel?: string; localBinaryPath?: string };
      };
      if (res.success && res.status) setSttStatus(res.status);
      if (res.success && res.config) {
        if (res.config.engine) setEngine(res.config.engine);
        if (res.config.localModel) setLocalModel(res.config.localModel);
        if (typeof res.config.localBinaryPath === 'string') setLocalBinaryPath(res.config.localBinaryPath);
      }
    } catch {
      // Status is best-effort; transcription still reports real errors.
    }
  }, []);

  // Local download + run progress stream on events while the invokes pend.
  useEffect(() => {
    const offProgress = window.palmier.on('local-stt:progress', (payload: unknown) => {
      const p = payload as { receivedBytes: number; totalBytes: number | null; ratio: number | null; modelId?: string };
      setDownloading((current) => current ? { ...current, ...p } : current);
    });
    const offRun = window.palmier.on('transcribe:progress', (payload: unknown) => {
      const p = payload as { completedSec: number; totalSec: number | null; ratio: number | null };
      setRunProgress(p);
    });
    return () => { offProgress(); offRun(); };
  }, []);

  // Caption planning controls (#91). Persisted like the panel layout keys,
  // and narrowed on read so a stale/foreign value falls back to the
  // broadcast defaults rather than feeding the packing math.
  const [plan, setPlan] = useState(() => loadCaptionPlan());
  useEffect(() => {
    saveCaptionPlan(plan);
  }, [plan]);

  // Load any persisted custom server (#287) + engine choice once.
  useEffect(() => {
    void window.palmier.media.getTranscribeConfig().then((res) => {
      const cfg = (res as {
        config?: {
          baseUrl?: string; model?: string; engine?: SttEngineChoice;
          localModel?: string; localBinaryPath?: string;
        };
      }).config;
      if (cfg?.baseUrl) setServerUrl(cfg.baseUrl);
      if (cfg?.model) setModel((current) => current || cfg.model!);
      if (cfg?.engine) setEngine(cfg.engine);
      if (cfg?.localModel) setLocalModel(cfg.localModel);
      if (typeof cfg?.localBinaryPath === 'string') setLocalBinaryPath(cfg.localBinaryPath);
    }).catch(() => {});
    void refreshLocalStatus();
  }, [refreshLocalStatus]);

  const persistEngine = useCallback((next: SttEngineChoice) => {
    setEngine(next);
    void window.palmier.media.setTranscribeConfig({ engine: next }).catch(() => {});
  }, []);

  const persistLocalModel = useCallback((next: string) => {
    setLocalModel(next);
    void window.palmier.media.setTranscribeConfig({ localModel: next }).catch(() => {});
  }, []);

  const downloadModel = useCallback(async (modelId: string) => {
    setDownloading({ kind: 'model', modelId, receivedBytes: 0, totalBytes: null, ratio: null });
    setNotice(null);
    try {
      const res = await window.palmier.media.downloadLocalModel(modelId) as {
        success: boolean; error?: string;
      };
      if (!res.success) setNotice({ kind: 'error', message: res.error ?? 'Model download failed.' });
    } catch (err) {
      setNotice({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setDownloading(null);
      void refreshLocalStatus();
    }
  }, [refreshLocalStatus]);

  const downloadBinary = useCallback(async () => {
    setDownloading({ kind: 'binary', receivedBytes: 0, totalBytes: null, ratio: null });
    setNotice(null);
    try {
      const res = await window.palmier.media.downloadLocalBinary() as {
        success: boolean; error?: string;
      };
      if (!res.success) setNotice({ kind: 'error', message: res.error ?? 'Binary download failed.' });
    } catch (err) {
      setNotice({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setDownloading(null);
      void refreshLocalStatus();
    }
  }, [refreshLocalStatus]);

  const removeModel = useCallback(async (modelId: string) => {
    try {
      await window.palmier.media.deleteLocalModel(modelId);
    } catch {
      // Removal is best-effort; the refreshed status shows the truth.
    } finally {
      void refreshLocalStatus();
    }
  }, [refreshLocalStatus]);

  const activeId = candidates.some((c) => c.id === assetId) ? assetId : candidates[0]?.id ?? '';
  const activeAsset = candidates.find((c) => c.id === activeId);
  const showLocal = engine === 'auto' || engine === 'local';
  const showServer = engine !== 'local';
  const activeModelStatus = sttStatus?.models.find((m) => m.id === localModel);

  const run = useCallback(async () => {
    if (!activeAsset) return;
    setBusy(true);
    setNotice(null);
    setRunProgress(null);
    try {
      // A custom server (#287) persists before the run so main routes there.
      if (showServer && serverUrl.trim()) {
        await window.palmier.media.setTranscribeConfig({
          baseUrl: serverUrl.trim(),
          ...(serverKey.trim() ? { apiKey: serverKey.trim() } : {}),
        });
      }
      const res = await window.palmier.media.transcribe({
        path: activeAsset.path,
        language: language.trim() || undefined,
        model: model.trim() || undefined,
        engine,
        plan,
      }) as {
        success: boolean; error?: string; engine?: string;
        cues?: Array<{ startSec: number; endSec: number; text: string }>;
        words?: number;
      };
      if (!res.success) {
        setNotice({ kind: 'error', message: res.error ?? 'Transcription failed.' });
        return;
      }
      if (!res.cues || res.cues.length === 0) {
        setNotice({ kind: 'error', message: 'No speech detected in that asset.' });
        return;
      }
      const applied = applyCaptionCues(controller, res.cues, { assetId: activeAsset.id });
      useProjectStore.getState().markDirty();
      setNotice({
        kind: 'ok',
        message: `Placed ${applied.count} caption clips on a new track${res.engine === 'local' ? ' (offline)' : ''}.`,
      });
    } catch (err) {
      setNotice({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      setRunProgress(null);
    }
  }, [activeAsset, controller, language, model, engine, serverUrl, serverKey, plan, showServer]);

  const cancelRun = useCallback(() => {
    void window.palmier.media.cancelTranscribe().catch(() => {});
  }, []);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="panel-header flex items-center px-3 text-[11px] font-medium text-text-secondary">
        Captions
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3" data-captions-panel>
        {candidates.length === 0 ? (
          <p className="text-[11px] text-text-muted">
            Add an audio or video asset to the library first.
          </p>
        ) : (
          <>
            <Field label="Asset">
              <select
                value={activeId}
                onChange={(event) => setAssetId(event.target.value)}
                disabled={busy}
                className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-[11px] text-text-primary focus:border-accent focus:outline-none"
              >
                {candidates.map((c) => (
                  <option key={c.id} value={c.id} className="bg-surface-2">{c.filename}</option>
                ))}
              </select>
            </Field>
            <Field label="Engine">
              <select
                value={engine}
                onChange={(event) => persistEngine(event.target.value as SttEngineChoice)}
                disabled={busy}
                data-stt-engine
                className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-[11px] text-text-primary focus:border-accent focus:outline-none"
              >
                <option value="auto" className="bg-surface-2">Auto (local when ready)</option>
                <option value="local" className="bg-surface-2">Local — offline</option>
                <option value="custom" className="bg-surface-2">Custom server</option>
                <option value="cloud" className="bg-surface-2">Cloud (BYOK)</option>
              </select>
            </Field>
            {showLocal && (
              <>
                <Field label="Local model">
                  <select
                    value={localModel}
                    onChange={(event) => persistLocalModel(event.target.value)}
                    disabled={busy || downloading !== null}
                    data-stt-local-model
                    className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-primary focus:border-accent focus:outline-none"
                  >
                    {(sttStatus?.models ?? [{ id: 'base', sizeLabel: '142 MB', downloaded: false }]).map((m) => (
                      <option key={m.id} value={m.id} className="bg-surface-2">
                        {`${m.id} — ${m.sizeLabel}${m.downloaded ? ' (downloaded)' : ''}`}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="flex items-center gap-2 text-[10px] text-text-muted" data-stt-local-state>
                  <span className="min-w-0 flex-1 truncate">
                    {sttStatus == null && 'Checking local engine…'}
                    {sttStatus != null && !sttStatus.binary.present && 'Local binary missing.'}
                    {sttStatus != null && sttStatus.binary.present && !(activeModelStatus?.downloaded ?? false)
                      && `Binary ready — model "${localModel}" not downloaded.`}
                    {sttStatus != null && sttStatus.binary.present && (activeModelStatus?.downloaded ?? false)
                      && `Ready offline (${localModel}).`}
                  </span>
                  {sttStatus != null && !sttStatus.binary.present && sttStatus.binary.download && (
                    <button
                      type="button"
                      onClick={() => void downloadBinary()}
                      disabled={busy || downloading !== null}
                      data-stt-download-binary
                      className="shrink-0 rounded border border-surface-3 px-1.5 py-0.5 font-medium text-text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {downloading?.kind === 'binary' ? 'Downloading…' : `Download binary (${sttStatus.binary.download.sizeLabel})`}
                    </button>
                  )}
                  {sttStatus != null && sttStatus.binary.present && !(activeModelStatus?.downloaded ?? false) && (
                    <button
                      type="button"
                      onClick={() => void downloadModel(localModel)}
                      disabled={busy || downloading !== null}
                      data-stt-download-model
                      className="shrink-0 rounded border border-surface-3 px-1.5 py-0.5 font-medium text-text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {downloading?.kind === 'model' ? 'Downloading…' : `Download (${activeModelStatus?.sizeLabel ?? ''})`}
                    </button>
                  )}
                  {sttStatus != null && (activeModelStatus?.downloaded ?? false) && (
                    <button
                      type="button"
                      onClick={() => void removeModel(localModel)}
                      disabled={busy || downloading !== null}
                      className="shrink-0 rounded border border-surface-3 px-1.5 py-0.5 font-medium text-text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Remove
                    </button>
                  )}
                </div>
                {downloading !== null && (
                  <div className="flex items-center gap-2" data-stt-download-progress>
                    <div className="h-1 min-w-0 flex-1 overflow-hidden rounded bg-surface-3">
                      <div
                        className="h-full rounded bg-accent transition-[width]"
                        style={{ width: `${Math.round((downloading.ratio ?? 0) * 100)}%` }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void window.palmier.media.cancelLocalDownload().catch(() => {})}
                      className="shrink-0 rounded border border-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-text-secondary hover:bg-surface-2"
                    >
                      Cancel
                    </button>
                  </div>
                )}
                {sttStatus != null && !sttStatus.binary.present && !sttStatus.binary.download && (
                  <Field label="Custom binary path (no prebuilt binary for this CPU)">
                    <input
                      value={localBinaryPath}
                      onChange={(event) => setLocalBinaryPath(event.target.value)}
                      onBlur={() => {
                        void window.palmier.media.setTranscribeConfig({ localBinaryPath }).catch(() => {});
                        void refreshLocalStatus();
                      }}
                      placeholder="C:\tools\whisper-cli.exe"
                      maxLength={512}
                      disabled={busy}
                      className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                    />
                  </Field>
                )}
              </>
            )}
            <Field label="Language">
              <select
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                disabled={busy}
                className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-[11px] text-text-primary focus:border-accent focus:outline-none"
              >
                <option value="" className="bg-surface-2">Auto-detect</option>
                {WHISPER_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code} className="bg-surface-2">{`${l.name} (${l.code})`}</option>
                ))}
              </select>
            </Field>
            {showServer && (
              <>
                <Field label="Custom server (optional, #287)">
                  <input
                    value={serverUrl}
                    onChange={(event) => setServerUrl(event.target.value)}
                    placeholder="http://localhost:8080/v1"
                    maxLength={200}
                    disabled={busy}
                    data-stt-server-url
                    className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                  />
                </Field>
                <Field label="Server API key (optional)">
                  <input
                    type="password"
                    value={serverKey}
                    onChange={(event) => setServerKey(event.target.value)}
                    placeholder="Paste key if the server needs one"
                    disabled={busy}
                    data-stt-server-key
                    className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                  />
                </Field>
              </>
            )}
            <Field label="Model (optional)">
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="whisper-1"
                maxLength={64}
                disabled={busy}
                className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </Field>
            <div className="flex items-end gap-2" data-caption-plan>
              <div className="flex-1">
                <Field label="Words / caption">
                  <input
                    type="number"
                    min={CAPTION_PLAN_LIMITS.maxWordsPerCue.min}
                    max={CAPTION_PLAN_LIMITS.maxWordsPerCue.max}
                    value={plan.maxWordsPerCue ?? ''}
                    placeholder="auto"
                    disabled={busy}
                    onChange={(event) => setPlan((current) => ({
                      ...current,
                      maxWordsPerCue: event.target.value === '' ? undefined : Number(event.target.value),
                    }))}
                    className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-[11px] tabular-nums text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                  />
                </Field>
              </div>
              <div className="flex-1">
                <Field label="Chars / line">
                  <input
                    type="number"
                    min={CAPTION_PLAN_LIMITS.maxCharsPerLine.min}
                    max={CAPTION_PLAN_LIMITS.maxCharsPerLine.max}
                    value={plan.maxCharsPerLine ?? ''}
                    placeholder="42"
                    disabled={busy}
                    onChange={(event) => setPlan((current) => ({
                      ...current,
                      maxCharsPerLine: event.target.value === '' ? undefined : Number(event.target.value),
                    }))}
                    className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-[11px] tabular-nums text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                  />
                </Field>
              </div>
              <div className="flex-1">
                <Field label="Lines">
                  <input
                    type="number"
                    min={CAPTION_PLAN_LIMITS.maxLines.min}
                    max={CAPTION_PLAN_LIMITS.maxLines.max}
                    value={plan.maxLines ?? ''}
                    placeholder="2"
                    disabled={busy}
                    onChange={(event) => setPlan((current) => ({
                      ...current,
                      maxLines: event.target.value === '' ? undefined : Number(event.target.value),
                    }))}
                    className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-[11px] tabular-nums text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                  />
                </Field>
              </div>
            </div>
            {runProgress !== null && runProgress.ratio !== null && (
              <div className="flex items-center gap-2" data-transcribe-progress>
                <div className="h-1 min-w-0 flex-1 overflow-hidden rounded bg-surface-3">
                  <div
                    className="h-full rounded bg-accent transition-[width]"
                    style={{ width: `${Math.round(runProgress.ratio * 100)}%` }}
                  />
                </div>
                <span className="shrink-0 text-[10px] tabular-nums text-text-muted">
                  {`${Math.round(runProgress.ratio * 100)}%`}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={() => void run()}
                disabled={busy || !activeId}
                data-transcribe-run
                className="flex flex-1 items-center justify-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                {busy ? 'Transcribing…' : 'Generate captions'}
              </button>
              {busy && (
                <button
                  type="button"
                  onClick={cancelRun}
                  data-transcribe-cancel
                  className="shrink-0 rounded border border-surface-3 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-2"
                >
                  Cancel
                </button>
              )}
            </div>
            {notice && (
              <p
                role="status"
                className={`rounded px-2 py-1.5 text-[10px] ${
                  notice.kind === 'ok'
                    ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border border-red-500/30 bg-red-500/10 text-red-400'
                }`}
              >
                {notice.message}
              </p>
            )}
          </>
        )}
      </div>
    </div>
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
  const [moveMode, setMoveMode] = useState(false);
  const [extracting, setExtracting] = useState(false);
  // ─── AI description (#118 AI half, explicit only) ──────────────────────
  const [describing, setDescribing] = useState(false);
  const [describeError, setDescribeError] = useState('');
  const [visionLabel, setVisionLabel] = useState('');
  useEffect(() => {
    if (!menuOpen || visionLabel) return;
    void window.palmier.ai.getProviders().then((res) => {
      const list = res as Array<{ name?: string; hasKey?: boolean; model?: string }> | undefined;
      const usable = Array.isArray(list) ? list.find((p) => p.hasKey && p.model) : undefined;
      if (usable?.name && usable?.model) setVisionLabel(`${usable.name} / ${usable.model}`);
    }).catch(() => {});
  }, [menuOpen, visionLabel]);

  async function handleDescribe() {
    if (describing || item.type === 'audio') return;
    setDescribing(true);
    setDescribeError('');
    try {
      const res = await window.palmier.media.describe({
        assetId: item.id,
        assetPath: item.path,
        assetType: item.type,
        ...(item.thumbnailPath ? { thumbnailPath: item.thumbnailPath } : {}),
        ...(typeof item.width === 'number' ? { assetWidth: item.width } : {}),
        ...(typeof item.height === 'number' ? { assetHeight: item.height } : {}),
      }) as { success: boolean; description?: string; provider?: string; model?: string; error?: string };
      if (!res.success || typeof res.description !== 'string') {
        setDescribeError(res.error ?? 'Description failed.');
        return;
      }
      controller.setAssetDescription(item.id, res.description);
      useProjectStore.getState().markDirty();
      setMenuOpen(false);
      useMediaPanelStore.getState().setNotice(
        res.provider && res.model
          ? `Described with ${res.provider} / ${res.model} — billed to your key.`
          : 'Description saved.',
      );
    } catch (err) {
      setDescribeError(err instanceof Error ? err.message : String(err));
    } finally {
      setDescribing(false);
    }
  }

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

  // ─── Move to folder (#156) ───────────────────────────────────────────────
  // One menu action = one controller call: moveAssetsToFolder owns the undo
  // granularity for the whole targeted set, the same way deleteSelection does.
  const folders = project.mediaFolders ?? [];
  const moveTargetIds = useMemo(() => {
    const ids = isSelected && selectedCount > 1 ? [...selectedIds] : [item.id];
    return ids.filter((id) => project.media.some((asset) => asset.id === id));
  }, [isSelected, selectedCount, selectedIds, item.id, project.media]);

  const targetsAllIn = (folderId: string | null): boolean =>
    moveTargetIds.every((id) => {
      const asset = project.media.find((candidate) => candidate.id === id);
      return asset !== undefined && (asset.folderId ?? null) === folderId;
    });

  function handleMove(folderId: string | null) {
    setMenuOpen(false);
    setMoveMode(false);
    try {
      const result = controller.moveAssetsToFolder(moveTargetIds, folderId);
      if (result.movedAssetIds.length === 0) return;
      useProjectStore.getState().markDirty();
      const destination =
        folderId === null
          ? 'the library root'
          : `“${folders.find((folder) => folder.id === folderId)?.name ?? ''}”`;
      const count = result.movedAssetIds.length;
      useMediaPanelStore
        .getState()
        .setNotice(`Moved ${count} item${count === 1 ? '' : 's'} to ${destination}.`);
    } catch (err) {
      useMediaPanelStore.getState().setNotice(err instanceof Error ? err.message : String(err));
    }
  }

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
        setMoveMode(false);
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
            + (item.startTimecode ? ` · TC ${item.startTimecode}` : '')
            + (item.aiDescription ? ` · ${item.aiDescription}` : '')
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
      {/* Free on-device labels (#118) — small, low-contrast, additive to search. */}
      <MediaTags asset={item} />

      {menuOpen && (
        <>
          {/* Click-away layer so the menu closes without a global listener. */}
          <div
            className="fixed inset-0 z-20"
            onClick={() => {
              setMenuOpen(false);
              setMoveMode(false);
            }}
          />
          <div
            role="menu"
            className="absolute left-1 top-1 z-30 min-w-28 rounded border border-white/15 bg-surface-2 py-0.5 shadow-lg"
          >
            {folders.length > 0 && !moveMode && (
              <button
                role="menuitem"
                onClick={() => setMoveMode(true)}
                className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
              >
                Move to folder
              </button>
            )}
            {moveMode && (
              <>
                <p className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-text-muted">
                  Move {moveTargetIds.length > 1 ? `${moveTargetIds.length} items` : 'item'} to
                </p>
                <button
                  role="menuitem"
                  disabled={targetsAllIn(null)}
                  onClick={() => handleMove(null)}
                  className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10 disabled:cursor-default disabled:text-text-muted disabled:hover:bg-transparent"
                >
                  Library root
                </button>
                {folders.map((folder) => (
                  <button
                    key={folder.id}
                    role="menuitem"
                    disabled={targetsAllIn(folder.id)}
                    onClick={() => handleMove(folder.id)}
                    className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10 disabled:cursor-default disabled:text-text-muted disabled:hover:bg-transparent"
                  >
                    {folder.name}
                  </button>
                ))}
              </>
            )}
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
            {item.type !== 'audio' && (
              <button
                role="menuitem"
                disabled={describing}
                onClick={() => void handleDescribe()}
                title={
                  visionLabel
                    ? `Describe with ${visionLabel} — billed to your key (one vision request)`
                    : 'Describe with your AI provider — billed to your key (one vision request)'
                }
                className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10 disabled:text-text-muted"
              >
                {describing
                  ? 'Describing…'
                  : describeError
                    ? 'Retry description'
                    : item.aiDescription
                      ? 'Refresh description'
                      : 'Describe (AI)'}
              </button>
            )}
            {describeError && (
              <p role="alert" className="px-2 py-1 text-[9px] text-red-300">
                {describeError}
              </p>
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

function MediaTags({ asset }: { asset: MediaAsset }) {
  const tags = deriveTags(asset).slice(0, 4);
  if (tags.length === 0) return null;
  return (
    <p className="truncate px-0.5 font-mono text-[8px] uppercase tracking-wide text-text-muted" title={tags.join(' · ')}>
      {tags.join(' · ')}
    </p>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[10px] uppercase tracking-wide text-text-secondary">
        {label}
      </label>
      {children}
    </div>
  );
}
