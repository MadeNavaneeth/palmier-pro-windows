import { afterEach, describe, expect, it, vi } from 'vitest';

const save = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());

vi.mock('../store/project', () => ({
  useProjectStore: {
    getState: () => ({ save, hasUnsavedChanges: false }),
  },
}));
vi.mock('../store/timeline', () => ({
  useTimelineStore: { getState: () => ({}) },
}));
vi.mock('../store/ui', () => ({
  useUiStore: { getState: () => ({}) },
}));

const { dispatchShortcut } = await import('./shortcut-dispatcher');

afterEach(() => {
  save.mockReset();
  alert.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('saveProject shortcut failure reporting', () => {
  it('surfaces a rejected save through the same alert path used by Ctrl+S', async () => {
    save.mockRejectedValue(new Error('permission denied'));
    vi.stubGlobal('window', { alert });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    dispatchShortcut('saveProject');

    await vi.waitFor(() => {
      expect(alert).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
    });
  });
});
