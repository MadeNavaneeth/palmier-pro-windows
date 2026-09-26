/**
 * Coverage for the shared shape renderer: per-kind path geometry, style
 * resolution, and the empty-content early-outs. A recording fake context
 * pins the call sequence without needing a real canvas.
 */
import { describe, it, expect } from 'vitest';
import type { Clip } from '../../shared/types/project';
import { drawShapeBox } from './shape-render';

type Call = { method: string; args: number[] };

class FakeContext {
  calls: Call[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  lineJoin = 'miter';
  lineCap = 'butt';
  save(): void {}
  restore(): void {}
  beginPath(): void {
    this.calls.push({ method: 'beginPath', args: [] });
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.calls.push({ method: 'rect', args: [x, y, w, h] });
  }
  ellipse(x: number, y: number, rx: number, ry: number): void {
    this.calls.push({ method: 'ellipse', args: [x, y, rx, ry] });
  }
  moveTo(x: number, y: number): void {
    this.calls.push({ method: 'moveTo', args: [x, y] });
  }
  lineTo(x: number, y: number): void {
    this.calls.push({ method: 'lineTo', args: [x, y] });
  }
  fill(): void {
    this.calls.push({ method: 'fill', args: [] });
  }
  stroke(): void {
    this.calls.push({ method: 'stroke', args: [] });
  }
}

function shapeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'shape-1',
    assetId: '__shape__',
    type: 'shape',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 90,
    inPoint: 0,
    outPoint: 90,
    x: 10,
    y: 20,
    width: 200,
    height: 120,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    anchorX: 0,
    anchorY: 0,
    volume: 1,
    muted: false,
    shapeKind: 'rect',
    shapeStrokeColor: '#ff0000',
    shapeStrokeWidth: 4,
    ...overrides,
  } as Clip;
}

function draw(clip: Clip, box?: { width: number; height: number }): FakeContext {
  const ctx = new FakeContext();
  drawShapeBox(ctx as unknown as CanvasRenderingContext2D, clip, box);
  return ctx;
}

describe('drawShapeBox', () => {
  it('insets a rect stroke by half the width and fills first', () => {
    const ctx = draw(shapeClip({ shapeFillColor: '#00ff0080' }));
    expect(ctx.calls[0]).toEqual({ method: 'beginPath', args: [] });
    expect(ctx.calls[1]).toEqual({ method: 'rect', args: [2, 2, 196, 116] });
    expect(ctx.calls[2]).toEqual({ method: 'fill', args: [] });
    expect(ctx.calls[3]).toEqual({ method: 'stroke', args: [] });
    expect(ctx.fillStyle).toBe('#00ff0080');
    expect(ctx.strokeStyle).toBe('#ff0000');
    expect(ctx.lineWidth).toBe(4);
  });

  it('centers an ellipse with stroke-adjusted radii', () => {
    const ctx = draw(shapeClip({ shapeKind: 'ellipse' }));
    expect(ctx.calls[1]).toEqual({ method: 'ellipse', args: [100, 60, 98, 58] });
    expect(ctx.calls).not.toContainEqual({ method: 'fill', args: [] });
  });

  it('runs a line corner to corner and ignores fill', () => {
    const ctx = draw(shapeClip({ shapeKind: 'line', shapeFillColor: '#00ff0080' }));
    expect(ctx.calls[1]).toEqual({ method: 'moveTo', args: [2, 2] });
    expect(ctx.calls[2]).toEqual({ method: 'lineTo', args: [198, 118] });
    expect(ctx.calls).not.toContainEqual({ method: 'fill', args: [] });
  });

  it('adds two head wings to an arrow and strokes once', () => {
    const ctx = draw(shapeClip({ shapeKind: 'arrow' }));
    const lineTos = ctx.calls.filter((c) => c.method === 'lineTo');
    // Shaft end plus two head wings.
    expect(lineTos).toHaveLength(3);
    expect(ctx.calls.filter((c) => c.method === 'stroke')).toHaveLength(1);
  });

  it('defaults an absent kind to rect and an absent box to the clip box', () => {
    const clip = shapeClip();
    delete (clip as Partial<Clip>).shapeKind;
    const ctx = draw(clip);
    expect(ctx.calls[1]?.method).toBe('rect');
  });

  it('draws fill-only when the stroke width is zero', () => {
    const ctx = draw(shapeClip({ shapeStrokeWidth: 0, shapeFillColor: '#00ff0080' }));
    expect(ctx.calls).toContainEqual({ method: 'fill', args: [] });
    expect(ctx.calls).not.toContainEqual({ method: 'stroke', args: [] });
  });

  it('draws nothing without stroke or fill, for non-shapes, or for empty boxes', () => {
    expect(draw(shapeClip({ shapeStrokeWidth: 0 })).calls).toHaveLength(0);
    expect(draw(shapeClip({ type: 'video' })).calls).toHaveLength(0);
    expect(draw(shapeClip(), { width: 0, height: 120 }).calls).toHaveLength(0);
    expect(draw(shapeClip({ shapeKind: 'circle' as never })).calls[1]?.method).toBe('rect');
  });
});
