/**
 * Pure FFmpeg export argument builder (upstream PR #546).
 *
 * Split out of main/media/exporter.ts so the graph construction is unit-testable
 * without Electron. One behavioral change against the pre-consolidation
 * builder: each unique source path becomes exactly ONE `-i` input, shared by
 * every clip referencing it â€” previously N clips from one source spawned N
 * full decodes. FFmpeg fans a single input out to multiple filter chains, so
 * per-clip trim/scale/overlay semantics are unchanged; audio `-map`s likewise
 * address the consolidated index.
 *
 * Input 0 is always the blank canvas; source inputs start at 1 in first-use
 * order across the sorted video clips, then the audio clips.
 */

import type { Project, Clip } from '../../shared/types/project';
import {
  assetDurationSeconds,
  clampSourceSeconds,
  clipTrimSeconds,
} from '../../shared/media/source-time';
import { selectExportClips } from '../../shared/media/export-eligibility';

export interface ExportArgOptions {
  outputPath: string;
  format: 'mp4' | 'mov' | 'webm' | 'audio';
  quality: 'draft' | 'normal' | 'high';
  /** Timeline range export: only frames in [start, end) are rendered. */
  range?: { start: number; end: number };
}

/**
 * Project the eligible clip list into a timeline range: clips are clipped to
 * the span, source In/Out shifted proportionally for partial overlaps, and
 * start frames rebased so the range begins at frame zero.
 */
function projectClipsIntoRange(
  clips: Clip[],
  range: { start: number; end: number },
): Clip[] {
  const out: Clip[] = [];
  for (const clip of clips) {
    const overlapStart = Math.max(clip.startFrame, range.start);
    const overlapEnd = Math.min(clip.startFrame + clip.durationFrames, range.end);
    if (overlapEnd <= overlapStart) continue;
    const sourceOffset = overlapStart - clip.startFrame;
    const localDuration = overlapEnd - overlapStart;
    out.push({
      ...clip,
      startFrame: overlapStart - range.start,
      durationFrames: localDuration,
      inPoint: clip.inPoint + sourceOffset,
      outPoint: clip.inPoint + sourceOffset + localDuration,
    });
  }
  return out;
}

// ─── Hardware encoders (R2 capability detection) ─────────────────────────────

export type HwEncoder = 'x264' | 'nvenc' | 'qsv' | 'amf';

/** Bitrate tiers for hardware encoders, which lack x264-style CRF tiers. */
const HW_BITRATE_K: Record<'draft' | 'normal' | 'high', string> = {
  draft: '8M',
  normal: '16M',
  high: '30M',
};

/**
 * Video codec arguments for an MP4 export under a chosen encoder.
 *
 * MOV/ProRes and WebM/VP9 have no hardware path here and fall through to
 * their software presets regardless of `hw` -- callers should disable the
 * selector for those formats.
 */
export function videoCodecArgs(
  format: 'mp4' | 'mov' | 'webm' | 'audio',
  quality: 'draft' | 'normal' | 'high',
  hw: HwEncoder = 'x264',
): string[] {
  if (format === 'audio') return [];
  if (format !== 'mp4' || hw === 'x264') {
    return PRESETS[format]?.[quality] ?? PRESETS.mp4[quality];
  }
  const bitrate = HW_BITRATE_K[quality];
  switch (hw) {
    case 'nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', quality === 'high' ? '21' : quality === 'normal' ? '24' : '27', '-b:v', '0'];
    case 'qsv':
      return ['-c:v', 'h264_qsv', '-preset', quality === 'high' ? 'veryslow' : quality === 'normal' ? 'medium' : 'veryfast', '-global_quality', quality === 'high' ? '22' : quality === 'normal' ? '25' : '28'];
    case 'amf':
      return ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', quality === 'high' ? 'quality' : quality === 'normal' ? 'balanced' : 'speed', '-b:v', bitrate];
  }
}

type GeometryFilterFn = (
  x: number, y: number,
  width: number, height: number,
  rotation: number,
  scaleX: number, scaleY: number,
) => string;

const PRESETS: Record<string, Record<string, string[]>> = {
  audio: {}, // audio-only exports use the shared -c:a flags below
  mp4: {
    draft: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28'],
    normal: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'],
    high: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-level', '5.1'],
  },
  mov: {
    draft: ['-c:v', 'prores_ks', '-profile:v', '0'], // ProRes Proxy
    normal: ['-c:v', 'prores_ks', '-profile:v', '2'], // ProRes LT
    high: ['-c:v', 'prores_ks', '-profile:v', '3'], // ProRes HQ
  },
  webm: {
    draft: ['-c:v', 'libvpx-vp9', '-crf', '35', '-b:v', '0', '-deadline', 'realtime'],
    normal: ['-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0', '-deadline', 'good'],
    high: ['-c:v', 'libvpx-vp9', '-crf', '20', '-b:v', '0', '-deadline', 'best'],
  },
};

/** Build the complete FFmpeg argument list for one export. */
export function buildFfmpegArgs(
  project: Project,
  options: ExportArgOptions & { hw?: HwEncoder },
  width: number,
  height: number,
  fps: number,
  totalFrames: number,
  /** Reserved: native pixel-exact geometry (see NOTE above -- not consumed yet). */
  _exportFilterGeometry: GeometryFilterFn | null,
): string[] {
  const { outputPath } = options;
  // Same eligibility list as the extent calculation: a muted audio clip must
  // produce no input and no -map at all (upstream #544), not a zero-gain
  // stream some muxers choke on.
  let eligible = selectExportClips(project);
  let total = totalFrames;
  if (options.range) {
    if (options.range.end <= options.range.start) {
      throw new Error('Export range end must be greater than start.');
    }
    eligible = projectClipsIntoRange(eligible, options.range);
    total = options.range.end - options.range.start;
  }
  const duration = total / fps;

  // Sort clips by track order for proper layering.
  const sortedClips = [...eligible].sort((a, b) => {
    const trackA = project.timeline.tracks.find((t) => t.id === a.trackId);
    const trackB = project.timeline.tracks.find((t) => t.id === b.trackId);
    return (trackA?.order || 0) - (trackB?.order || 0);
  });

  const videoClips = options.format === 'audio' ? [] : sortedClips.filter((c) => c.type !== 'audio');
  const audioClips = sortedClips.filter((c) => c.type === 'audio');

  // One input per unique source path, in first-use order (#546).
  const inputIndexByPath = new Map<string, number>();
  const inputIndexFor = (assetPath: string): number => {
    const existing = inputIndexByPath.get(assetPath);
    if (existing !== undefined) return existing;
    const index = 1 + inputIndexByPath.size;
    inputIndexByPath.set(assetPath, index);
    return index;
  };
  const assetOf = (clip: Clip) => project.media.find((m) => m.id === clip.assetId);

  const args: string[] = ['-y']; // overwrite output
  const audioOnly = options.format === 'audio';

  if (audioOnly && audioClips.length === 0) {
    throw new Error('No audio to export â€” every eligible audio clip is missing or muted.');
  }

  // Input 0: blank canvas as base (video exports only).
  if (!audioOnly) {
    args.push('-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${duration}:r=${fps}`);
  }

  // Register inputs in clip order so indices are deterministic.
  for (const clip of videoClips) {
    const asset = assetOf(clip);
    if (asset) inputIndexFor(asset.path);
  }
  for (const clip of audioClips) {
    const asset = assetOf(clip);
    if (asset) inputIndexFor(asset.path);
  }
  for (const inputPath of inputIndexByPath.keys()) {
    args.push('-i', inputPath);
  }

  // Build filter_complex â€” one graph covering video chains and, when audio
  // clips are eligible, the timed audio mix. Audio previously mapped raw
  // full-source streams: no trim, no start offset, no volume â€” every music
  // bed played from source zero over the whole export. The per-clip chain
  // below shares the video side's source-time mapping (#68), so export and
  // preview address a clip's audio identically.
  const filters: string[] = [];
  if (videoClips.length > 0) {
    filters.push(buildFilterGraph(project, videoClips, width, height, fps, inputIndexByPath, _exportFilterGeometry));
  }

  let audioMap: string | null = null;
  if (audioClips.length > 0) {
    const labels: string[] = [];
    for (const clip of audioClips) {
      const asset = assetOf(clip);
      if (!asset) continue;
      const inputIdx = inputIndexByPath.get(asset.path)!;
      const sourceDuration = assetDurationSeconds(asset, fps);
      const trim = clipTrimSeconds(clip, fps);
      const trimStart = clampSourceSeconds(trim.start, sourceDuration, asset?.fps);
      const clampedEnd = sourceDuration > 0 ? Math.min(trim.end, sourceDuration) : trim.end;
      const trimEnd = Math.max(clampedEnd, trimStart + 1 / fps);
      const delayMs = Math.max(0, Math.round((clip.startFrame / fps) * 1000));

      let chain =
        `[${inputIdx}:a]atrim=start=${trimStart.toFixed(4)}:end=${trimEnd.toFixed(4)},asetpts=PTS-STARTPTS`;
      if (Number.isFinite(clip.volume) && clip.volume >= 0 && clip.volume !== 1) {
        chain += `,volume=${Math.min(1, clip.volume).toFixed(4)}`;
      }
      if (delayMs > 0) {
        chain += `,adelay=${delayMs}:all=1`;
      }
      const label = `a${labels.length}`;
      filters.push(`${chain}[${label}]`);
      labels.push(`[${label}]`);
    }

    if (labels.length === 1) {
      audioMap = labels[0];
    } else if (labels.length > 1) {
      // normalize=0 keeps each input at its own level instead of dividing by
      // the number of inputs; dropout_transition is meaningless with it.
      filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0[aout]`);
      audioMap = '[aout]';
    }
  }

  if (filters.length > 0) {
    args.push('-filter_complex', filters.join(';'));
  }
  if (audioOnly) {
    // Audio-only: the mix chain is the whole output; the shared push below
    // emits the single -map.
  } else if (videoClips.length > 0) {
    args.push('-map', `[vout]`);
  } else {
    args.push('-map', '0:v');
  }
  if (audioMap) {
    args.push('-map', audioMap);
  }

  // Output settings
  if (!audioOnly) {
    const codecArgs = videoCodecArgs(options.format, options.quality, options.hw);
    args.push(...codecArgs);
  }

  // Audio codec
  if (options.format === 'webm') {
    args.push('-c:a', 'libopus');
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k');
  }

  // Duration limit and output
  args.push('-t', duration.toFixed(4));
  args.push(outputPath);

  return args;
}

function buildFilterGraph(
  project: Project,
  videoClips: Clip[],
  _canvasWidth: number,
  _canvasHeight: number,
  fps: number,
  inputIndexByPath: Map<string, number>,
  _exportFilterGeometry: GeometryFilterFn | null,
): string {
  const filters: string[] = [];
  let lastLabel = '0:v';

  for (let i = 0; i < videoClips.length; i++) {
    const clip = videoClips[i];
    const asset = project.media.find((m) => m.id === clip.assetId);
    if (!asset) continue;
    const inputIdx = inputIndexByPath.get(asset.path)!;
    const inTime = clip.startFrame / fps;
    const outTime = (clip.startFrame + clip.durationFrames) / fps;

    // NOTE (tracked gap): the native addon exposes to_ffmpeg_filter with
    // rotation support, but this graph never consumed it -- exports have
    // used the inline scale+overlay below (rotation dropped) since before
    // the #546 refactor. Wiring rotate= here requires reworking the
    // per-chain frame sizing around rotw/roth; tracked as an R2
    // conformance-fixture item so preview/export rotation parity gets a
    // real test instead of a silent divergence.

    // Trim window in source seconds, through the shared mapping so export and
    // preview address the source identically (#68).
    const sourceDuration = assetDurationSeconds(asset, fps);
    const trim = clipTrimSeconds(clip, fps);
    const trimStart = clampSourceSeconds(trim.start, sourceDuration, asset?.fps);
    const clampedEnd = sourceDuration > 0 ? Math.min(trim.end, sourceDuration) : trim.end;
    // Clamping must never collapse the window: an empty FFmpeg trim range
    // renders the clip as nothing instead of failing loudly.
    const trimEnd = Math.max(clampedEnd, trimStart + 1 / fps);

    const trimmedLabel = `v${i}trimmed`;
    const scaledLabel = `v${i}scaled`;
    const overlayOut = i < videoClips.length - 1 ? `[v${i}out]` : '[vout]';

    // Trim filter
    filters.push(
      `[${inputIdx}:v]trim=start=${trimStart.toFixed(4)}:end=${trimEnd.toFixed(4)},setpts=PTS-STARTPTS[${trimmedLabel}]`,
    );

    // Scale/transform
    const scaledW = Math.round(clip.width * clip.scaleX);
    const scaledH = Math.round(clip.height * clip.scaleY);

    // Transition fades â€” applied in the clip's own (0-based, post-setpts) time
    // so they match the preview's effective-opacity ramp exactly. alpha=1 makes
    // the fade affect transparency so it composites over the layers below.
    let fadeChain = '';
    if (clip.fadeInFrames && clip.fadeInFrames > 0) {
      const d = clip.fadeInFrames / fps;
      fadeChain += `,fade=t=in:st=0:d=${d.toFixed(4)}:alpha=1`;
    }
    if (clip.fadeOutFrames && clip.fadeOutFrames > 0) {
      const d = clip.fadeOutFrames / fps;
      const st = (clip.durationFrames - clip.fadeOutFrames) / fps;
      fadeChain += `,fade=t=out:st=${st.toFixed(4)}:d=${d.toFixed(4)}:alpha=1`;
    }

    // Resample every source to the project frame rate before compositing.
    // `overlay` runs on the base input's timebase, so a 60 fps source dropped
    // onto a 30 fps canvas otherwise queues two source frames per output frame
    // and the encode crawls or stalls on long 4K clips (#68).
    filters.push(
      `[${trimmedLabel}]fps=${fps},scale=${scaledW}:${scaledH}:flags=bilinear,format=rgba${fadeChain}[${scaledLabel}]`,
    );

    // Overlay with enable condition (time window)
    filters.push(
      `[${lastLabel}][${scaledLabel}]overlay=x=${Math.round(clip.x)}:y=${Math.round(clip.y)}:enable='between(t,${inTime.toFixed(4)},${outTime.toFixed(4)})'${overlayOut}`,
    );

    if (i < videoClips.length - 1) {
      lastLabel = `v${i}out`;
    }
  }

  return filters.join(';');
}
