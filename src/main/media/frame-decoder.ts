/**
 * FrameDecoder — decodes video frames at specific timestamps using FFmpeg.
 *
 * Uses `ffmpeg -ss <time> -i <input> -vframes 1 -f rawvideo -pix_fmt rgba pipe:1`
 * to produce raw RGBA buffers. Implements an LRU frame cache and lookahead
 * decoding to stay ahead of the playhead.
 *
 * For images, it decodes once and caches indefinitely.
 */

import { spawn } from 'child_process';
import type { Frame } from '../../shared/types/project';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DecodedFrame {
  assetPath: string;
  frameIndex: Frame;
  width: number;
  height: number;
  /** Raw RGBA pixel data */
  data: Buffer;
  decodedAt: number; // Date.now()
}

export interface DecodeRequest {
  assetPath: string;
  width: number;
  height: number;
  fps: number;
  frameIndex: Frame;
}

// ─── LRU Cache ───────────────────────────────────────────────────────────────

class FrameCache {
  private cache = new Map<string, DecodedFrame>();
  private accessOrder: string[] = [];
  private maxSize: number;

  constructor(maxSize = 120) {
    this.maxSize = maxSize;
  }

  private key(assetPath: string, frameIndex: Frame): string {
    return `${assetPath}::${frameIndex}`;
  }

  get(assetPath: string, frameIndex: Frame): DecodedFrame | null {
    const k = this.key(assetPath, frameIndex);
    const frame = this.cache.get(k);
    if (!frame) return null;

    // Move to end (most recently used)
    this.accessOrder = this.accessOrder.filter((x) => x !== k);
    this.accessOrder.push(k);
    return frame;
  }

  set(frame: DecodedFrame): void {
    const k = this.key(frame.assetPath, frame.frameIndex);

    if (this.cache.has(k)) {
      this.accessOrder = this.accessOrder.filter((x) => x !== k);
    }

    this.cache.set(k, frame);
    this.accessOrder.push(k);

    // Evict LRU if over capacity
    while (this.cache.size > this.maxSize) {
      const oldest = this.accessOrder.shift();
      if (oldest) this.cache.delete(oldest);
    }
  }

  has(assetPath: string, frameIndex: Frame): boolean {
    return this.cache.has(this.key(assetPath, frameIndex));
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
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

  constructor(options?: { cacheSize?: number; concurrency?: number }) {
    this.cache = new FrameCache(options?.cacheSize || 120);
    this.concurrency = options?.concurrency || 4;
  }

  /**
   * Get a decoded frame. Returns cached if available, otherwise decodes.
   */
  async getFrame(request: DecodeRequest): Promise<DecodedFrame | null> {
    const { assetPath, frameIndex, width, height, fps } = request;

    // Check cache first
    const cached = this.cache.get(assetPath, frameIndex);
    if (cached) return cached;

    // Check if already decoding
    const key = `${assetPath}::${frameIndex}`;
    const pending = this.pendingDecodes.get(key);
    if (pending) return pending;

    // Decode
    const promise = this.decode(assetPath, frameIndex, width, height, fps);
    this.pendingDecodes.set(key, promise);

    try {
      const result = await promise;
      return result;
    } finally {
      this.pendingDecodes.delete(key);
    }
  }

  /**
   * Prefetch frames ahead of the playhead for smooth playback.
   */
  async prefetch(requests: DecodeRequest[]): Promise<void> {
    const toDecode = requests.filter(
      (r) => !this.cache.has(r.assetPath, r.frameIndex),
    );

    // Decode in parallel up to concurrency limit
    const batches: DecodeRequest[][] = [];
    for (let i = 0; i < toDecode.length; i += this.concurrency) {
      batches.push(toDecode.slice(i, i + this.concurrency));
    }

    for (const batch of batches) {
      await Promise.all(batch.map((r) => this.getFrame(r)));
    }
  }

  /**
   * Clear the frame cache (e.g., on project switch).
   */
  clearCache(): void {
    this.cache.clear();
    this.pendingDecodes.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private async decode(
    assetPath: string,
    frameIndex: Frame,
    width: number,
    height: number,
    fps: number,
  ): Promise<DecodedFrame | null> {
    // Wait if at concurrency limit
    while (this.activeDecodes >= this.concurrency) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    this.activeDecodes++;

    try {
      const timestamp = fps > 0 ? frameIndex / fps : 0;
      const data = await this.runFfmpeg(assetPath, timestamp, width, height);
      if (!data) return null;

      const frame: DecodedFrame = {
        assetPath,
        frameIndex,
        width,
        height,
        data,
        decodedAt: Date.now(),
      };

      this.cache.set(frame);
      return frame;
    } finally {
      this.activeDecodes--;
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
        '-ss', timestampSec.toFixed(4),
        '-i', inputPath,
        '-vframes', '1',
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

      proc.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        totalSize += chunk.length;
      });

      proc.on('close', (code) => {
        if (code !== 0 || totalSize < expectedSize) {
          resolve(null);
          return;
        }
        resolve(Buffer.concat(chunks, expectedSize));
      });

      proc.on('error', () => {
        resolve(null);
      });

      // Timeout: 5s per frame max
      setTimeout(() => {
        proc.kill('SIGKILL');
        resolve(null);
      }, 5000);
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
