/**
 * IPC handlers for system-level operations.
 * GPU info, app version, safe storage for secrets, etc.
 */

import { ipcMain, app, safeStorage } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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
  ipcMain.handle('system:gpu-init', async () => {
    try {
      // Native addon is optional during development
      const native = await loadNativeAddon();
      if (native) {
        const info = native.gpuInit();
        return { success: true, info: JSON.parse(info) };
      }
      return { success: false, error: 'Native addon not available' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

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

let nativeAddon: any = null;
let nativeLoadAttempted = false;

async function loadNativeAddon(): Promise<any> {
  if (nativeLoadAttempted) return nativeAddon;
  nativeLoadAttempted = true;

  try {
    // In production, the .node file is in resources/native/
    // In dev, it's at native/palmier-compositor.win32-x64-msvc.node
    nativeAddon = require('../../native/palmier-compositor.node');
  } catch {
    try {
      nativeAddon = require('../native/palmier-compositor.node');
    } catch {
      console.warn('[main] Native compositor addon not found — GPU compositing disabled.');
      nativeAddon = null;
    }
  }
  return nativeAddon;
}
