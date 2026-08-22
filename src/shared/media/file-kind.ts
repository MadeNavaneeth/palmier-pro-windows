/**
 * Source-file kind from its extension — shared by import probing, offline
 * relink validation, and any future drag targets, so every layer agrees on
 * what a given file is before trusting it.
 */

export type FileKind = 'video' | 'audio' | 'image';

const EXTENSION_KINDS: Readonly<Record<string, FileKind>> = {
  '.mp4': 'video',
  '.mov': 'video',
  '.avi': 'video',
  '.mkv': 'video',
  '.webm': 'video',
  '.wmv': 'video',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.aac': 'audio',
  '.ogg': 'audio',
  '.flac': 'audio',
  '.m4a': 'audio',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.bmp': 'image',
};

/** Kind for `path`'s extension, or null when unsupported. */
export function fileKindOf(path: string): FileKind | null {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return null;
  return EXTENSION_KINDS[path.slice(dot).toLowerCase()] ?? null;
}
