import React, { useMemo, useState } from 'react';
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
import type { MediaAsset } from '../../shared/types/project';
import { formatDuration } from '../../shared/utils/time';
import { ASSET_DND_MIME, getDroppedFilePath, setDraggingAsset } from '../lib/dnd';

type PanelTab = 'media' | 'captions' | 'audio';

const panelTabs = [
  { id: 'media' as const, label: 'Media', Icon: Folder },
  { id: 'captions' as const, label: 'Captions', Icon: Subtitles },
  { id: 'audio' as const, label: 'Audio', Icon: AudioLines },
];

export function MediaBin() {
  const project = useTimelineStore((state) => state.project);
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
    setImportError(result.errors?.[0] || (result.success ? '' : 'No supported media files found.'));
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
            <span className="ml-auto text-text-muted">
              {mediaItems.length} {mediaItems.length === 1 ? 'item' : 'items'}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {importError && (
              <div className="mb-2 border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-300">
                {importError}
              </div>
            )}
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
              <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
                {mediaItems.map((item) => (
                  <MediaCard key={item.id} item={item} fps={fps} />
                ))}
              </div>
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

function PanelPlaceholder({ tab }: { tab: Exclude<PanelTab, 'media'> }) {
  const Icon = tab === 'captions' ? Subtitles : AudioLines;
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

function MediaCard({ item, fps }: { item: MediaAsset; fps: number }) {
  const TypeIcon = item.type === 'video' ? Film : item.type === 'audio' ? Music2 : ImageIcon;

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(ASSET_DND_MIME, item.id);
        event.dataTransfer.effectAllowed = 'copy';
        setDraggingAsset({ id: item.id, type: item.type });
      }}
      onDragEnd={() => setDraggingAsset(null)}
      title={`Drag onto the timeline to add - ${item.filename}`}
      className="group min-w-0 cursor-grab active:cursor-grabbing"
    >
      <div className="relative aspect-video overflow-hidden rounded-md border border-black bg-surface-2 outline outline-1 outline-white/10 transition group-hover:outline-white/30">
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
      </div>
      <p className="mt-1 truncate px-0.5 text-[10px] text-text-secondary" title={item.filename}>
        {item.filename}
      </p>
    </div>
  );
}
