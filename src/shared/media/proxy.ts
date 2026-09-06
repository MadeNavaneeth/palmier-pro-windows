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

/**
 * Proxy width cap. 1920 covers full-frame clips on the typical canvas without
 * an upscale — the preview used to read a 960-wide proxy for a 1920 canvas
 * and magnify it 2x, which is exactly the "video looks blurry" report
 * (upstream #573). 4K sources still step down, so the interactive benefit
 * survives.
 */
export const PROXY_WIDTH_CAP = 1920;

/** Quality knob for the proxy transcode: high enough to survive a 2x preview zoom. */
export const PROXY_CRF = '20';

/** FFmpeg arguments for a 1080p-ish mezzanine proxy with re-encoded audio. */
export function proxyArgs(sourcePath: string, outputPath: string): string[] {
  return [
    '-y',
    '-i', sourcePath,
    '-vf', `scale='min(${PROXY_WIDTH_CAP},iw)':-2`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', PROXY_CRF,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ];
}
