/**
 * Proxy media policy (roadmap R2).
 *
 * Proxies are lightweight transcodes used to keep editing interactive on
 * heavy sources. The rule that keeps preview and export trustworthy:
 *
 *   preview/decode may read the proxy when one exists;
 *   export ALWAYS reads the original.
 *
 * A damaged or half-written proxy therefore degrades scrubbing smoothness,
 * never final output quality.
 */

import type { MediaAsset } from '../types/project';

export type UsageKind = 'preview' | 'export';

/** Proxy decode policy: auto uses proxies when ready, off forces originals. */
export type ProxyMode = 'auto' | 'off';
export const PROXY_MODES: readonly ProxyMode[] = ['auto', 'off'];

/** The file a given usage should decode from. */
export function effectiveSourcePath(
  asset: Pick<MediaAsset, 'path' | 'proxyPath'>,
  usage: UsageKind,
  mode: ProxyMode = 'auto',
): string {
  if (usage === 'preview' && mode === 'auto' && asset.proxyPath) return asset.proxyPath;
  return asset.path;
}

export const PROXY_WIDTH_CAP = 960;

/** FFmpeg arguments for a 540p-ish mezzanine proxy with re-encoded audio. */
export function proxyArgs(sourcePath: string, outputPath: string): string[] {
  return [
    '-y',
    '-i', sourcePath,
    '-vf', `scale='min(${PROXY_WIDTH_CAP},iw)':-2`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '26',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ];
}
