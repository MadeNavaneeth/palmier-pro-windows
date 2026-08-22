/**
 * Pure FFmpeg export argument builder (upstream PR #546).
 *
 * Split out of main/media/exporter.ts so the graph construction is unit-testable
 * without Electron. One behavioral change against the pre-consolidation
 * builder: each unique source path becomes exactly ONE `-i` input, shared by
 * every clip referencing it — previously N clips from one source spawned N
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
  format: 'mp4' | 'mov' | 'webm';
  quality: 'draft' | 'normal' | 'high';
}

type GeometryFilterFn = (
  x: number, y: number,
  width: number, height: number,
  rotation: number,
  scaleX: number, scaleY: number,
) => string;

const PRESETS: Record<string, Record<string, string[]>> = {
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
  options: ExportArgOptions,
  width: number,
  height: number,
  fps: number,
  totalFrames: number,
  exportFilterGeometry: GeometryFilterFn | null,
): string[] {
  const { outputPath } = options;
  // Same eligibility list as the extent calculation: a muted audio clip must
  // produce no input and no -map at all (upstream #544), not a zero-gain
  // stream some muxers choke on.
  const clips = selectExportClips(project);
  const duration = totalFrames / fps;

  // Sort clips by track order for proper layering.
  const sortedClips = [...clips].sort((a, b) => {
    const trackA = project.timeline.tracks.find((t) => t.id === a.trackId);
    const trackB = project.timeline.tracks.find((t) => t.id === b.trackId);
    return (trackA?.order || 0) - (trackB?.order || 0);
  });

  const videoClips = sortedClips.filter((c) => c.type !== 'audio');
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

  // Input 0: blank canvas as base.
  args.push('-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${duration}:r=${fps}`);

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

  // Build filter_complex — one graph covering video chains and, when audio
  // clips are eligible, the timed audio mix. Audio previously mapped raw
  // full-source streams: no trim, no start offset, no volume — every music
  // bed played from source zero over the whole export. The per-clip chain
  // below shares the video side's source-time mapping (#68), so export and
  // preview address a clip's audio identically.
  const filters: string[] = [];
  if (videoClips.length > 0) {
    filters.push(buildFilterGraph(project, videoClips, width, height, fps, inputIndexByPath, exportFilterGeometry));
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
  if (videoClips.length > 0) {
    args.push('-map', `[vout]`);
  } else {
    args.push('-map', '0:v');
  }
  if (audioMap) {
    args.push('-map', audioMap);
  }

  // Output settings
  const codecArgs = PRESETS[options.format]?.[options.quality] || PRESETS.mp4.normal;
  args.push(...codecArgs);

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
  exportFilterGeometry: GeometryFilterFn | null,
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

    // Get the geometry filter from the Rust native addon
    const geomFilter = exportFilterGeometry
      ? exportFilterGeometry(
          clip.x, clip.y,
          clip.width, clip.height,
          clip.rotation,
          clip.scaleX, clip.scaleY,
        )
      : // Fallback: simple scale + overlay
        (() => {
          const sw = Math.round(clip.width * clip.scaleX);
          const sh = Math.round(clip.height * clip.scaleY);
          return `scale=${sw}:${sh},overlay=x=${Math.round(clip.x)}:y=${Math.round(clip.y)}`;
        })();

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

    // Transition fades — applied in the clip's own (0-based, post-setpts) time
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
