/**
 * PreviewCanvas — renders the composited frame output at 60fps.
 *
 * Architecture:
 * - Receives raw RGBA buffers from the main process (via IPC) after
 *   the native Rust compositor produces them.
 * - Paints to a <canvas> using putImageData (fastest path for raw pixel data).
 * - Uses requestAnimationFrame to throttle re-paints and avoid tearing.
 * - Scales the canvas to fit the container while preserving aspect ratio.
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useTimelineStore } from '../store/timeline';

interface PreviewCanvasProps {
  /** Project canvas width in pixels */
  width: number;
  /** Project canvas height in pixels */
  height: number;
}

export function PreviewCanvas({ width, height }: PreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageDataRef = useRef<ImageData | null>(null);
  const rafRef = useRef<number>(0);
  const pendingFrameRef = useRef<Uint8ClampedArray | null>(null);
  const [displayScale, setDisplayScale] = useState(1);

  // Compute display scale to fit container
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: cw, height: ch } = entry.contentRect;
        const scale = Math.min(cw / width, ch / height, 1);
        setDisplayScale(scale);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [width, height]);

  // Initialize canvas context and ImageData
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    imageDataRef.current = new ImageData(width, height);
  }, [width, height]);

  // Paint loop — only paints when a new frame is pending
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const pending = pendingFrameRef.current;
    const imageData = imageDataRef.current;

    if (canvas && pending && imageData) {
      imageData.data.set(pending);
      const ctx = canvas.getContext('2d', { alpha: false });
      if (ctx) {
        ctx.putImageData(imageData, 0, 0);
      }
      pendingFrameRef.current = null;
    }

    rafRef.current = requestAnimationFrame(paint);
  }, []);

  // Start/stop paint loop
  useEffect(() => {
    rafRef.current = requestAnimationFrame(paint);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [paint]);

  // Subscribe to composited frames from main process
  useEffect(() => {
    const unsub = window.palmier.on('preview:frame', (frameBuffer: unknown) => {
      if (frameBuffer instanceof ArrayBuffer || ArrayBuffer.isView(frameBuffer)) {
        const bytes = frameBuffer instanceof ArrayBuffer
          ? new Uint8ClampedArray(frameBuffer)
          : new Uint8ClampedArray(
              (frameBuffer as Uint8Array).buffer,
              (frameBuffer as Uint8Array).byteOffset,
              (frameBuffer as Uint8Array).byteLength,
            );

        // Only accept correctly sized buffers
        if (bytes.length === width * height * 4) {
          pendingFrameRef.current = bytes;
        }
      }
    });

    return unsub;
  }, [width, height]);

  const displayWidth = Math.round(width * displayScale);
  const displayHeight = Math.round(height * displayScale);

  return (
    <div
      ref={containerRef}
      className="flex flex-1 items-center justify-center bg-black overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{
          width: `${displayWidth}px`,
          height: `${displayHeight}px`,
          imageRendering: 'auto',
        }}
        className="block"
      />
    </div>
  );
}
