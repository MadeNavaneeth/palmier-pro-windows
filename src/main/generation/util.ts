/**
 * Generation utilities — shared helpers for all providers.
 */

import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import https from 'https';
import http from 'http';

/**
 * Download a file from a URL to the local generation cache.
 * Returns the local file path.
 */
export async function downloadFile(
  url: string,
  requestId: string,
  ext: string,
): Promise<string> {
  const cacheDir = getGenerationCacheDir();
  await fs.mkdir(cacheDir, { recursive: true });

  const filename = `${requestId}.${ext}`;
  const outputPath = path.join(cacheDir, filename);

  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;

    const request = client.get(url, (response) => {
      // Follow redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          downloadFile(redirectUrl, requestId, ext).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        return;
      }

      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', async () => {
        try {
          await fs.writeFile(outputPath, Buffer.concat(chunks));
          resolve(outputPath);
        } catch (err) {
          reject(err);
        }
      });
      response.on('error', reject);
    });

    request.on('error', reject);
    request.setTimeout(120000, () => {
      request.destroy();
      reject(new Error('Download timed out'));
    });
  });
}

/**
 * Get the generation cache directory.
 */
export function getGenerationCacheDir(): string {
  const userData = app?.getPath('userData') || process.env.APPDATA || '';
  return path.join(userData, 'generated');
}

/**
 * List all generated files in the cache.
 */
export async function listGeneratedFiles(): Promise<string[]> {
  const dir = getGenerationCacheDir();
  try {
    const files = await fs.readdir(dir);
    return files.map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Clear old generated files (keep last N).
 */
export async function pruneGenerationCache(keepCount = 50): Promise<void> {
  const dir = getGenerationCacheDir();
  try {
    const files = await fs.readdir(dir);
    if (files.length <= keepCount) return;

    // Sort by modification time (oldest first)
    const withStats = await Promise.all(
      files.map(async (f) => {
        const full = path.join(dir, f);
        const stat = await fs.stat(full);
        return { path: full, mtime: stat.mtimeMs };
      }),
    );
    withStats.sort((a, b) => a.mtime - b.mtime);

    const toRemove = withStats.slice(0, withStats.length - keepCount);
    for (const file of toRemove) {
      await fs.unlink(file.path).catch(() => {});
    }
  } catch { /* best effort */ }
}
