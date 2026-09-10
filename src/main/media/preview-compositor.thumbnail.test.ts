/**
 * Regression coverage for marker-index thumbnails (upstream #552): the
 * compositor composes at the project canvas and hands back a bounded,
 * box-sampled RGBA buffer cached per project revision.
 *
 * The empty-project case keeps this test free of FFmpeg and the native
 * addon — composition of no visible clips already returns a canvas-sized
 * transparent frame, which is exactly the input shape the downscale path
 * has to handle.
 */
import { describe, it, expect } from 'vitest';
import { createEmptyProject } from '../../shared/types/project';
import { PreviewCompositor } from './preview-compositor';

describe('PreviewCompositor.renderThumbnail (#552)', () => {
  it('returns a canvas-proportioned RGBA thumbnail', async () => {
    const compositor = new PreviewCompositor();
    compositor.setProject(createEmptyProject());
    const thumb = await compositor.renderThumbnail(0);
    expect(thumb).not.toBeNull();
    // 1920x1080 at height 36 -> 64x36.
    expect(thumb!.width).toBe(64);
    expect(thumb!.height).toBe(36);
    expect(thumb!.rgba.length).toBe(64 * 36 * 4);
  });

  it('returns null without a project', async () => {
    expect(await new PreviewCompositor().renderThumbnail(0)).toBeNull();
  });

  it('serves a cached thumbnail for the same project revision and frame', async () => {
    const compositor = new PreviewCompositor();
    compositor.setProject(createEmptyProject());
    const first = await compositor.renderThumbnail(10);
    const second = await compositor.renderThumbnail(10);
    expect(second).toBe(first);
    // A different frame is a different entry.
    const other = await compositor.renderThumbnail(11);
    expect(other).not.toBe(first);
  });

  it('recomputes after the project object is replaced (new revision)', async () => {
    const compositor = new PreviewCompositor();
    compositor.setProject(createEmptyProject());
    const first = await compositor.renderThumbnail(10);
    compositor.setProject(createEmptyProject());
    const second = await compositor.renderThumbnail(10);
    expect(second).not.toBe(first);
    expect(second!.width).toBe(first!.width);
  });
});
