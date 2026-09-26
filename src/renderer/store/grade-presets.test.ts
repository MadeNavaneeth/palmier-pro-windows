/**
 * Regression coverage for the async renderer client for app-wide named grade
 * presets (upstream #157). Persistence lives in the main process; this store
 * only reconciles the returned list and keeps the Inspector-facing operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { GradePreset } from '../../shared/editor/grade-preset-store';

interface FakeApi {
  list: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function installApi(initial: GradePreset[] = []): { api: FakeApi; setPresets: (next: GradePreset[]) => void } {
  let presets = [...initial];
  const api: FakeApi = {
    list: vi.fn(async () => ({ success: true, presets: [...presets] })),
    save: vi.fn(async (label: string, grade: GradePreset['grade'], shot?: GradePreset['shot']) => {
      const next = [...presets, { id: `user-${presets.length + 1}`, label: label.trim(), grade, ...(shot ? { shot } : {}) }];
      presets = next;
      return { success: true, preset: next[next.length - 1], presets: [...presets] };
    }),
    remove: vi.fn(async (id: string) => {
      const before = presets.length;
      presets = presets.filter((preset) => preset.id !== id);
      return { success: true, changed: presets.length !== before, presets: [...presets] };
    }),
  };
  vi.stubGlobal('window', { palmier: { gradePresets: api } });
  return { api, setPresets: (next) => { presets = [...next]; } };
}

async function loadStore() {
  vi.resetModules();
  const module = await import('./grade-presets');
  return module.useGradePresetsStore;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('grade preset renderer client (#157)', () => {
  it('loads the app-wide list through IPC instead of localStorage', async () => {
    const initial: GradePreset[] = [{ id: 'user-1', label: 'Golden', grade: { brightness: 0.1 } }];
    const { api } = installApi(initial);
    const store = await loadStore();

    await expect(store.getState().load()).resolves.toEqual(initial);
    expect(store.getState().presets).toEqual(initial);
    expect(api.list).toHaveBeenCalled();
    expect(window.localStorage).toBeUndefined();
  });

  it('saves through IPC and reconciles the returned list', async () => {
    const { api } = installApi();
    const store = await loadStore();

    const saved = await store.getState().save('  Golden Hour  ', { brightness: 0.1, saturation: 1.2 });

    expect(saved).toMatchObject({ label: 'Golden Hour', grade: { brightness: 0.1, saturation: 1.2 } });
    expect(store.getState().presets).toHaveLength(1);
    expect(api.save).toHaveBeenCalledWith('  Golden Hour  ', { brightness: 0.1, saturation: 1.2 });
  });

  it('preserves an optional shot through the renderer boundary', async () => {
    const { api } = installApi();
    const store = await loadStore();
    const shot = { rotation: 18, scaleX: 1.2 };

    const saved = await store.getState().save('Framed', { brightness: 0.1 }, shot);

    expect(saved?.shot).toEqual(shot);
    expect(store.getState().presets[0].shot).toEqual(shot);
    expect(api.save).toHaveBeenCalledWith('Framed', { brightness: 0.1 }, shot);
  });

  it('keeps the current list when a save is refused', async () => {
    const initial: GradePreset[] = [{ id: 'user-1', label: 'Keep', grade: { brightness: 0.1 } }];
    const { api } = installApi(initial);
    api.save.mockResolvedValue({ success: false, error: 'duplicate', presets: initial });
    const store = await loadStore();

    await expect(store.getState().save('Duplicate', { contrast: 2 })).resolves.toBeNull();
    expect(store.getState().presets).toEqual(initial);
  });

  it('removes through IPC and reports whether a row changed', async () => {
    const initial: GradePreset[] = [{ id: 'user-1', label: 'Temp', grade: { brightness: 0.1 } }];
    const { api } = installApi(initial);
    const store = await loadStore();

    await expect(store.getState().remove('user-1')).resolves.toBe(true);
    expect(store.getState().presets).toEqual([]);
    expect(api.remove).toHaveBeenCalledWith('user-1');
  });

  it('degrades safely when the preload API is unavailable', async () => {
    vi.stubGlobal('window', {});
    const store = await loadStore();

    await expect(store.getState().load()).resolves.toEqual([]);
    await expect(store.getState().save('Look', { brightness: 0.1 })).resolves.toBeNull();
    await expect(store.getState().remove('user-1')).resolves.toBe(false);
  });
});
