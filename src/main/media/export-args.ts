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
 * order across the sorted video clips, then the audio clips. Audio-only
 * exports have no canvas, so their sources start at 0 instead.
 */

import type { Project, Clip } from '../../shared/types/project';
import {
  DEFAULT_BLEND_MODE,
  FFMPEG_BLEND_MODES,
  isBlendMode,
} from '../../shared/types/blend-mode';
import {
  assetDurationSeconds,
  clampSourceSeconds,
  clipTrimSeconds,
  effectiveSpeed,
} from '../../shared/media/source-time';
import { selectExportClips } from '../../shared/media/export-eligibility';
import {
  escapeDrawtext,
  drawtextStyleParams,
  applyTitleFontCase,
  isAdvancedTitle,
} from '../../shared/editor/title';
import { colorGradeOf, toFfmpegColorChain, toFfmpegPostLutChain, toFfmpegPreLutChain } from '../../shared/editor/color-grade';
import {
  effectsOf,
  toFfmpegBlurFilter,
  toFfmpegGlowBlendFilter,
  toFfmpegGlowScaleFilter,
  toFfmpegGlowThresholdFilter,
  toFfmpegGrainFilter,
  toFfmpegVignetteFilter,
} from '../../shared/editor/effects';
import { toFfmpegLutFilter } from '../../shared/editor/lut';
import { ffmpegPanFilter, clampPan } from '../../shared/audio/pan';
import { isCropped, cropRect } from '../../shared/media/source-crop';
import { motionExpression } from '../../shared/media/motion';
import { hasEdgeEffects, buildEdgeGeqExpr } from '../../shared/editor/edge-effects';
import { chromaKeyOf, buildChromaKeyFilterChain } from '../../shared/editor/chroma-key';
import { volumeFilterExpression } from '../../shared/audio/volume-keyframes';
import { eqOf, eqFilterChain } from '../../shared/audio/eq';
import { compressorOf, buildCompressorFilter } from '../../shared/audio/compressor';
import { noiseReductionOf, buildDenoiseFilter } from '../../shared/audio/denoise';
import { resolveRenderTimeline } from '../../shared/editor/compound';

export interface ExportArgOptions {
  outputPath: string;
  format: 'mp4' | 'mov' | 'webm' | 'audio';
  quality: 'draft' | 'normal' | 'high';
  /** Timeline range export: only frames in [start, end) are rendered. */
  range?: { start: number; end: number };
  /**
   * Renderer-baked layers (#525/#529, plus shape boxes), keyed by clip id.
   * A listed clip composites from its PNG instead of drawtext; an advanced
   * clip without an entry degrades to drawtext color styling rather than
   * failing the export, while a shape without an entry is skipped (vector
   * shapes have no filter-graph fallback). Both losses are reported through
   * `warnings` — a silent drop is a defect, not a fallback.
   */
  bakedTitles?: ReadonlyArray<{ clipId: string; path: string }>;
  /**
   * HDR delivery profile (upstream #59): absent/'sdr' keeps the Rec.709
   * 8-bit path byte-identical; 'hlg'/'pq' enable the HEVC Main10 +
   * BT.2020 conversion/tags. Validated strictly via parseHdrProfile.
   */
  hdr?: HdrProfile;
}

/**
 * Project the eligible clip list into a timeline range: clips are clipped to
 * the span, source In/Out shifted by effectiveSpeed for partial overlaps, and
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
    const speed = effectiveSpeed(clip.speed);
    const sourceOffset = (overlapStart - clip.startFrame) * speed;
    const localDuration = overlapEnd - overlapStart;
    out.push({
      ...clip,
      startFrame: overlapStart - range.start,
      durationFrames: localDuration,
      inPoint: clip.inPoint + sourceOffset,
      outPoint: clip.inPoint + sourceOffset + localDuration * speed,
    });
  }
  return out;
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬Â€ Hardware encoders (R2 capability detection) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬Â€

export type HwEncoder = 'x264' | 'nvenc' | 'qsv' | 'amf';

// ─── HDR export (upstream #59) ─────────────────────────────────────────────────

/**
 * HDR delivery profile on the export contract (upstream #59). Absent or
 * `'sdr'` is the unchanged Rec.709 8-bit passthrough; `'hlg'`/`'pq'` switch
 * the video codec to HEVC Main10 (yuv420p10le), convert the composited SDR
 * BT.709 frames to BT.2020 with the chosen transfer at the very end of the
 * shared filter graph, and tag the output (bt2020 / arib-std-b67 |
 * smpte2084 / bt2020nc). Mirrors upstream's HDRVideoExporter contract: an
 * SDR working space converted per frame to HLG — never a tag-only relabel.
 */
export type HdrProfile = 'sdr' | 'hlg' | 'pq';

/**
 * Strict parse at the argument-builder boundary: `undefined` means the SDR
 * default, anything else must already be a known profile. A present-but-
 * invalid value refuses loudly here (the agent schema is a zod enum and the
 * dialog restores only known values, so this only fires for hand-edited IPC
 * payloads or history records) — an encoder is never silently downgraded to
 * SDR after claiming HDR.
 */
export function parseHdrProfile(value: unknown): HdrProfile {
  if (value === undefined) return 'sdr';
  if (value === 'sdr' || value === 'hlg' || value === 'pq') return value;
  throw new Error(
    `Invalid HDR profile ${JSON.stringify(value)} — expected "hlg", "pq", or "sdr".`,
  );
}

/** FFmpeg transfer-characteristic name for an HDR profile. */
function hdrTransferTag(hdr: Exclude<HdrProfile, 'sdr'>): string {
  return hdr === 'hlg' ? 'arib-std-b67' : 'smpte2084';
}

/** Six-decimal speed spelling for FFmpeg's time-based filter expressions. */
function ffmpegSpeed(speed: number): string {
  return speed.toFixed(6);
}

/**
 * Audio tempo filter for a non-unit clip speed. `atempo` accepts 0.5–100, so
 * the model's lower bound (0.25) is expressed as two stages rather than an
 * invalid single filter. The 0.5 and 2 cases remain one filter each.
 */
function ffmpegAudioSpeed(speed: number): string {
  if (speed >= 0.5) return `atempo=${ffmpegSpeed(speed)}`;
  return `atempo=0.500000,atempo=${ffmpegSpeed(speed / 0.5)}`;
}

/** Display names for hardware-encoder refusal messages. */
const HW_NAMES: Record<HwEncoder, string> = {
  x264: 'Software (x264)',
  nvenc: 'NVIDIA NVENC',
  qsv: 'Intel QSV',
  amf: 'AMD AMF',
};

/**
 * HEVC Main10 codec args for an HDR export — the FFmpeg equivalent of
 * upstream's "HEVC 10-bit HDR" codec slot, carrying MP4 and MOV alike.
 * Quality maps to the same CRF tiers the SDR MP4 path uses; `hvc1` is the
 * QuickTime-compatible HEVC sample entry (FFmpeg otherwise defaults to
 * `hev1`, which QuickTime/Windows players may refuse).
 */
export function hdrVideoCodecArgs(quality: 'draft' | 'normal' | 'high'): string[] {
  const tier = quality === 'high'
    ? ['-preset', 'slow', '-crf', '16']
    : quality === 'draft'
      ? ['-preset', 'ultrafast', '-crf', '28']
      : ['-preset', 'medium', '-crf', '20'];
  return ['-c:v', 'libx265', ...tier, '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1'];
}

/** Output color-tag args for an HDR profile; SDR emits none (unchanged path). */
export function hdrColorTagArgs(hdr: Exclude<HdrProfile, 'sdr'>): string[] {
  return [
    '-color_primaries', 'bt2020',
    '-color_trc', hdrTransferTag(hdr),
    '-colorspace', 'bt2020nc',
  ];
}

/**
 * Final HDR conversion stage, appended after every clip/overlay/drawtext
 * chain so the SDR-graded composite (the graph's 8-bit BT.709 working space,
 * same space preview and grade run in) is converted to BT.2020 with the
 * chosen transfer exactly once — the FFmpeg analogue of upstream's CoreImage
 * 709→HLG render. `colorspace` cannot express HLG/PQ transfers, so this uses
 * zscale (libzimg); the encoder then receives yuv420p10le via -pix_fmt.
 */
function hdrFilterStage(hdr: Exclude<HdrProfile, 'sdr'>, inputLabel: string): string {
  return `${inputLabel}zscale=range=limited`
    + ':primariesin=bt709:transferin=bt709:matrixin=bt709'
    + `:primaries=bt2020:transfer=${hdrTransferTag(hdr)}:matrix=bt2020nc`
    + ',format=yuv420p10le[vhdr]';
}

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
  /**
   * Layers this graph could not render faithfully. Every entry names the clip
   * and the styling it lost, so a caller that cannot bake (the agent/MCP
   * export path) reports the shortfall instead of shipping a silently
   * incomplete render. Omitted by callers that have nowhere to report.
   */
  warnings?: string[],
): string[] {
  const { outputPath } = options;
  // HDR (#59) validates first so an invalid profile refuses before any graph
  // work; combos that cannot honestly deliver 10-bit refuse below.
  const hdr = parseHdrProfile(options.hdr);
  // Compound clips expand to ordinary clips with composed transforms FIRST,
  // so eligibility, layering, trim/motion mapping, and the audio mix below
  // all run on one flat shape — identical to preview (shared resolution).
  // Motion/volumeDb keyframes arrive already rebased to absolute frames, so
  // the range shift below applies to them exactly like stored tracks.
  project = { ...project, timeline: resolveRenderTimeline(project) };
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
  const audioOnly = options.format === 'audio';

  // One input per unique source path, in first-use order (#546). Baked title
  // PNGs join the same registry but stream as looping stills, so overlay/
  // blend nodes fed from them never end before the canvas does.
  const inputIndexByPath = new Map<string, number>();
  const inputPreFlagsByPath = new Map<string, string[]>();
  const inputIndexFor = (assetPath: string): number => {
    const existing = inputIndexByPath.get(assetPath);
    if (existing !== undefined) return existing;
    // Video exports reserve input 0 for the canvas; audio-only has none, so
    // its sources must start at 0 or the graph's [0:a] references dangle.
    const index = (audioOnly ? 0 : 1) + inputIndexByPath.size;
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

  // HDR refusals (#59): the honest slice delivers HEVC Main10 on MP4/MOV
  // only, and the wired hardware encoders are 8-bit H.264 paths — a selected
  // encoder that cannot do 10-bit refuses loudly rather than downgrading.
  if (hdr !== 'sdr') {
    if (audioOnly) {
      throw new Error('HDR export is not supported for audio-only exports — turn HDR off or pick a video format.');
    }
    if (options.format === 'webm') {
      throw new Error('HDR export is not supported for WebM/VP9 — use MP4 or MOV, or turn HDR off.');
    }
    if (options.format === 'mp4' && options.hw !== undefined && options.hw !== 'x264') {
      throw new Error(
        `HDR export cannot use ${HW_NAMES[options.hw]} (its H.264 path is 8-bit only) `
        + '— switch the encoder to Software or turn HDR off.',
      );
    }
  }

  if (audioOnly && audioClips.length === 0) {
    throw new Error('No audio to export — every eligible audio clip is missing or muted.');
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

  // Build filter_complex — one graph covering video chains and, when audio
  // clips are eligible, the timed audio mix. Audio previously mapped raw
  // full-source streams: no trim, no start offset, no volume — every music
  // bed played from source zero over the whole export. The per-clip chain
  // below shares the video side's source-time mapping (#68), so export and
  // preview address a clip's audio identically.
  const filters: string[] = [];
  if (videoClips.length > 0) {
    // An asset-less timeline (shapes only, or titles only) yields no video
    // graph — pushing the empty string would both emit `-filter_complex ''`
    // and leave the overlay/drawtext stages below pointing at a `[vout]`
    // label that was never defined.
    const graph = buildFilterGraph(
      project, videoClips, width, height, fps, inputIndexByPath,
      options.range?.start ?? 0,
    );
    if (graph) filters.push(graph);
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
      const speed = effectiveSpeed(clip.speed);
      const delayMs = Math.max(0, Math.round((clip.startFrame / fps) * 1000));

      let chain =
        `[${inputIdx}:a]atrim=start=${trimStart.toFixed(4)}:end=${trimEnd.toFixed(4)},asetpts=PTS-STARTPTS`;
      // Speed runs after the PTS reset so every downstream audio filter
      // (including absolute-frame volume automation) sees the timeline clock.
      if (speed !== 1) chain += `,${ffmpegAudioSpeed(speed)}`;
      // Noise reduction (#165) runs first on the trimmed signal, ahead of
      // routing and level stages, so every later stage (and the muxed
      // output) sees the cleaned audio — mirroring the preview graph, which
      // parks its denoise biquads ahead of the panner. Off emits nothing:
      // exact parity with the preview's transparent parking.
      const denoiseAmount = noiseReductionOf(clip);
      if (denoiseAmount !== null) {
        chain += `,${buildDenoiseFilter(denoiseAmount)}`;
      }
      // Effects order mirrors the preview graph exactly:
      //   denoise → panner → EQ → compressor → makeup → gain(volume)
      // so a compressor reacts to the same signal level live and rendered.
      // Pan and EQ are linear routing/filters, so they sit before the
      // dynamic stage; volume is the last stage in the preview, which is
      // why it is emitted after these.
      const pan = clampPan(clip.pan ?? 0);
      if (pan !== 0) {
        // Balance-style pan (R5): attenuate one channel toward the other.
        chain += `,${ffmpegPanFilter(pan)}`;
      }
      const eq = eqOf(clip);
      if (eq) chain += `,${eqFilterChain(eq)}`;
      const compressor = compressorOf(clip);
      if (compressor) chain += `,${buildCompressorFilter(compressor)}`;
      // Volume keyframes (#535/#539-#541 audio slice) are authoritative over
      // the static field when present. Local t=0 in this chain is the
      // instant the ORIGINAL (pre-range-rebase) timeline frame plays, since
      // volumeDb stores absolute frames from the un-rebased project. A
      // ranged export shifts clip.startFrame by -range.start, so that shift
      // must be undone here or the automation would land range.start frames
      // early/late.
      const originalStartFrame = clip.startFrame + (options.range?.start ?? 0);
      const volumeExpr = volumeFilterExpression(clip.volumeDb, fps, originalStartFrame);
      if (volumeExpr !== undefined) {
        chain += `,volume='${volumeExpr}':eval=frame`;
      } else if (Number.isFinite(clip.volume) && clip.volume >= 0 && clip.volume !== 1) {
        chain += `,volume=${Math.min(1, clip.volume).toFixed(4)}`;
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
  if (!audioOnly && filters.length > 0) {
    currentVideo = '[vout]';
  } else if (!audioOnly) {
    currentVideo = '[0:v]';
  } else {
    currentVideo = ''; // audio-only exports have no video output
  }

  if (!audioOnly) {
    let titleIndex = 0;
    // Motion on a baked still runs on the canvas clock: the looped input is
    // never PTS-reset, so every axis shares one time basis. A ranged export
    // rebases clip.startFrame by -range.start, which must be added back for
    // the absolute-frame motion tracks (like the video position shift).
    const rangeStart = options.range?.start ?? 0;
    const shapeTimeVar = rangeStart !== 0 ? `(t)+(${(rangeStart / fps).toFixed(6)})` : 't';
    for (const clip of sortedClips) {
      // Shape clips always ride the bake pipeline (there is no drawtext-like
      // single filter for arrows/ellipses): the renderer bakes the vector
      // box to a PNG and this composites it with the same scale/rotate/
      // overlay expressions video clips use. A shape with no bake has no
      // fallback styling — it is skipped rather than failing the export, and
      // the skip is reported so it can never be a silent drop.
      if (clip.type === 'shape') {
        const bakedPath = bakedByClipId.get(clip.id);
        if (!bakedPath) {
          warnings?.push(
            `Shape clip "${clip.label ?? clip.id}" (${clip.shapeKind ?? 'shape'}) was left out of the render: `
            + 'vector shapes have no filter fallback and this export ran without a baked layer for it. '
            + 'Export it from the delivery panel, which bakes shape boxes.',
          );
          continue;
        }
        const inputIdx = inputIndexByPath.get(bakedPath)!;
        const outLabel = `[vt${titleIndex}]`;
        const startSec = (clip.startFrame / fps).toFixed(4);
        const endSec = ((clip.startFrame + clip.durationFrames) / fps).toFixed(4);
        const secPerFrame = 1 / fps;
        const scaleXExpr = motionExpression(clip.motionScaleX, secPerFrame, shapeTimeVar);
        const scaleYExpr = motionExpression(clip.motionScaleY, secPerFrame, shapeTimeVar);
        const boxW = Math.max(1, Math.round(clip.width * clip.scaleX));
        const boxH = Math.max(1, Math.round(clip.height * clip.scaleY));
        const shapeWExpr = scaleXExpr
          ? `(${clip.width.toFixed(1)})*(${scaleXExpr})`
          : `${boxW}`;
        const shapeHExpr = scaleYExpr
          ? `(${clip.height.toFixed(1)})*(${scaleYExpr})`
          : `${boxH}`;
        const rotExpr = motionExpression(clip.motionRot, secPerFrame, shapeTimeVar)
          ?? (clip.rotation !== 0 ? clip.rotation.toFixed(6) : null);
        let chain = `[${inputIdx}:v]format=rgba`
          + `,scale='${shapeWExpr}':'${shapeHExpr}':flags=bicubic`
          + (rotExpr ? `,rotate='(${rotExpr})*PI/180':c=black@0` : '');
        if (clip.opacity !== undefined && clip.opacity !== 1) {
          chain += `,colorchannelmixer=aa=${Math.min(1, Math.max(0, clip.opacity)).toFixed(4)}`;
        }
        if (clip.fadeInFrames && clip.fadeInFrames > 0) {
          chain += `,fade=t=in:st=${(clip.startFrame / fps).toFixed(4)}:d=${(clip.fadeInFrames / fps).toFixed(4)}:alpha=1`;
        }
        if (clip.fadeOutFrames && clip.fadeOutFrames > 0) {
          const st = Math.max(0, (clip.startFrame + clip.durationFrames - clip.fadeOutFrames) / fps);
          chain += `,fade=t=out:st=${st.toFixed(4)}:d=${(clip.fadeOutFrames / fps).toFixed(4)}:alpha=1`;
        }
        const shaped = `[sh${titleIndex}]`;
        filters.push(`${chain}${shaped}`);
        const motionXExpr = motionExpression(clip.motionX, secPerFrame, shapeTimeVar);
        const motionYExpr = motionExpression(clip.motionY, secPerFrame, shapeTimeVar);
        // Quoted: a motion expression contains commas (if/lte segments),
        // which the filter parser would otherwise read as option separators.
        const posX = motionXExpr ?? `${Math.round(clip.x)}`;
        const posY = motionYExpr ?? `${Math.round(clip.y)}`;
        filters.push(
          `${currentVideo}${shaped}overlay=x='${posX}':y='${posY}':eof_action=pass`
          + `:enable='between(t,${startSec},${endSec})'${outLabel}`,
        );
        currentVideo = outLabel;
        titleIndex += 1;
        continue;
      }
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

      // The drawtext fallback below carries text, color, size, alignment,
      // font case, bold, stroke, line spacing, and the background box. An
      // advanced title reaching it silently lost its fill mode, blur,
      // perspective tilt, and variable-font axes, so name the clip and the
      // loss rather than shipping a plausible-looking wrong render.
      if (isAdvancedTitle(clip)) {
        warnings?.push(
          `Title clip "${clip.label ?? clip.id}" rendered as plain solid text: its fill mode, `
          + 'blur, perspective tilt, and variable-font axes need a baked layer, which this export '
          + 'did not have. Export it from the delivery panel to keep the styling.',
        );
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
    // HDR (#59) converts/tags at the very end: the zscale stage consumes the
    // final video label after every overlay/drawtext stage, so the SDR grade
    // above it is converted to the HDR transfer exactly once (grade in
    // Rec.709, then HLG/PQ — the same rule upstream's HDRVideoExporter
    // documents for its sdrWorkingSpace render).
    let mapLabel = currentVideo;
    if (hdr !== 'sdr') {
      filters.push(hdrFilterStage(hdr, currentVideo));
      mapLabel = '[vhdr]';
    }
    if (filters.length > 0) {
      args.push('-filter_complex', filters.join(';'));
    }
    args.push('-map', mapLabel);
    // Mixed video+audio: the timed audio graph's [aN]/[aout] label must be
    // mapped alongside the video, or FFmpeg refuses to bind a filter output
    // nothing consumes ("Filter 'asetpts:default' has output 1 unconnected").
    if (audioMap) {
      args.push('-map', audioMap);
    }
  } else {
    // Audio-only exports build the same `filters` chains above (atrim …)
    // but previously mapped [aN] WITHOUT emitting -filter_complex, so
    // FFmpeg failed with "Output with label 'a0' does not exist in any
    // defined filter graph".
    if (filters.length > 0) {
      args.push('-filter_complex', filters.join(';'));
    }
    if (audioMap) {
      args.push('-map', audioMap);
    }
  }

  // Output settings
  if (!audioOnly) {
    const codecArgs = hdr !== 'sdr'
      ? hdrVideoCodecArgs(options.quality)
      : videoCodecArgs(options.format, options.quality, options.hw);
    args.push(...codecArgs);
    // Container/stream color tags for HDR; SDR stays untagged as before.
    if (hdr !== 'sdr') args.push(...hdrColorTagArgs(hdr));
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

/**
 * Resolve a persisted clip mode to the FFmpeg spelling used by `blend`.
 * Normal, absent, and unknown values intentionally return null: the legacy
 * export path is an ordinary `overlay`, so old projects keep their exact
 * graph instead of acquiring a new filter or throwing on hand-edited data.
 */
function ffmpegBlendModeForClip(clip: Clip): string | null {
  const mode = clip.blendMode;
  if (!isBlendMode(mode) || mode === DEFAULT_BLEND_MODE) return null;
  return FFMPEG_BLEND_MODES[mode];
}

/**
 * Composite a non-default visual layer over the accumulated result.
 *
 * FFmpeg's `blend` filter needs two full-canvas streams, while the normal
 * export path deliberately keeps the clip-sized stream for `overlay`. Make a
 * transparent copy of the current composite, place the processed clip on it
 * with the same position/window expression, then blend that layer against the
 * untouched accumulated stream. Splitting `baseInputLabel` (rather than input
 * 0) is what makes this work for every layer: layer B blends with A's result,
 * not with the blank canvas.
 */
function buildBlendedOverlayGraph(
  index: number,
  baseInputLabel: string,
  sourceLabel: string,
  outputLabel: string,
  mode: string,
  posX: string,
  posY: string,
  inTime: number,
  outTime: number,
): string[] {
  const base = `v${index}blendBase`;
  const transparentSource = `v${index}blendCanvas`;
  const baseRgba = `v${index}blendBaseRgba`;
  const transparent = `v${index}blendTransparent`;
  const layer = `v${index}blendLayer`;

  return [
    `[${baseInputLabel}]split[${base}][${transparentSource}]`,
    `[${base}]format=rgba[${baseRgba}]`,
    `[${transparentSource}]format=rgba,colorchannelmixer=aa=0[${transparent}]`,
    `[${transparent}][${sourceLabel}]overlay=x='${posX}':y='${posY}':eof_action=pass:enable='between(t,${inTime.toFixed(4)},${outTime.toFixed(4)})'[${layer}]`,
    `[${baseRgba}][${layer}]blend=all_mode='${mode}'${outputLabel}`,
  ];
}

/** Largest finite scale magnitude a motion track can request, with a safe floor. */
function maxExportScaleMagnitude(
  track: Clip['motionScaleX'] | undefined,
  fallback: number,
): number {
  const values = [Number.isFinite(fallback) ? fallback : 1];
  if (Array.isArray(track)) {
    for (const point of track) {
      if (Number.isFinite(point?.value)) values.push(Math.abs(point.value));
    }
  }
  return Math.max(1, ...values.map(Math.abs));
}

function buildFilterGraph(
  project: Project,
  videoClips: Clip[],
  _canvasWidth: number,
  _canvasHeight: number,
  fps: number,
  inputIndexByPath: Map<string, number>,
  /**
   * The original (pre-range-rebase) timeline frame a ranged export's frame
   * zero corresponds to, in FRAMES (a range's `start`, or 0 when unranged).
   * motionX/motionY read the canvas-timeline `t` directly, which a range
   * shifts by exactly this many frames when it rebases `clip.startFrame`,
   * so their expressions need this added back in to stay keyed to the
   * absolute frames stored on the clip. See the per-clip shift below for
   * rotate/scale, which additionally cross a `setpts=PTS-STARTPTS` reset.
   */
  rangeStartFrame: number,
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
    const anchorX = Number.isFinite(clip.anchorX) ? clip.anchorX : 0;
    const anchorY = Number.isFinite(clip.anchorY) ? clip.anchorY : 0;
    const hasCustomAnchor = anchorX !== 0 || anchorY !== 0;

    // Rotate/scale run on `[trimmedLabel]` below, whose setpts expression
    // resets local t to 0 at the clip's own start (and, for a retimed clip,
    // puts it on the output timeline clock) -- exactly the class of problem
    // shared/audio/volume-keyframes.ts's `frameAtLocalZero` shift already
    // solves for the audio `volume` filter. motionRot/motionScaleX/Y
    // are keyed to ORIGINAL (pre-range-rebase) absolute timeline frames, so
    // local t=0 corresponds to absolute frame `clip.startFrame + rangeStartFrame`
    // (clip.startFrame is already range-rebased by the caller when ranged).
    const rotateSecShift = (clip.startFrame + rangeStartFrame) / fps;
    const rotateTimeVar = rotateSecShift !== 0 ? `(t)+(${rotateSecShift.toFixed(6)})` : 't';

    // Rotation (static + animated, keyframes v1): applied after the pixel
    // processing below. For a custom anchor, expand the rotated frame to its
    // bounding box and compensate its centre in the overlay expression; FFmpeg
    // otherwise rotates around the scaled frame's centre rather than the
    // native affine pivot. The default-anchor spelling stays on the legacy
    // path so existing projects retain byte-identical arguments.
    const animatedRotDegExpr = motionExpression(clip.motionRot, rotSecPerFrame, rotateTimeVar);
    const rotDegExpr = animatedRotDegExpr
      ?? (Number.isFinite(clip.rotation) && clip.rotation !== 0
        ? clip.rotation.toFixed(6)
        : null);
    const rotateAngleExpr = rotDegExpr ? `(${rotDegExpr})*PI/180` : null;
    let rotateChain = rotDegExpr
      ? `,rotate='${rotateAngleExpr}':c=black@0`
      : '';
    if (rotDegExpr && hasCustomAnchor) {
      if (animatedRotDegExpr) {
        // `rotate`'s output-size expressions are evaluated at init, so a
        // rotw()/roth() call based on an animated angle would freeze the first
        // frame's box. A conservative square contains every angle and scale
        // in the track; overlay_w/overlay_h below then place its centre.
        const maxScaleX = maxExportScaleMagnitude(clip.motionScaleX, clip.scaleX);
        const maxScaleY = maxExportScaleMagnitude(clip.motionScaleY, clip.scaleY);
        const safeSide = Math.max(1, Math.ceil(2 * Math.max(
          Math.abs(Number.isFinite(clip.width) ? clip.width : 1) * maxScaleX,
          Math.abs(Number.isFinite(clip.height) ? clip.height : 1) * maxScaleY,
        )));
        rotateChain = `,rotate='${rotateAngleExpr}':ow='${safeSide}':oh='${safeSide}':c=black@0`;
      } else {
        rotateChain = `,rotate='${rotateAngleExpr}':ow='rotw(${rotateAngleExpr})':oh='roth(${rotateAngleExpr})':c=black@0`;
      }
    }

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
    const speed = effectiveSpeed(clip.speed);
    // The source window is speed-scaled by clipTrimSeconds. Reset and divide
    // its PTS in one expression: downstream filters then run on the output
    // (timeline) clock, while the unity spelling remains byte-identical.
    const ptsFilter = speed === 1
      ? 'setpts=PTS-STARTPTS'
      : `setpts=(PTS-STARTPTS)/${ffmpegSpeed(speed)}`;

    const trimmedLabel = `v${i}trimmed`;
    const scaledLabel = `v${i}scaled`;
    const overlayOut = i < videoClips.length - 1 ? `[v${i}out]` : '[vout]';

    // Trim filter
    filters.push(
      `[${inputIdx}:v]trim=start=${trimStart.toFixed(4)}:end=${trimEnd.toFixed(4)},${ptsFilter}[${trimmedLabel}]`,
    );

    // Scale/transform — animated scale uses FFmpeg expressions in output
    // seconds, on the same PTS-reset local clock rotation is, so it needs
    // the identical time-basis shift.
    const scaleXExpr = motionExpression(clip.motionScaleX, rotSecPerFrame, rotateTimeVar);
    const scaleYExpr = motionExpression(clip.motionScaleY, rotSecPerFrame, rotateTimeVar);
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
    // when the source never reported dimensions. Keep the cropped dimensions
    // for the edge mask: that mask is deliberately evaluated before scale.
    let cropChain = '';
    let edgeWidth = Number.isFinite(asset.width) && (asset.width ?? 0) > 0
      ? asset.width!
      : clip.width;
    let edgeHeight = Number.isFinite(asset.height) && (asset.height ?? 0) > 0
      ? asset.height!
      : clip.height;
    if (isCropped(clip.crop) && asset.width && asset.height) {
      const rect = cropRect(clip.crop, asset.width, asset.height);
      cropChain = `,crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}`;
      edgeWidth = rect.width;
      edgeHeight = rect.height;
    }

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

    // Opacity is a layer-alpha multiplier, never a filter on the accumulated
    // canvas. An active track is expressed on the post-setpts local clock,
    // shifted back to the absolute timeline frames used by the motion engine.
    // colorchannelmixer's aa option is static-only in FFmpeg, so animated
    // opacity uses a geq alpha multiply (with the existing RGB/alpha pixels
    // preserved). Missing or malformed static values use the historical
    // opaque default.
    const opacityTimeVar = rotateSecShift !== 0 ? `(T)+(${rotateSecShift.toFixed(6)})` : 'T';
    const opacityTrackExpr = motionExpression(clip.opacityTrack, rotSecPerFrame, opacityTimeVar);
    const opacity = Number.isFinite(clip.opacity) ? clip.opacity : 1;
    const opacityChain = opacityTrackExpr
      ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${opacityTrackExpr})'`
      : opacity !== 1
        ? `,colorchannelmixer=aa=${Math.min(1, Math.max(0, opacity)).toFixed(4)}`
        : '';

    // Resample every source to the project frame rate before compositing.
    // `overlay` runs on the base input's timebase, so a 60 fps source dropped
    // onto a 30 fps canvas otherwise queues two source frames per output frame
    // and the encode crawls or stalls on long 4K clips (#68).
      // Color grading (R4): eq, then hue rotation, then invert — separate
      // filters, because FFmpeg rejects unknown eq options. A LUT at partial
      // intensity (0 < i < 1) cannot be one comma filter — blending needs two
      // frames — so it expands into a split/lut/blend graph at the LUT slot
      // (after hue curves, before hue rotation/invert, matching the linear
      // chain order); full-intensity LUTs stay in the linear chain.
      const grade = colorGradeOf(clip);
      const partialLut = grade?.lut && grade.lut.intensity > 0 && grade.lut.intensity < 1 ? grade.lut : undefined;
      let colorChain = '';
      if (grade && !partialLut) {
        const chain = toFfmpegColorChain(grade);
        if (chain.length > 0) colorChain = `,${chain.join(',')}`;
      }

      // Edge rounding and softness (#369): geq on the alpha channel before
      // scale/rotate, matching the active preview's crop → grade/effects →
      // edge-mask → transform order. The mask dimensions are the cropped
      // source dimensions, not the eventual scaled output dimensions.
      let edgeChain = '';
      if (hasEdgeEffects(clip)) {
        const edgeExpr = buildEdgeGeqExpr(
          clip.edgeRounding ?? 0,
          clip.edgeSoftness ?? 0,
          edgeWidth,
          edgeHeight,
        );
        if (edgeExpr && edgeExpr !== 'alpha(X,Y)') {
          edgeChain = `,geq='r=r(X,Y):g=g(X,Y):b=b(X,Y):a=${edgeExpr}'`;
        }
      }

      const processingBase = `fps=${fps},format=rgba${cropChain}${chromaChain}`;
      // FFmpeg's scale filter has no pivot/offset option, so the anchor's
      // translation is carried by the overlay expression below. FFmpeg
      // evaluates scale dimensions at init unless asked to evaluate per
      // frame; preserve the legacy default-anchor spelling, but custom-anchor
      // motion needs frame evaluation for the pivot expression to track it.
      const scaleEval = hasCustomAnchor && (scaleXExpr || scaleYExpr)
        ? ':eval=frame'
        : '';
      const transformFilters = [
        `scale='${scaleWExpr}':'${scaleHExpr}':flags=bicubic${scaleEval}`,
        ...(rotateChain ? [rotateChain.slice(1)] : []),
      ];
      const transformChain = `,${transformFilters.join(',')}`;
      // Effects subgroups (#157): blur, grain and vignette are linear
      // single-input filters behind invert; glow needs a split/blend graph
      // (screen needs two frames), like a partial LUT does.
      const fx = effectsOf(clip);
      const fxFilters: string[] = [];
      if (fx?.blurRadius !== undefined) fxFilters.push(toFfmpegBlurFilter(fx.blurRadius));
      if (fx?.grain) fxFilters.push(toFfmpegGrainFilter(fx.grain));
      if (fx?.vignette) fxFilters.push(toFfmpegVignetteFilter(fx.vignette));
      const glow = fx?.glow;
      if (grade && partialLut && !glow) {
        const pre = toFfmpegPreLutChain(grade);
        const post = toFfmpegPostLutChain(grade);
        const preLut = `v${i}prelut`;
        const preA = `v${i}preA`;
        const preB = `v${i}preB`;
        const lutOut = `v${i}lut`;
        const blended = `v${i}blended`;
        const preSuffix = pre.length > 0 ? `,${pre.join(',')}` : '';
        filters.push(`[${trimmedLabel}]${processingBase}${preSuffix}[${preLut}]`);
        filters.push(`[${preLut}]split[${preA}][${preB}]`);
        filters.push(`[${preA}]${toFfmpegLutFilter(partialLut)}[${lutOut}]`);
        filters.push(
          `[${lutOut}][${preB}]blend=all_mode='normal':all_opacity=${String(partialLut.intensity)}[${blended}]`,
        );
        const postSuffix = [
          ...post,
          ...fxFilters,
          ...(edgeChain ? [edgeChain.slice(1)] : []),
          ...transformFilters,
          ...(fadeChain ? [fadeChain.slice(1)] : []),
          ...(opacityChain ? [opacityChain.slice(1)] : []),
        ];
        filters.push(
          postSuffix.length > 0
            ? `[${blended}]${postSuffix.join(',')}[${scaledLabel}]`
            : `[${blended}]null[${scaledLabel}]`,
        );
      } else if (glow || (grade && partialLut)) {
        // Graph path: an optional LUT blend first, then the linear
        // post-LUT stages, then the glow split/threshold/blur/scale/screen
        // graph at its canonical slot (after vignette, before edge/fades).
        let current: string;
        if (grade && partialLut) {
          const pre = toFfmpegPreLutChain(grade);
          const post = toFfmpegPostLutChain(grade);
          const preLut = `v${i}prelut`;
          const preA = `v${i}preA`;
          const preB = `v${i}preB`;
          const lutOut = `v${i}lut`;
          const blended = `v${i}blended`;
          const preSuffix = pre.length > 0 ? `,${pre.join(',')}` : '';
          filters.push(`[${trimmedLabel}]${processingBase}${preSuffix}[${preLut}]`);
          filters.push(`[${preLut}]split[${preA}][${preB}]`);
          filters.push(`[${preA}]${toFfmpegLutFilter(partialLut)}[${lutOut}]`);
          filters.push(
            `[${lutOut}][${preB}]blend=all_mode='normal':all_opacity=${String(partialLut.intensity)}[${blended}]`,
          );
          const mid = [...post, ...fxFilters];
          if (mid.length > 0) {
            const midLabel = `v${i}mid`;
            filters.push(`[${blended}]${mid.join(',')}[${midLabel}]`);
            current = midLabel;
          } else {
            current = blended;
          }
        } else {
          const mid = [...(grade && !partialLut ? toFfmpegColorChain(grade) : []), ...fxFilters];
          const midSuffix = mid.length > 0 ? `,${mid.join(',')}` : '';
          const midLabel = `v${i}mid`;
          filters.push(`[${trimmedLabel}]${processingBase}${midSuffix}[${midLabel}]`);
          current = midLabel;
        }
        if (glow) {
          const glowA = `v${i}glowA`;
          const glowB = `v${i}glowB`;
          const glowOut = `v${i}glow`;
          const glowed = `v${i}glowed`;
          filters.push(`[${current}]split[${glowA}][${glowB}]`);
          const branch = [
            toFfmpegGlowThresholdFilter(glow),
            ...(glow.radius > 0 ? [toFfmpegBlurFilter(glow.radius)] : []),
            toFfmpegGlowScaleFilter(glow),
          ];
          filters.push(`[${glowA}]${branch.join(',')}[${glowOut}]`);
          filters.push(toFfmpegGlowBlendFilter(glowOut, glowB, glowed));
          current = glowed;
        }
        const tail = [
          ...(edgeChain ? [edgeChain.slice(1)] : []),
          ...transformFilters,
          ...(fadeChain ? [fadeChain.slice(1)] : []),
          ...(opacityChain ? [opacityChain.slice(1)] : []),
        ];
        filters.push(
          tail.length > 0
            ? `[${current}]${tail.join(',')}[${scaledLabel}]`
            : `[${current}]null[${scaledLabel}]`,
        );
      } else {
        const fxJoin = fxFilters.length > 0 ? `,${fxFilters.join(',')}` : '';
        filters.push(
          `[${trimmedLabel}]${processingBase}${colorChain}${fxJoin}${edgeChain}${transformChain}${fadeChain}${opacityChain}[${scaledLabel}]`,
        );
      }

    // Overlay with enable condition (time window). Motion tracks (#535 v1)
    // drive x/y via piecewise-linear expressions in output seconds; the
    // expression is clamped outside the first/last keyframe, matching the
    // preview's evaluateMotion exactly. This chain runs on the CANVAS's own
    // timeline (`[lastLabel]`, never PTS-reset), so clip.startFrame is
    // already the right absolute position -- only a ranged export's rebase
    // of the canvas's own zero needs correcting for, via rangeStartFrame.
    const secPerFrame = 1 / fps;
    const positionSecShift = rangeStartFrame / fps;
    const positionTimeVar = positionSecShift !== 0 ? `(t)+(${positionSecShift.toFixed(6)})` : 't';
    const motionXExpr = motionExpression(clip.motionX, secPerFrame, positionTimeVar);
    const motionYExpr = motionExpression(clip.motionY, secPerFrame, positionTimeVar);
    // Quoted: a motion expression contains commas (if/lte segments), which
    // the filter parser would otherwise read as option separators — the
    // graph then fails with "No option name near ...".
    let posX = motionXExpr ?? `${Math.round(clip.x)}`;
    let posY = motionYExpr ?? `${Math.round(clip.y)}`;

    if (hasCustomAnchor) {
      const anchorXText = anchorX.toFixed(6);
      const anchorYText = anchorY.toFixed(6);
      const positionScaleXExpr = motionExpression(
        clip.motionScaleX,
        secPerFrame,
        positionTimeVar,
      ) ?? (Number.isFinite(clip.scaleX) ? clip.scaleX.toFixed(6) : '1.000000');
      const positionScaleYExpr = motionExpression(
        clip.motionScaleY,
        secPerFrame,
        positionTimeVar,
      ) ?? (Number.isFinite(clip.scaleY) ? clip.scaleY.toFixed(6) : '1.000000');
      const positionRotExpr = motionExpression(
        clip.motionRot,
        secPerFrame,
        positionTimeVar,
      ) ?? (Number.isFinite(clip.rotation) && clip.rotation !== 0
        ? clip.rotation.toFixed(6)
        : '0.000000');
      const boxWidthText = Number.isFinite(clip.width) ? clip.width.toFixed(1) : '0.0';
      const boxHeightText = Number.isFinite(clip.height) ? clip.height.toFixed(1) : '0.0';

      if (rotDegExpr) {
        // FFmpeg rotates around the scaled frame centre. Align the requested
        // native pivot by subtracting the rotated output centre and the
        // rotated vector from that centre to the scaled anchor. This is the
        // same T(position)·T(anchor)·R·S·T(-anchor) matrix as geometry.rs.
        const pivotX = `(${anchorXText})*(${positionScaleXExpr})`;
        const pivotY = `(${anchorYText})*(${positionScaleYExpr})`;
        const centerX = `(${boxWidthText})*(${positionScaleXExpr})/2`;
        const centerY = `(${boxHeightText})*(${positionScaleYExpr})/2`;
        const angle = `(${positionRotExpr})*PI/180`;
        posX = `(${posX})+(${anchorXText})-(overlay_w/2)-((${pivotX})-(${centerX}))*cos(${angle})+((${pivotY})-(${centerY}))*sin(${angle})`;
        posY = `(${posY})+(${anchorYText})-(overlay_h/2)-((${pivotX})-(${centerX}))*sin(${angle})-((${pivotY})-(${centerY}))*cos(${angle})`;
      } else {
        // With no rotation, the native matrix's translation reduces to
        // position + anchor - scaledAnchor. This is the scale-only pivot
        // correction and leaves the legacy default-anchor path untouched.
        posX = `(${posX})+(${anchorXText})-((${anchorXText})*(${positionScaleXExpr}))`;
        posY = `(${posY})+(${anchorYText})-((${anchorYText})*(${positionScaleYExpr}))`;
      }
    }
    const ffmpegBlendMode = ffmpegBlendModeForClip(clip);
    if (ffmpegBlendMode) {
      filters.push(
        ...buildBlendedOverlayGraph(
          i, lastLabel, scaledLabel, overlayOut, ffmpegBlendMode,
          posX, posY, inTime, outTime,
        ),
      );
    } else {
      // Normal/absent/unknown modes stay on the byte-for-byte legacy path.
      filters.push(
        `[${lastLabel}][${scaledLabel}]overlay=x='${posX}':y='${posY}':enable='between(t,${inTime.toFixed(4)},${outTime.toFixed(4)})'${overlayOut}`,
      );
    }

    if (i < videoClips.length - 1) {
      lastLabel = `v${i}out`;
    }
  }

  return filters.join(';');
}
