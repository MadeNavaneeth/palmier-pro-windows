/**
 * The native compositor addon's filename resolution (main process).
 *
 * Which file `napi build` emits is not a single fixed name: with
 * `triples.defaults` it is target-triple suffixed, and without it (and after the
 * post-build normalizer) it is the bare `palmier-compositor.node`. The loader
 * previously hardcoded the bare name, so a triple-suffixed build could never be
 * found -- and the bare name is not what every build produces either. These
 * tests pin the rule: the artifact matching the RUNNING platform/arch wins, the
 * bare name is the fallback, and an unrelated triple is never picked up.
 *
 * `system:gpu-init` is the other half: a load failure has to come back as a
 * failed result rather than a rejected IPC call, because that reply is the only
 * thing the renderer has to tell the user with.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: any[]) => any) => {
      ipcHandlers.set(channel, listener);
    },
  },
  app: { getVersion: () => '0.1.0', getName: () => 'Palmier Pro' },
  safeStorage: { isEncryptionAvailable: () => false },
  default: {},
}));

const BARE = 'palmier-compositor.node';
/** This test file's own repo, so the walk-up lands on the real native/ dir. */
const REPO = path.resolve(__dirname, '..', '..', '..');

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'palmier-native-'));
  ipcHandlers.clear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/** A stand-in artifact: the resolver only ever looks at the name. */
function artifact(name: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, 'not a real addon');
  return file;
}

describe('resolveNativeAddonPath', () => {
  it('prefers the triple-suffixed artifact for the running platform/arch', async () => {
    const expected = artifact('palmier-compositor.win32-x64-msvc.node');
    const { resolveNativeAddonPath } = await import('./system');
    expect(resolveNativeAddonPath(dir, 'win32', 'x64')).toBe(expected);
  });

  it('falls back to the unsuffixed name when that is the only artifact', async () => {
    const expected = artifact(BARE);
    const { resolveNativeAddonPath } = await import('./system');
    expect(resolveNativeAddonPath(dir, 'win32', 'x64')).toBe(expected);
  });

  it('prefers the triple over an unsuffixed artifact that is also present', async () => {
    artifact(BARE);
    const expected = artifact('palmier-compositor.win32-x64-msvc.node');
    const { resolveNativeAddonPath } = await import('./system');
    expect(resolveNativeAddonPath(dir, 'win32', 'x64')).toBe(expected);
  });

  it('ignores a triple built for another platform/arch', async () => {
    artifact('palmier-compositor.linux-x64-gnu.node');
    const { resolveNativeAddonPath } = await import('./system');
    // Nothing matches win32/x64 and there is no bare fallback, so an ARM64 or
    // Linux build must not be loaded into this process.
    expect(resolveNativeAddonPath(dir, 'win32', 'x64')).toBeNull();
  });

  it('resolves an arm64 build rather than the x64 one sitting beside it', async () => {
    artifact('palmier-compositor.win32-x64-msvc.node');
    const expected = artifact('palmier-compositor.win32-arm64-msvc.node');
    const { resolveNativeAddonPath } = await import('./system');
    expect(resolveNativeAddonPath(dir, 'win32', 'arm64')).toBe(expected);
  });

  it('returns null for a missing directory instead of throwing', async () => {
    const { resolveNativeAddonPath } = await import('./system');
    expect(resolveNativeAddonPath(path.join(dir, 'nope'), 'win32', 'x64')).toBeNull();
  });

  it('finds the built addon from the dev source layout', async () => {
    const built = path.join(REPO, 'native', BARE);
    // Skipped on a checkout that has not run `npm run build:rust`; the addon is
    // a build artifact, so its absence is not a loader defect.
    if (!existsSync(built)) return;
    const { resolveNativeAddonPath } = await import('./system');
    // src/main/ipc/ is three levels below the repo root, so a fixed
    // `../../native` offset resolved to src/native and never existed.
    expect(resolveNativeAddonPath(path.join(REPO, 'native'), 'win32', 'x64')).toBe(built);
  });
});

describe('loadNativeAddon', () => {
  // Loads a real .node and dlopens it; the module load is I/O bound.
  it('loads the built addon by absolute path from the repo layout', async () => {
    const built = path.join(REPO, 'native', BARE);
    if (!existsSync(built)) return;
    const { loadNativeAddon } = await import('./system');
    const addon = await loadNativeAddon();
    expect(addon).not.toBeNull();
    // The surface the preview compositor calls.
    expect(typeof addon.compositeFrameGpu).toBe('function');
  }, 30_000);
});

describe('gpuInitResult', () => {
  it('reports a missing addon as a failed result with a reason', async () => {
    const { gpuInitResult } = await import('./system');
    const result = gpuInitResult(null);
    expect(result.success).toBe(false);
    expect(typeof (result as { error: string }).error).toBe('string');
  });

  it('reports a GPU init failure as a failed result, not a rejection', async () => {
    const { gpuInitResult } = await import('./system');
    const result = gpuInitResult({
      gpuInit: () => { throw new Error('GPU init failed: no adapter'); },
    });
    expect(result).toEqual({ success: false, error: 'GPU init failed: no adapter' });
  });

  it('survives an addon whose gpuInit reply is not JSON', async () => {
    const { gpuInitResult } = await import('./system');
    const result = gpuInitResult({ gpuInit: () => 'not json' });
    expect(result.success).toBe(false);
  });

  it('parses the adapter info out of a healthy addon', async () => {
    const { gpuInitResult } = await import('./system');
    const result = gpuInitResult({ gpuInit: () => '{"adapter":"test","backend":"Vulkan"}' });
    expect(result).toEqual({
      success: true,
      info: { adapter: 'test', backend: 'Vulkan' },
    });
  });
});

describe('system:gpu-init', () => {
  // `gpuInit` really does bring up a wgpu device, which is a driver call and
  // can take seconds when the rest of the suite is competing for the same GPU.
  it('always answers with a well-formed reply, whichever branch it takes', async () => {
    const { registerSystemHandlers, loadNativeAddon } = await import('./system');
    const addon = await loadNativeAddon();

    registerSystemHandlers();
    const result = await ipcHandlers.get('system:gpu-init')!({});

    expect(result).toHaveProperty('success');
    if (addon) {
      expect(result.success).toBe(true);
    } else {
      expect(result.success).toBe(false);
      expect((result as { error: string }).error.length).toBeGreaterThan(0);
    }
  }, 30_000);
});
