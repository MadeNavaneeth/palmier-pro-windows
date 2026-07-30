/**
 * FrameDecoder — decodes video frames at specific source timestamps via FFmpeg.
 *
 * Uses `ffmpeg -ss <seconds> -i <input> -frames:v 1 -f rawvideo -pix_fmt rgba
 * pipe:1` to produce raw RGBA buffers, with an LRU cache and bounded decode
 * concurrency.
 *
 * Decode requests are addressed by SOURCE SECONDS, not by a frame index. The
 * caller converts timeline frames to source time through
 * `shared/media/source-time.ts`, so the decoder never has to guess whether an
 * index belongs to the project's frame space or the source's own (upstream #68).
 */

import { spawn } from 'child_process';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DecodedFrame {
  assetPath: string;
  /** Source offset this buffer was decoded at, in seconds. */
  sourceSeconds: number;
  width: number;
  height: number;
  /** Raw RGBA pixel data, exactly width * height * 4 bytes. */
  data: Buffer;
  decodedAt: number; // Date.now()
}

export interface DecodeRequest {
  assetPath: string;
  width: number;
  height: number;
  /** Offset into the source file, in seconds. */
  sourceSeconds: number;
}

/** Per-frame decode budget. A seek that cannot be served is dropped, not retried. */
const DECODE_TIMEOUT_MS = 5000;

/**
 * Cache/dedupe identity for a decode.
 *
 * The size is part of the key. Without it a frame decoded for a 1920x1080 canvas
 * would be handed back for a 1080x1920 request after a project-settings change,
 * and the compositor would submit a buffer whose length disagrees with the layer
 * it describes.
 */
export function decodeRequestKey(request: DecodeRequest): string {
  const ms = Math.round(request.sourceSeconds * 1000);
  return `${request.assetPath}|${request.width}x${request.height}|${ms}`;
}

// ─── LRU Cache ───────────────────────────────────────────────────────────────

class FrameCache {
  private cache = new Map<string, DecodedFrame>();
  private maxSize: number;

  constructor(maxSize = 120) {
    this.maxSize = maxSize;
  }

  get(key: string): DecodedFrame | null {
    const frame = this.cache.get(key);
    if (!frame) return null;
    // Re-insert to mark most recently used; Map preserves insertion order.
    this.cache.delete(key);
    this.cache.set(key, frame);
    return frame;
  }

  set(key: string, frame: DecodedFrame): void {
    this.cache.delete(key);
    this.cache.set(key, frame);
    while (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// ─── Frame Decoder ───────────────────────────────────────────────────────────

export class FrameDecoder {
  private cache: FrameCache;
  private pendingDecodes = new Map<string, Promise<DecodedFrame | null>>();
  private concurrency: number;
  private activeDecodes = 0;
  /** Waiters released as decode slots free up, instead of polling for one. */
  private slotWaiters: (() => void)[] = [];

  constructor(options?: { cacheSize?: number; concurrency?: number }) {
    this.cache = new FrameCache(options?.cacheSize || 120);
    this.concurrency = Math.max(1, options?.concurrency || 4);
  }

  /**
   * Get a decoded frame, from cache when possible.
   *
   * Returns null for an unusable request or a failed decode; callers skip the
   * layer rather than blocking the frame.
   */
  async getFrame(request: DecodeRequest): Promise<DecodedFrame | null> {
    if (!this.isValidRequest(request)) return null;

    const key = decodeRequestKey(request);
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Coalesce identical in-flight decodes so a scrub burst spawns one process
    // per distinct frame instead of one per request.
    const pending = this.pendingDecodes.get(key);
    if (pending) return pending;

    const promise = this.decode(key, request);
    this.pendingDecodes.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pendingDecodes.delete(key);
    }
  }

  /** Prefetch frames ahead of the playhead. Never rejects. */
  async prefetch(requests: DecodeRequest[]): Promise<void> {
    const pending = requests.filter(
      (request) => this.isValidRequest(request) && !this.cache.has(decodeRequestKey(request)),
    );
    // Concurrency is enforced inside decode(), so all requests can be issued at
    // once; a failure in one must not abandon the rest.
    await Promise.allSettled(pending.map((request) => this.getFrame(request)));
  }

  /** Clear the frame cache (e.g. on project switch). */
  clearCache(): void {
    this.cache.clear();
    this.pendingDecodes.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private isValidRequest(request: DecodeRequest): boolean {
    return (
      typeof request.assetPath === 'string'
      && request.assetPath.length > 0
      && Number.isFinite(request.sourceSeconds)
      && request.sourceSeconds >= 0
      && Number.isInteger(request.width)
      && Number.isInteger(request.height)
      && request.width > 0
      && request.height > 0
    );
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeDecodes < this.concurrency) {
      this.activeDecodes += 1;
      return;
    }
    await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    this.activeDecodes += 1;
  }

  private releaseSlot(): void {
    this.activeDecodes -= 1;
    const next = this.slotWaiters.shift();
    if (next) next();
  }

  private async decode(key: string, request: DecodeRequest): Promise<DecodedFrame | null> {
    await this.acquireSlot();
    try {
      const data = await this.runFfmpeg(
        request.assetPath,
        request.sourceSeconds,
        request.width,
        request.height,
      );
      if (!data) return null;

      const frame: DecodedFrame = {
        assetPath: request.assetPath,
        sourceSeconds: request.sourceSeconds,
        width: request.width,
        height: request.height,
        data,
        decodedAt: Date.now(),
      };
      this.cache.set(key, frame);
      return frame;
    } finally {
      this.releaseSlot();
    }
  }

  private runFfmpeg(
    inputPath: string,
    timestampSec: number,
    width: number,
    height: number,
  ): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const args = [
        '-nostdin',
        '-loglevel', 'error',
        // -ss before -i is an input seek: FFmpeg jumps to the nearest keyframe
        // instead of decoding the file from the start.
        '-ss', timestampSec.toFixed(4),
        '-i', inputPath,
        '-frames:v', '1',
        '-an',
        '-vf', `scale=${width}:${height}:flags=bilinear`,
        '-f', 'rawvideo',
        '-pix_fmt', 'rgba',
        'pipe:1',
      ];

      const proc = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });

      const chunks: Buffer[] = [];
      let totalSize = 0;
      const expectedSize = width * height * 4; // RGBA
      let settled = false;

      // The timer is cleared on every exit path. Leaving it armed kept a handle
      // alive per decode and fired a kill against an already-exited process.
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        finish(null);
      }, DECODE_TIMEOUT_MS);

      function finish(result: Buffer | null): void {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      }

      proc.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        totalSize += chunk.length;
      });

      proc.on('close', (code) => {
        if (code !== 0 || totalSize < expectedSize) {
          finish(null);
          return;
        }
        finish(Buffer.concat(chunks, expectedSize));
      });

      proc.on('error', () => finish(null));
    });
  }
}

// ─── Singleton for the main process ──────────────────────────────────────────

let decoderInstance: FrameDecoder | null = null;

export function getFrameDecoder(): FrameDecoder {
  if (!decoderInstance) {
    decoderInstance = new FrameDecoder({ cacheSize: 120, concurrency: 4 });
  }
  return decoderInstance;
}
