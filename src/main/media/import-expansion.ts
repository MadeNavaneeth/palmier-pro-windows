/**
 * Import path classification (upstream issue #453).
 *
 * A dropped folder used to be rejected as "not a supported media file"
 * because it has no media extension, silently importing none of the media
 * inside. This module expands directories recursively — bounded, so a huge
 * or cyclic tree cannot hang the IPC handler — and reports every top-level
 * item it had to skip, so nothing disappears without a readable reason.
 */

import path from 'path';
import fs from 'fs/promises';
import { fileKindOf } from '../../shared/media/file-kind';

/** Folder recursion stops below this depth (matches the relink walk). */
export const IMPORT_MAX_DEPTH = 8;
/** Hard ceiling on supported files one import may probe (ffprobe per file). */
export const IMPORT_MAX_FILES = 500;

/** Structural subset of node Dirent / Stats the walker relies on. */
interface EntryInfo {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ImportExpansionIo {
  stat(filePath: string): Promise<EntryInfo>;
  readdir(dirPath: string): Promise<Array<{ name: string } & EntryInfo>>;
}

const defaultIo: ImportExpansionIo = {
  stat: (filePath) => fs.stat(filePath),
  readdir: (dirPath) => fs.readdir(dirPath, { withFileTypes: true }),
};

export interface ExpandedImportPaths {
  /** Supported media files ready for ffprobe probing, in stable order. */
  files: string[];
  /**
   * One readable reason per skipped *top-level* item, plus one notice each
   * for unreadable folders, depth and file-count truncation. Unsupported
   * files found *inside* a dropped folder are ignored quietly — a bin of
   * videos always travels with sidecars (.srt, thumbs.db) that are not
   * import failures.
   */
  errors: string[];
}

interface WalkState {
  files: string[];
  errors: string[];
  truncatedByCount: boolean;
  truncatedByDepth: boolean;
}

/**
 * Resolve raw drop/dialog paths into probrable media files. Top-level
 * unsupported items keep the existing refusal message; folders expand.
 * Explicitly picked files are admitted even after a folder hit the count
 * ceiling — the cap bounds expansion work, not the user's own selection.
 */
export async function expandImportPaths(
  filePaths: string[],
  io: ImportExpansionIo = defaultIo,
): Promise<ExpandedImportPaths> {
  const state: WalkState = { files: [], errors: [], truncatedByCount: false, truncatedByDepth: false };

  for (const filePath of [...new Set(filePaths)]) {
    let info: EntryInfo | null = null;
    try {
      info = await io.stat(filePath);
    } catch {
      info = null;
    }

    if (info === null) {
      // Not reachable from here: leave extension-supported paths to ffprobe,
      // which reports "Could not import X" honestly; refuse the rest.
      if (!fileKindOf(filePath)) {
        state.errors.push(`${path.basename(filePath)} is not a supported media file`);
      }
    } else if (info.isDirectory()) {
      await walkFolder(filePath, 0, io, state);
    } else if (info.isFile() && fileKindOf(filePath)) {
      state.files.push(filePath);
    } else {
      state.errors.push(`${path.basename(filePath)} is not a supported media file`);
    }
  }

  if (state.truncatedByCount) {
    state.errors.push(`Folder import stopped after ${IMPORT_MAX_FILES} files`);
  }
  if (state.truncatedByDepth) {
    state.errors.push(`Skipped folders deeper than ${IMPORT_MAX_DEPTH} levels`);
  }

  return { files: state.files, errors: state.errors };
}

async function walkFolder(
  dirPath: string,
  depth: number,
  io: ImportExpansionIo,
  state: WalkState,
): Promise<void> {
  let entries;
  try {
    entries = await io.readdir(dirPath);
  } catch {
    state.errors.push(`Could not read folder ${path.basename(dirPath)}`);
    return;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Never follow links: a junction cycle must terminate via this rule
    // rather than by burning the depth budget invisibly.
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (depth + 1 > IMPORT_MAX_DEPTH) {
        state.truncatedByDepth = true;
        continue;
      }
      await walkFolder(full, depth + 1, io, state);
    } else if (entry.isFile() && fileKindOf(full)) {
      if (state.files.length >= IMPORT_MAX_FILES) {
        state.truncatedByCount = true;
        return;
      }
      state.files.push(full);
    }
  }
}
