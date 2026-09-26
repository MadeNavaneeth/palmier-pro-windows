/**
 * Media-library folders (upstream issue #156 slice).
 *
 * Flat one-level folders: `MediaFolder { id, name }` on `Project.mediaFolders`,
 * membership via `MediaAsset.folderId` (absent = library root). No nesting, so
 * cycles are impossible by construction. Names are sanitized on write and
 * narrowed on load so a hand-edited or hostile `.vproj` degrades to a clean
 * value instead of breaking the project.
 */

import type { MediaAsset, MediaFolder, Project } from '../types/project';
import { assetMatchesQuery } from './tags';

export const MEDIA_FOLDER_NAME_MAX_LENGTH = 60;

/**
 * Clean a raw folder name, or null when unusable. Control characters and
 * whitespace collapse to single spaces; the result is trimmed and capped at
 * MEDIA_FOLDER_NAME_MAX_LENGTH. Empty/blank input yields null.
 */
export function sanitizeFolderName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MEDIA_FOLDER_NAME_MAX_LENGTH)
    .trim();
  return cleaned.length === 0 ? null : cleaned;
}

/** True when two folder names match case-insensitively after sanitizing. */
export function folderNamesMatch(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

/**
 * A unique default folder name derived from `base`, appending ` 2`, ` 3`, …
 * until it no longer collides (case-insensitively) with `existingNames`.
 */
export function uniqueFolderName(base: string, existingNames: readonly string[]): string {
  const root = sanitizeFolderName(base) ?? 'Folder';
  if (!existingNames.some((name) => folderNamesMatch(name, root))) return root;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = sanitizeFolderName(`${root} ${n}`) ?? `${root} ${n}`;
    if (!existingNames.some((name) => folderNamesMatch(name, candidate))) return candidate;
  }
  return sanitizeFolderName(`${root} ${Date.now()}`) ?? root;
}

/**
 * Narrow an untrusted stored folder list on project load: drop entries whose
 * id is not a non-empty string or whose name does not sanitize (first
 * occurrence of a duplicate id wins), and clear any asset `folderId` that
 * does not resolve to a surviving folder (degrade to root). Returns the same
 * project reference when nothing needed changing, so clean loads do not churn
 * identity.
 */
export function narrowMediaFolders(project: Project): Project {
  // Untrusted input: a hand-edited .vproj is JSON, so `mediaFolders` can hold
  // null or any other non-array value — narrow those to a clean list instead
  // of throwing (or letting `''`/garbage pass through and crash later writes).
  const raw: unknown = project.mediaFolders;
  const mediaNeedsCheck = project.media.some((asset) => asset.folderId !== undefined);
  const rawEmpty = Array.isArray(raw) && raw.length === 0;
  if ((raw === undefined || rawEmpty) && !mediaNeedsCheck) return project;

  const folders: MediaFolder[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? (raw as unknown[]) : []) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as { id?: unknown; name?: unknown };
    if (typeof record.id !== 'string' || record.id.length === 0) continue;
    if (seen.has(record.id)) continue;
    const name = sanitizeFolderName(record.name);
    if (name === null) continue;
    seen.add(record.id);
    const folder: MediaFolder = { id: record.id, name };
    folders.push(folder);
  }

  const media = project.media.map((asset) => {
    if (asset.folderId === undefined || seen.has(asset.folderId)) return asset;
    const copy = { ...asset };
    delete copy.folderId;
    return copy;
  });

  const foldersChanged =
    raw !== undefined
    && (!Array.isArray(raw)
      || folders.length !== raw.length
      || folders.some((folder, index) => folder.id !== raw[index]?.id || folder.name !== raw[index]?.name));
  const mediaChanged = media.some((asset, index) => asset !== project.media[index]);
  if (!foldersChanged && !mediaChanged) return project;

  const next: Project = { ...project, media };
  if (raw === undefined && folders.length === 0) {
    // Leave mediaFolders absent rather than introducing an empty array on a
    // project that never had folders.
    delete next.mediaFolders;
  } else {
    next.mediaFolders = folders;
  }
  return next;
}

/** Number of assets whose folderId equals `folderId` (undefined = root). */
export function folderAssetCount(project: Project, folderId: string | undefined): number {
  return project.media.filter((asset) => asset.folderId === folderId).length;
}

/**
 * Visible items for the MediaBin folder layer: a non-empty normalized search
 * query matches globally across every folder (search is never folder-scoped);
 * with no query only the active folder's members show, where `folderId` null
 * is the library root (unfiled).
 */
export function filterLibraryAssets(
  media: readonly MediaAsset[],
  normalizedQuery: string,
  folderId: string | null,
): MediaAsset[] {
  if (normalizedQuery.length > 0) {
    return media.filter((asset) => assetMatchesQuery(asset, normalizedQuery));
  }
  return media.filter((asset) => (asset.folderId ?? null) === folderId);
}
