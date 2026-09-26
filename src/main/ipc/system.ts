/**
 * IPC handlers for system-level operations.
 * GPU info, app version, safe storage for secrets, etc.
 */

import { ipcMain, app, safeStorage } from 'electron';
import { execFile } from 'child_process';
import { readdirSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** What `system:gpu-init` answers with, either way. */
export type GpuInitResult =
  | { success: true; info: unknown }
  | { success: false; error: string };

/**
 * Turn an addon into the `system:gpu-init` reply.
 *
 * Every way this can go wrong -- addon absent, GPU init failed, addon replying
 * with something unparseable -- answers as data with a reason, never as a
 * rejected IPC call. The renderer awaits this on startup and a rejection there
 * would be indistinguishable from a crash, while a well-formed failure is the
 * only thing it has to tell the user the preview is degraded with.
 */
export function gpuInitResult(addon: any): GpuInitResult {
  if (!addon) return { success: false, error: 'Native addon not available' };
  try {
    return { success: true, info: JSON.parse(addon.gpuInit()) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerSystemHandlers(): void {
  // ─── App info ────────────────────────────────────────────────────────────────
  ipcMain.handle('system:app-info', () => {
    return {
      version: app.getVersion(),
      name: app.getName(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    };
  });

  // ─── GPU initialization (native addon) ──────────────────────────────────────
  ipcMain.handle('system:gpu-init', async () => gpuInitResult(await loadNativeAddon()));

  // ─── FFmpeg availability check ───────────────────────────────────────────────
  ipcMain.handle('system:check-ffmpeg', async () => {
    try {
      const { stdout } = await execFileAsync('ffmpeg', ['-version']);
      const versionLine = stdout.split('\n')[0] || '';
      return { available: true, version: versionLine };
    } catch {
      return { available: false, version: null };
    }
  });

  // ─── Secure storage (Windows DPAPI via Electron safeStorage) ─────────────────
  ipcMain.handle('system:encrypt', (_event, plaintext: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: 'Encryption not available' };
    }
    const encrypted = safeStorage.encryptString(plaintext);
    return { success: true, data: encrypted.toString('base64') };
  });

  ipcMain.handle('system:decrypt', (_event, encryptedBase64: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: 'Encryption not available' };
    }
    try {
      const buffer = Buffer.from(encryptedBase64, 'base64');
      const decrypted = safeStorage.decryptString(buffer);
      return { success: true, data: decrypted };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}

// ─── Native addon loader (graceful failure) ──────────────────────────────────

/** `napi build`'s binaryName; the .node artifact is this plus a suffix. */
const NATIVE_ADDON_BASE = 'palmier-compositor';

let nativeAddon: any = null;
let nativeLoadAttempted = false;

/**
 * The addon file inside `dir`, or null when the directory holds none.
 *
 * Which filename `napi build` emits is not something to hardcode. With
 * `triples.defaults` it is target-triple suffixed
 * (`palmier-compositor.win32-x64-msvc.node`); without it, and after the
 * post-build normalizer, it is the bare `palmier-compositor.node`. Both
 * spellings occur for real builds, so the artifact matching the RUNNING
 * platform/arch wins and the bare name is the fallback. The suffix is matched
 * off disk rather than assembled from a guessed toolchain segment, so a build
 * that used `gnu` where this expects `msvc` still resolves.
 */
export function resolveNativeAddonPath(
  dir: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null; // No such directory: nothing built, or not this layout.
  }
  const triple = entries.find(
    (name) =>
      name.startsWith(`${NATIVE_ADDON_BASE}.${platform}-${arch}`) && name.endsWith('.node'),
  );
  if (triple) return path.join(dir, triple);
  const bare = `${NATIVE_ADDON_BASE}.node`;
  return entries.includes(bare) ? path.join(dir, bare) : null;
}

/**
 * Where the addon lives, in the order worth trying.
 *
 * A packaged app copies `native/` next to the bundle, under `resources/`. In dev
 * and in a build the module sits at two different depths below the repository
 * root -- `src/main/ipc/system.ts` versus `dist/main/<chunk>.js` -- so walking up
 * to the filesystem root looks for a sibling `native/` instead of hardcoding
 * either layout's offset (the old `../../native` resolved to `src/native` in dev,
 * a directory nothing has ever built into).
 */
function nativeAddonDirs(): string[] {
  const dirs: string[] = [];
  if (typeof process.resourcesPath === 'string') {
    dirs.push(path.join(process.resourcesPath, 'native'));
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    dirs.push(path.join(dir, 'native'));
    const parent = path.dirname(dir);
    if (parent === dir) break; // Filesystem root reached.
    dir = parent;
  }
  return dirs;
}

/**
 * The process-wide compositor addon, or null when it cannot be loaded.
 *
 * Memoized because the addon is a singleton -- one .node, and inside it one GPU
 * device and one render pipeline (gpu.rs/pipeline.rs hold both in a OnceLock).
 * Per-session PreviewCompositors share this instance rather than each loading
 * their own copy. The addon is optional during development and a progressive
 * enhancement at runtime, so a missing or broken build degrades to the CPU
 * composition path instead of failing startup.
 */
export async function loadNativeAddon(): Promise<any> {
  if (nativeLoadAttempted) return nativeAddon;
  nativeLoadAttempted = true;

  try {
    const file = nativeAddonDirs()
      .map((dir) => resolveNativeAddonPath(dir))
      .find((found) => found !== null);
    if (!file) throw new Error('no compositor addon found');
    // The main bundle is ESM, where a bare `require` does not exist; a created
    // require function anchored at this module resolves an absolute path the
    // same way in dev, in the bundle, and inside a packaged app.
    nativeAddon = createRequire(import.meta.url)(file);
  } catch (err) {
    console.warn('[main] Native compositor addon not found — GPU compositing disabled.', err);
    nativeAddon = null;
  }
  return nativeAddon;
}
