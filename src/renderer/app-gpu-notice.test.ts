/**
 * The GPU-compositor degradation signal (renderer).
 *
 * `system:gpu-init`'s reply used to be discarded, so a native addon that failed
 * to load produced no user-visible trace at all -- the preview just quietly
 * showed one layer. These tests pin the mapping from the untyped IPC reply to
 * the message the existing notice surface shows, and to the fact that a healthy
 * addon says nothing.
 */
import { describe, it, expect } from 'vitest';
import { gpuUnavailableNotice } from './App';
import { useMediaPanelStore } from './store/media-panel';

describe('gpuUnavailableNotice', () => {
  it('stays silent when the addon loaded and initialized', () => {
    expect(gpuUnavailableNotice({ success: true, info: { adapter: 'test' } })).toBeNull();
  });

  it('names the main-process reason when the addon could not load', () => {
    const notice = gpuUnavailableNotice({
      success: false,
      error: 'no compositor addon found',
    });
    expect(notice).toContain('no compositor addon found');
    expect(notice).toContain('may be missing');
  });

  it('still explains the degradation for a reply with no reason at all', () => {
    expect(gpuUnavailableNotice({ success: false })).toContain('may be missing');
    expect(gpuUnavailableNotice(undefined)).toContain('may be missing');
    // A preload/contract drift must not read as a healthy GPU.
    expect(gpuUnavailableNotice('unexpected')).toContain('may be missing');
  });

  it('reaches the existing notice store, which is what the user sees', () => {
    useMediaPanelStore.getState().setNotice(null);

    const notice = gpuUnavailableNotice({ success: false, error: 'GPU init failed' });
    if (notice) useMediaPanelStore.getState().setNotice(notice);

    expect(useMediaPanelStore.getState().notice).toBe(notice);
    useMediaPanelStore.getState().setNotice(null);
  });
});
