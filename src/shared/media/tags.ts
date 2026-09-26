/**
 * Local media tags — on-device labels for the media library (upstream #118).
 *
 * Upstream ships AI-generated tags and AI descriptions for every asset, backed
 * by on-device + cloud models. That stack does not exist here, and treating
 * the gap as "no labels at all" leaves the library unsearchable beyond the
 * filename. The Windows translation is a zero-cost heuristic that labels each
 * asset from data already on disk: type, codec, dimensions, duration, and
 * filename tokens. No network, no model download, no paid service — the tags
 * are derived synchronously at display/search time so they add browsing value
 * without persisting or migrating data.
 *
 * Two buckets:
 * - technical tags (resolution bucket, orientation, duration bucket, codec) —
 *   stable, low-cardinality, useful as filters;
 * - keyword tags (filename tokens) — higher-cardinality, useful as search.
 */

import type { MediaAsset } from '../types/project';

function resolutionBucket(asset: MediaAsset): string | null {
  const w = asset.width;
  const h = asset.height;
  if (typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) return null;
  const pixels = w * h;
  if (pixels >= 3840 * 2160) return '4K';
  if (pixels >= 2560 * 1440) return '1440p';
  if (pixels >= 1920 * 1080) return '1080p';
  if (pixels >= 1280 * 720) return '720p';
  if (pixels >= 854 * 480) return '480p';
  return 'low-res';
}

function orientationTag(asset: MediaAsset): string | null {
  const w = asset.width;
  const h = asset.height;
  if (typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) return null;
  if (w > h) return 'landscape';
  if (h > w) return 'portrait';
  return 'square';
}

function durationBucket(asset: MediaAsset): string | null {
  const duration = asset.duration;
  if (typeof duration !== 'number' || duration <= 0) return null;
  const fps = asset.fps ?? 30;
  const seconds = duration / fps;
  if (seconds < 3) return 'very-short';
  if (seconds < 15) return 'short';
  if (seconds < 60) return 'medium';
  if (seconds < 300) return 'long';
  return 'very-long';
}

function filenameKeywords(filename: string): string[] {
  const stem = filename.replace(/\.[^.]+$/, '');
  // Split on anything non-alphanumeric, drop short/pure-numeric tokens, lower-case.
  const tokens = stem
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t));
  // De-dupe preserving order, cap to avoid filename spam.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * All tags for an asset, lower-cased. Technical tags first, then keywords.
 * Empty when the asset carries no derivable signal.
 */
export function deriveTags(asset: MediaAsset): string[] {
  const tags: string[] = [];

  // Stable type tag — mirrors the library's own type filter, but useful when
  // the search box is the only affordance.
  tags.push(asset.type);

  const res = resolutionBucket(asset);
  if (res) tags.push(res.toLowerCase());
  const orient = orientationTag(asset);
  if (orient) tags.push(orient);
  const dur = durationBucket(asset);
  if (dur) tags.push(dur);
  if (asset.codec) tags.push(asset.codec.toLowerCase());
  if (asset.audioCodec) tags.push(asset.audioCodec.toLowerCase());
  if (asset.generatedBy) {
    tags.push('ai-generated');
    tags.push(asset.generatedBy.provider.toLowerCase());
  }

  for (const kw of filenameKeywords(asset.filename)) tags.push(kw);

  // De-dupe while preserving technical-first order.
  return [...new Set(tags)];
}

/**
 * True when a lower-cased query matches any tag, the filename, or the AI
 * description. Used by the media grid filter so the search box benefits from
 * tags without a separate filter UI; descriptions match as plain substrings
 * the same way tags do.
 */
export function assetMatchesQuery(asset: MediaAsset, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  if (asset.filename.toLowerCase().includes(normalizedQuery)) return true;
  if (
    typeof asset.aiDescription === 'string'
    && asset.aiDescription.toLowerCase().includes(normalizedQuery)
  ) {
    return true;
  }
  return deriveTags(asset).some((tag) => tag.includes(normalizedQuery));
}
