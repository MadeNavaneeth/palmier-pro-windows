/**
 * FCPXML export (upstream #154) â€” project â†’ Final Cut Pro XML 1.11.
 *
 * Scope is deliberately minimal and honest about it: the goal is opening a
 * Palmier timeline in Resolve / FCP / Premiere with picture, audio, and title
 * TEXT intact. Effects, blend modes, grades, keyframes, and tilt are NOT
 * represented â€” importers treat their absence as plain clips rather than
 * failing.
 *
 * Mapping contract (mirrored by the future importer):
 *   - lowest visible video track  â†’ spine asset-clips
 *   - higher video tracks         â†’ connected asset-clips, lane = track index
 *   - audio clips                 â†’ connected asset-clips, audioRole=dialogue,
 *                                   negative lanes below the spine
 *   - title clips                 â†’ <title> with per-clip <text-style-def>
 *
 * Timing uses decimal seconds ("12.345678s") rather than rationals: project
 * fps can be fractional (29.97), and rational timebases would silently
 * resync every clip. Microsecond precision matches FCP's internal tick.
 */

import type { Project, Clip, MediaAsset } from '../types/project';

const SEC_PRECISION = 6;

function sec(frames: number, fps: number): string {
  return `${(frames / fps).toFixed(SEC_PRECISION)}s`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeXml(value).replace(/"/g, '&quot;');
}

/** file:// URL for an absolute Windows/POSIX path. */
function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return encodeURI(`file:///${normalized.replace(/^\/+/, '')}`).replace(/#/g, '%23');
}

function assetHasAudio(asset: MediaAsset): boolean {
  if (asset.type === 'audio') return true;
  if (asset.type === 'image') return false;
  return Boolean(asset.audioCodec);
}

function assetHasVideo(asset: MediaAsset): boolean {
  return asset.type === 'video' || asset.type === 'image';
}

interface TrackInfo {
  id: string;
  kind: 'video' | 'audio';
  /** Track order for layering (video) or stacking (audio). */
  order: number;
  index: number;
}

function describeTracks(project: Project): TrackInfo[] {
  return project.timeline.tracks.map((track, index) => ({
    id: track.id,
    kind: track.type,
    order: track.order,
    index,
  }));
}

/**
 * Export the supported subset of a project as FCPXML 1.11 text.
 * Throws only when there is nothing representable at all (no clips).
 */
export function exportFcpxml(project: Project): string {
  const fps = project.settings.fps;
  const { width, height } = project.settings;
  const tracks = describeTracks(project);

  const sortedClips = [...project.timeline.clips].sort((a, b) => {
    const ta = tracks.find((t) => t.id === a.trackId);
    const tb = tracks.find((t) => t.id === b.trackId);
    return (ta?.order || 0) - (tb?.order || 0);
  });

  // One <asset> resource per unique file (slash-normalized), first-use order.
  const assetsByPath = new Map<string, { id: number; asset: MediaAsset }>();
  let nextResourceId = 2; // 1 is reserved for the project format

  const resourceIdFor = (clip: Clip): number | null => {
    const asset = project.media.find((m) => m.id === clip.assetId);
    if (!asset) return null;
    const key = asset.path.replace(/\\/g, '/').toLowerCase();
    const existing = assetsByPath.get(key);
    if (existing) return existing.id;
    const id = nextResourceId++;
    assetsByPath.set(key, { id, asset });
    return id;
  };
  for (const clip of sortedClips) void resourceIdFor(clip);

  if (sortedClips.length === 0) {
    throw new Error('No clips to export â€” the timeline is empty.');
  }

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE fcpxml>');
  lines.push(
    `<fcpxml version="1.11"><resources><format id="r1" frameDuration="${(1 / fps).toFixed(SEC_PRECISION)}s" width="${width}" height="${height}"/>`,
  );

  // Formats for non-project-sized sources would matter to conforming apps'
  // scaling UI; Palmier composites everything at the project canvas, so a
  // single format is truthful here.
  for (const { id, asset } of assetsByPath.values()) {
    const flags = [
      assetHasVideo(asset) ? 'hasVideo="1"' : null,
      assetHasAudio(asset) ? 'hasAudio="1"' : null,
    ].filter(Boolean).join(' ');
    const durSec = asset.duration > 0 ? `${asset.duration.toFixed(SEC_PRECISION)}s` : '0s';
    lines.push(
      `<asset id="${id}" name="${escapeAttr(asset.filename)}" src="${escapeAttr(fileUrl(asset.path))}"`
      + ` start="0s" duration="${durSec}" ${flags} format="r1"/>`,
    );
  }

  // â”€â”€ Library / event / spine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  lines.push(
    `</resources><library><event name="${escapeAttr(project.name || 'Palmier Project')}"><project name="${escapeAttr(project.name || 'Palmier Project')}">`,
  );

  const bodyLines: string[] = [];
  const videoTrackIds = tracks.filter((t) => t.kind === 'video');
  const spineTrackId = videoTrackIds.length > 0
    ? videoTrackIds.reduce((low, t) => (t.order < low.order ? t : low)).id
    : null;
  const audioTracks = tracks.filter((t) => t.kind === 'audio');

  let styleSeq = 0;
  const styleDefs: string[] = [];

  for (const clip of sortedClips) {
    const track = tracks.find((t) => t.id === clip.trackId);
    const offset = sec(clip.startFrame, fps);
    const duration = sec(clip.durationFrames, fps);
    const sourceIn = sec(clip.inPoint, fps);

    // Titles are Palmier-native and carry no media resource; they must be
    // handled before the resource lookup, which would otherwise skip them.
    if (clip.type === 'title') {
      styleSeq += 1;
      const styleId = `ts${styleSeq}`;
      const sizePx = Math.round((clip.titleSizeRatio ?? 0.09) * height);
      const fontColor = (clip.titleColor ?? '#ffffff').toUpperCase();
      const fontFamily = clip.titleFontFamily ?? 'sans-serif';
      const align = clip.titleAlign ?? 'center';
      const text = applyCase(clip.text ?? '', clip.titleFontCase);

      styleDefs.push(
        `<text-style-def id="${styleId}"><text-style font="${escapeAttr(fontFamily)}"`
        + ` fontSize="${sizePx}" fontColor="${fontColor}" alignment="${align.toUpperCase()}"/>`
        + `</text-style-def>`,
      );
      bodyLines.push(
        `<title name="${escapeAttr(text.slice(0, 60))}" lane="0" offset="${offset}"`
        + ` duration="${duration}" ref="${styleId}" start="${sourceIn}">`
        + `<text><text-style ref="${styleId}">${escapeXml(text)}</text-style></text>`
        + `</title>`,
      );
      continue;
    }

    const resourceId = resourceIdFor(clip);
    if (!resourceId) continue;

    if (clip.type === 'audio' || track?.kind === 'audio') {
      const audioLane = -(1 + Math.max(0, audioTracks.findIndex((t) => t.id === clip.trackId)));
      bodyLines.push(
        `<asset-clip name="${escapeAttr(clip.label || 'Audio')}" lane="${audioLane}"`
        + ` offset="${offset}" duration="${duration}" start="${sourceIn}"`
        + ` ref="${resourceId}" audioRole="dialogue"/>`,
      );
      continue;
    }

    // Visual clip on the spine track vs a connected upper track. Lanes are
    // dense among upper tracks (1..N) so FCP stacks them in track order.
    const onSpine = clip.trackId === spineTrackId;
    let laneAttr = '';
    if (!onSpine) {
      const upperRank = videoTrackIds
        .filter((t) => t.id !== spineTrackId)
        .sort((a, b) => a.order - b.order)
        .findIndex((t) => t.id === clip.trackId);
      laneAttr = ` lane="${Math.max(0, upperRank) + 1}"`;
    }
    bodyLines.push(
      `<asset-clip name="${escapeAttr(clip.label || 'Clip')}"${laneAttr}`
      + ` offset="${offset}" duration="${duration}" start="${sourceIn}"`
      + ` ref="${resourceId}"/>`,
    );
  }

  lines.push(`<spine>${bodyLines.join('')}</spine></project></event></library>`);
  for (const def of styleDefs.reverse()) lines.push(def);
  lines.push('</fcpxml>');

  return lines.join('');
}

/** Case transform mirroring the render paths (#330). */
function applyCase(text: string, mode?: 'original' | 'upper' | 'lower'): string {
  if (mode === 'upper') return text.toUpperCase();
  if (mode === 'lower') return text.toLowerCase();
  return text;
}

