/**
 * Pure FFmpeg export argument builder (upstream PR #546).
 *
 * Split out of main/media/exporter.ts so the graph construction is unit-testable
 * without Electron. One behavioral change against the pre-consolidation
 * builder: each unique source path becomes exactly ONE `-i` input, shared by
 * every clip referencing it ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â previously N clips from one source spawned N
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
import { escapeDrawtext, drawtextStyleParams, applyTitleFontCase } from '../../shared/editor/title';
import { colorGradeOf, toFfmpegEq } from '../../shared/editor/color-grade';
import { ffmpegPanFilter, clampPan } from '../../shared/audio/pan';
import { isCropped, cropRect } from '../../shared/media/source-crop';
import { motionExpression } from '../../shared/media/motion';
import { hasEdgeEffects, buildEdgeGeqExpr } from '../../shared/editor/edge-effects';
import { chromaKeyOf, buildChromaKeyFilterChain } from '../../shared/editor/chroma-key';

export interface ExportArgOptions {
  outputPath: string;
  format: 'mp4' | 'mov' | 'webm' | 'audio';
  quality: 'draft' | 'normal' | 'high';
  /** Timeline range export: only frames in [start, end) are rendered. */
  range?: { start: number; end: number };
  /**
   * Renderer-baked advanced title layers (#525/#529), keyed by clip id.
   * A listed clip composites from its PNG instead of drawtext; an advanced
   * clip without an entry degrades to drawtext color styling rather than
   * failing the export.
   */
  bakedTitles?: ReadonlyArray<{ clipId: string; path: string }>;
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

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Hardware encoders (R2 capability detection) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

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

  // One input per unique source path, in first-use order (#546). Baked title
  // PNGs join the same registry but stream as looping stills, so overlay/
  // blend nodes fed from them never end before the canvas does.
  const inputIndexByPath = new Map<string, number>();
  const inputPreFlagsByPath = new Map<string, string[]>();
  const inputIndexFor = (assetPath: string): number => {
    const existing = inputIndexByPath.get(assetPath);
    if (existing !== undefined) return existing;
    const index = 1 + inputIndexByPath.size;
    inputIndexByPath.set(assetPath, index);
    return index;
  };
  const inputIndexForStill = (assetPath: string): number => {
    const index = inputIndexFor(assetPath);
    if (!inputPreFlagsByPath.has(assetPath)) inputPreFlagsByPath.set(assetPath, ['-loop', '1']);
    return index;
  };
  const assetOf = (clip: Clip) => project.media.find((m) => m.id === clip.assetId);

  const bakedByClipId = new Map(
    (options.bakedTitles ?? []).map((entry) => [entry.clipId, entry.path] as const),
  );

  const args: string[] = ['-y']; // overwrite output
  const audioOnly = options.format === 'audio';

  if (audioOnly && audioClips.length === 0) {
    throw new Error('No audio to export ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â every eligible audio clip is missing or muted.');
  }

  // Input 0: blank canvas as base (video exports only).
  if (!audioOnly) {
    args.push('-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${duration}:r=${fps}`);
  }

  // Register inputs in clip order so indices are deterministic.
  for (const clip of videoClips) {
    const bakedPath = bakedByClipId.get(clip.id);
    if (bakedPath) {
      inputIndexForStill(bakedPath);
      continue;
    }
    const asset = assetOf(clip);
    if (asset) inputIndexFor(asset.path);
  }
  for (const clip of audioClips) {
    const asset = assetOf(clip);
    if (asset) inputIndexFor(asset.path);
  }
  for (const inputPath of inputIndexByPath.keys()) {
    for (const flag of inputPreFlagsByPath.get(inputPath) ?? []) args.push(flag);
    args.push('-i', inputPath);
  }

  // Build filter_complex ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â one graph covering video chains and, when audio
  // clips are eligible, the timed audio mix. Audio previously mapped raw
  // full-source streams: no trim, no start offset, no volume ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â every music
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
      const pan = clampPan(clip.pan ?? 0);
      if (pan !== 0) {
        // Balance-style pan (R5): attenuate one channel toward the other.
        chain += `,${ffmpegPanFilter(pan)}`;
      }
      if (delayMs > 0) {
        chain += `,adelay=${delayMs}:all=1`;
      }
      // Audio fades mirror the clip's visual fade fields so audio clips
      // sound professional without a separate mixing pass (R5).
      if (clip.fadeInFrames && clip.fadeInFrames > 0) {
        const d = clip.fadeInFrames / fps;
        chain += `,afade=t=in:st=0:d=${d.toFixed(4)}`;
      }
      if (clip.fadeOutFrames && clip.fadeOutFrames > 0) {
        const st = Math.max(0, (clip.durationFrames - clip.fadeOutFrames) / fps);
        const d = clip.fadeOutFrames / fps;
        chain += `,afade=t=out:st=${st.toFixed(4)}:d=${d.toFixed(4)}`;
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

  // Title drawtext chains (R3): each takes the current video output and
  // emits the next label, so stacking order matches title order. Titles are
  // centered; escaping lives in shared/editor/title.ts.
  let currentVideo: string;
  if (videoClips.length > 0) {
    currentVideo = '[vout]';
  } else if (!audioOnly) {
    currentVideo = '0:v';
  } else {
    currentVideo = ''; // audio-only exports have no video output
  }

  if (!audioOnly) {
    let titleIndex = 0;
    for (const clip of sortedClips) {
      if (clip.type !== 'title' || !clip.text) continue;
      const outLabel = `[vt${titleIndex}]`;
      const startSec = (clip.startFrame / fps).toFixed(4);
      const endSec = ((clip.startFrame + clip.durationFrames) / fps).toFixed(4);

      // Advanced titles composite from their baked full-canvas RGBA (#525/
      // #529): footage overlays a band with knocked-out glyphs; inverted
      // difference-blends a white silhouette. Fades ride alpha on the bake.
      const bakedPath = bakedByClipId.get(clip.id);
      if (bakedPath) {
        const inputIdx = inputIndexByPath.get(bakedPath)!;
        let chain = `[${inputIdx}:v]format=rgba`;
        if (clip.opacity !== undefined && clip.opacity !== 1) {
          chain += `,colorchannelmixer=aa=${Math.min(1, Math.max(0, clip.opacity)).toFixed(4)}`;
        }
        if (clip.fadeInFrames && clip.fadeInFrames > 0) {
          chain += `,fade=t=in:st=0:d=${(clip.fadeInFrames / fps).toFixed(4)}:alpha=1`;
        }
        if (clip.fadeOutFrames && clip.fadeOutFrames > 0) {
          const st = Math.max(0, (clip.durationFrames - clip.fadeOutFrames) / fps);
          chain += `,fade=t=out:st=${st.toFixed(4)}:d=${(clip.fadeOutFrames / fps).toFixed(4)}:alpha=1`;
        }
        const baked = `[bk${titleIndex}]`;
        filters.push(`${chain}${baked}`);
        if (clip.titleFillMode === 'inverted') {
          filters.push(`${currentVideo}${baked}blend=all_mode=difference${outLabel}`);
        } else {
          filters.push(
            `${currentVideo}${baked}overlay=eof_action=pass`
            + `:enable='between(t,${startSec},${endSec})'${outLabel}`,
          );
        }
        currentVideo = outLabel;
        titleIndex += 1;
        continue;
      }

      const styleParams = drawtextStyleParams(clip, height);
      const align = clip.titleAlign ?? 'center';
      const xExpr = align === 'left'
        ? `${Math.round(clip.x)}`
        : align === 'right'
          ? `w-text_w-${Math.round(clip.x + clip.width)}`
          : '(w-text_w)/2';
      filters.push(
        `${currentVideo}drawtext=text='${escapeDrawtext(applyTitleFontCase(clip.text, clip.titleFontCase))}'`
        + `:fontsize=${Math.round((clip.titleSizeRatio ?? 0.09) * height)}`
        + `:fontcolor=${clip.titleColor ?? 'white'}`
        + `:x=${xExpr}:y=(h-text_h)/2`
        + `:enable='between(t,${startSec},${endSec})'`
        + styleParams
        + `${outLabel}`,
      );
      currentVideo = outLabel;
      titleIndex += 1;
    }
    if (filters.length > 0) {
      args.push('-filter_complex', filters.join(';'));
    }
    args.push('-map', currentVideo);
  } else if (audioMap) {
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
    // Rotation uses the same per-frame seconds as the overlay expressions.
    const rotSecPerFrame = 1 / fps;

    // Rotation (static + animated, keyframes v1): applied to the scaled RGBA
    // frame with a transparent fill (c=black@0), so rotated corners composite
    // over the layers below exactly like the canvas preview's ctx.rotate.
    // Closes the long-standing "rotation dropped" gap noted here since R2.
    const rotDegExpr = motionExpression(clip.motionRot, rotSecPerFrame)
      ?? (clip.rotation !== 0 ? clip.rotation.toFixed(6) : null);
    const rotateChain = rotDegExpr
      ? `,rotate='(${rotDegExpr})*PI/180':c=black@0`
      : '';

    // Chroma key (#97): must run before rotate/edge-rounding. FFmpeg's
    // colorkey/despill overwrite alpha unconditionally rather than
    // multiplying it, so applying them after rotation's transparent-corner
    // fill or edge rounding's feathered mask would stomp those pixels back
    // to opaque.
    const chromaKey = chromaKeyOf(clip);
    const chromaChain = chromaKey ? `,${buildChromaKeyFilterChain(chromaKey)}` : '';

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

    // Scale/transform — animated scale uses FFmpeg expressions in output seconds.
    const scaleXExpr = motionExpression(clip.motionScaleX, rotSecPerFrame);
    const scaleYExpr = motionExpression(clip.motionScaleY, rotSecPerFrame);
    const scaledW = Math.round(clip.width * clip.scaleX);
    const scaledH = Math.round(clip.height * clip.scaleY);
    const scaleWExpr = scaleXExpr
      ? `(${clip.width.toFixed(1)})*(${scaleXExpr})`
      : `${scaledW}`;
    const scaleHExpr = scaleYExpr
      ? `(${clip.height.toFixed(1)})*(${scaleYExpr})`
      : `${scaledH}`;

    // Static crop (#568) in source-pixel space, ahead of scale — matching the
    // preview's proportional sub-rect of the uniformly scaled decode. Skipped
    // when the source never reported dimensions.
    let cropChain = '';
    if (isCropped(clip.crop) && asset.width && asset.height) {
      const rect = cropRect(clip.crop, asset.width, asset.height);
      cropChain = `,crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}`;
    }

    // Transition fades ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â applied in the clip's own (0-based, post-setpts) time
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
      // Color grading (R4): eq filter after scale, before fades.
      const grade = colorGradeOf(clip);
      let colorChain = '';
      if (grade) {
        const eq = toFfmpegEq(grade);
        if (eq) colorChain = `,${eq}`;
      }

      // Edge rounding and softness (#369): geq filter on the alpha channel,
      // applied after scale/rotate/colour-grade but before fades and overlay.
      let edgeChain = '';
      if (hasEdgeEffects(clip)) {
        const edgeExpr = buildEdgeGeqExpr(
          clip.edgeRounding ?? 0,
          clip.edgeSoftness ?? 0,
          scaledW,
          scaledH,
        );
        if (edgeExpr && edgeExpr !== 'alpha(X,Y)') {
          edgeChain = `,geq='r=r(X,Y):g=g(X,Y):b=b(X,Y):a=${edgeExpr}'`;
        }
      }

      filters.push(
        `[${trimmedLabel}]fps=${fps},format=rgba${cropChain},scale='${scaleWExpr}':'${scaleHExpr}':flags=bilinear${chromaChain}${rotateChain}${colorChain}${edgeChain}${fadeChain}[${scaledLabel}]`,
      );

    // Overlay with enable condition (time window). Motion tracks (#535 v1)
    // drive x/y via piecewise-linear expressions in output seconds; the
    // expression is clamped outside the first/last keyframe, matching the
    // preview's evaluateMotion exactly.
    const secPerFrame = 1 / fps;
    const motionXExpr = motionExpression(clip.motionX, secPerFrame);
    const motionYExpr = motionExpression(clip.motionY, secPerFrame);
    const posX = motionXExpr ?? `${Math.round(clip.x)}`;
    const posY = motionYExpr ?? `${Math.round(clip.y)}`;
    filters.push(
      `[${lastLabel}][${scaledLabel}]overlay=x=${posX}:y=${posY}:enable='between(t,${inTime.toFixed(4)},${outTime.toFixed(4)})'${overlayOut}`,
    );

    if (i < videoClips.length - 1) {
      lastLabel = `v${i}out`;
    }
  }

  return filters.join(';');
}
