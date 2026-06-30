/**
 * FrameExtractor — decodes video frames at specific timestamps using ffmpeg.
 * Maintains a disk cache of extracted frames as JPEG/PNG for fast re-reads.
 * Used by the preview engine to get frame data for compositing.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { app } from 'electron';

const execFileAsync = promisify(execFile);

interface FrameCacheEntry {
  path: string;
  timestamp: number;
  width: number;
  height: number;
}

export class FrameExtractor {
  private cacheDir: string;
  private cache = new Map<string, FrameCacheEntry>();
  private pendingExtractions = new Map<string, Promise<string>>();
  private maxCacheSize = 500; // max frames in cache

  constructor(projectId?: string) {
    const tempDir = app?.getPath('temp') || process.env.TEMP || '/tmp';
    this.cacheDir = path.join(tempDir, 'palmier-frames', projectId || 'default');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  /**
   * Extract a single frame at the given timestamp (seconds).
   * Returns the path to the cached frame image.
   */
  async extractFrame(
    sourcePath: string,
    timestampSec: number,
    width?: number,
    height?: number,
  ): Promise<string> {
    const cacheKey = this.buildCacheKey(sourcePath, timestampSec, width, height);

    // Check memory cache
    const cached = this.cache.get(cacheKey);
    if (cached) {
      try {
        await fs.access(cached.path);
        return cached.path;
      } catch {
        // File was cleaned up externally, re-extract
        this.cache.delete(cacheKey);
      }
    }

    // Deduplicate concurrent extractions of the same frame
    const pending = this.pendingExtractions.get(cacheKey);
    if (pending) return pending;

    const extraction = this.doExtract(sourcePath, timestampSec, width, height, cacheKey);
    this.pendingExtractions.set(cacheKey, extraction);

    try {
      const result = await extraction;
      return result;
    } finally {
      this.pendingExtractions.delete(cacheKey);
    }
  }

  /**
   * Extract multiple frames at once (batch extraction for scrubbing).
   * More efficient than individual calls as it reuses a single ffmpeg process.
   */
  async extractFrameBatch(
    sourcePath: string,
    timestamps: number[],
    width?: number,
    height?: number,
  ): Promise<Map<number, string>> {
    const results = new Map<number, string>();
    const needed: number[] = [];

    // Check cache for each timestamp
    for (const ts of timestamps) {
      const cacheKey = this.buildCacheKey(sourcePath, ts, width, height);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        results.set(ts, cached.path);
      } else {
        needed.push(ts);
      }
    }

    // Extract missing frames in parallel (limited concurrency)
    const CONCURRENT = 4;
    for (let i = 0; i < needed.length; i += CONCURRENT) {
      const batch = needed.slice(i, i + CONCURRENT);
      const extractions = batch.map(async (ts) => {
        const framePath = await this.extractFrame(sourcePath, ts, width, height);
        results.set(ts, framePath);
      });
      await Promise.all(extractions);
    }

    return results;
  }

  /**
   * Get a frame as raw RGBA pixel data (for sending to the GPU compositor).
   */
  async extractFrameRaw(
    sourcePath: string,
    timestampSec: number,
    width: number,
    height: number,
  ): Promise<Buffer> {
    const args = [
      '-ss', String(timestampSec),
      '-i', sourcePath,
      '-vframes', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${width}x${height}`,
      '-v', 'quiet',
      'pipe:1',
    ];

    const { stdout } = await execFileAsync('ffmpeg', args, {
      encoding: 'buffer' as any,
      maxBuffer: width * height * 4 + 1024,
    });

    return Buffer.from(stdout as any);
  }

  /**
   * Clear all cached frames.
   */
  async clearCache(): Promise<void> {
    this.cache.clear();
    this.pendingExtractions.clear();
    try {
      await fs.rm(this.cacheDir, { recursive: true, force: true });
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch {
      // Best effort
    }
  }

  /**
   * Clear cached frames for a specific source file.
   */
  async clearCacheForSource(sourcePath: string): Promise<void> {
    const prefix = this.hashString(sourcePath);
    const toDelete: string[] = [];

    for (const [key, entry] of this.cache) {
      if (key.startsWith(prefix)) {
        toDelete.push(key);
        try {
          await fs.unlink(entry.path);
        } catch { /* ignore */ }
      }
    }

    for (const key of toDelete) {
      this.cache.delete(key);
    }
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async doExtract(
    sourcePath: string,
    timestampSec: number,
    width: number | undefined,
    height: number | undefined,
    cacheKey: string,
  ): Promise<string> {
    const outputPath = path.join(this.cacheDir, `${cacheKey}.jpg`);

    const args = [
      '-y',
      '-ss', String(timestampSec),
      '-i', sourcePath,
      '-vframes', '1',
      '-q:v', '3', // good quality JPEG
    ];

    if (width && height) {
      args.push('-vf', `scale=${width}:${height}`);
    }

    args.push(outputPath);

    await execFileAsync('ffmpeg', args, { timeout: 10000 });

    // Cache it
    this.cache.set(cacheKey, {
      path: outputPath,
      timestamp: timestampSec,
      width: width || 0,
      height: height || 0,
    });

    // Evict old entries if cache is too large
    if (this.cache.size > this.maxCacheSize) {
      const entries = Array.from(this.cache.entries());
      const toRemove = entries.slice(0, entries.length - this.maxCacheSize);
      for (const [key, entry] of toRemove) {
        this.cache.delete(key);
        fs.unlink(entry.path).catch(() => {});
      }
    }

    return outputPath;
  }

  private buildCacheKey(
    sourcePath: string,
    timestamp: number,
    width?: number,
    height?: number,
  ): string {
    const hash = this.hashString(sourcePath);
    const ts = Math.round(timestamp * 1000); // ms precision
    const size = width && height ? `_${width}x${height}` : '';
    return `${hash}_${ts}${size}`;
  }

  private hashString(str: string): string {
    // Simple FNV-1a hash for cache key prefixes
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }
}
