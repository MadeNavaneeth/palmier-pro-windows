/**
 * FCPXML export (upstream #154) — project → Final Cut Pro XML 1.11.
 *
 * Scope is deliberately minimal and honest about it: the goal is opening a
 * Palmier timeline in Resolve / FCP / Premiere with picture, audio, title
 * TEXT, opacity, geometry, crop and volume intact. Matching upstream
 * (FCPXMLExporter.swift at b4b1333), keyframed position/scale/rotation ride
 * child <param>/<keyframeAnimation> elements under <adjust-transform>; what
 * upstream does NOT transport is not invented here either: keyframed audio
 * volume and audio fades, crop keyframes, title rotation/scale, color grades
 * and effects, edge softness/rounding, and crop/volume keyframes remain
 * unrepresented. Shape clips have no FCPXML form either and
 * are skipped with an explicit unsupported note, as are generated clips
 * whose media asset is missing (like any clip with no resolvable resource).
 * Invalid or cyclic compound graphs are likewise reported and skipped.
 * Importers report those as unsupported rather than dropping them silently.
 *
 * Mapping contract (mirrored by the importer):
 *   - lowest visible video track  → spine asset-clips
 *   - higher video tracks         → connected asset-clips, lane = track index
 *   - audio clips                 → connected asset-clips, audioRole=dialogue,
 *                                   negative lanes below the spine
 *   - title clips                 → <title> with per-clip <text-style-def>
 *   - compound clips              → nested <media>/<sequence> resources and a
 *                                   parent <ref-clip> with the source window
 *   - visual clips/titles         → <adjust-conform type="fit"/>
 *   - image clips                 → still-image <video> elements
 *   - non-unit visual speed       → <timeMap frameSampling="floor"> with two
 *                                   linear <timept> children
 *   - opacity < 1                 → <adjust-blend amount>
 *   - keyframed opacity           → <adjust-blend amount> with an amount
 *                                   <param>/<keyframeAnimation> child
 *   - non-identity geometry       → <adjust-transform scale/rotation/position>
 *   - keyframed transform         → <param name="scale|position|rotation">
 *                                   children with <keyframeAnimation>; `time`
 *                                   is the clip-relative output-axis offset,
 *                                   values in each param's own units, and
 *                                   `curve="linear"` is written only for
 *                                   linear easing (upstream's exact shape)
 *   - crop                        → <adjust-crop mode="trim"><trim-rect>
 *   - non-unity volume (or mute)  → <adjust-volume amount="…dB">
 *
 * Timing uses decimal seconds ("12.345678s") for ordinary clip fields so
 * fractional project fps is not silently resynced; the speed map uses
 * upstream's exact rational output-axis spelling. Microsecond precision
 * matches FCP's internal tick.
 */

import type { Project, Clip, MediaAsset, Timeline } from '../types/project';
import { MAX_COMPOUND_DEPTH, sanitizeCompoundTimelineId } from '../editor/compound';
import { timecodeToSeconds } from '../media/timecode';
import { effectiveSpeed, projectFramesToSeconds } from '../media/source-time';
import { colorGradeOf } from '../editor/color-grade';
import { hasEffects } from '../editor/effects';
import { hasEdgeEffects } from '../editor/edge-effects';
import { evaluateMotion, normalizeEasing, type MotionPoint, type MotionTrack } from '../media/motion';
import { aspectFit } from './geometry';

const SEC_PRECISION = 6;

function sec(frames: number, fps: number): string {
  return `${(frames / fps).toFixed(SEC_PRECISION)}s`;
}

/** Upstream uses a small fraction for the time-map output axis. */
function rationalSpeed(speed: number): { p: number; q: number } {
  let best = { p: 1, q: 1 };
  let bestError = Number.POSITIVE_INFINITY;
  for (let q = 1; q <= 1000; q += 1) {
    const p = Math.round(speed * q);
    if (p <= 0) continue;
    const error = Math.abs(speed - p / q);
    if (error < bestError) {
      best = { p, q };
      bestError = error;
      if (error === 0) break;
    }
  }
  return best;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return Math.max(1, x);
}

/** Upstream's exact rational spelling, with a decimal fallback for fractional fps. */
function rationalTime(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return '0s';
  }
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    return `${(numerator / denominator).toFixed(SEC_PRECISION)}s`;
  }
  if (numerator === 0) return '0s';
  const divisor = gcd(numerator, denominator);
  const n = numerator / divisor;
  const d = denominator / divisor;
  return d === 1 ? `${n}s` : `${n}/${d}s`;
}

/** Decimal source time used for a time-map value (origin-aware). */
function sourceTimeValue(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0s';
  if (Number.isInteger(seconds)) return `${seconds}s`;
  return `${seconds.toFixed(SEC_PRECISION)}s`;
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

/**
 * Upstream's number format (FCPXMLExporter.formatNumber): four decimals with
 * trailing zeros trimmed, integers bare. One shared spelling so exported
 * numbers never drift between elements.
 */
function formatNumber(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  if (rounded === 0) return '0';
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded.toFixed(4)).replace(/0+$/, '').replace(/\.$/, '');
}

/** Linear gain to decibels; silence floors at -96 like upstream. */
function linearToDb(linear: number): number {
  return linear > 0 ? 20 * Math.log10(linear) : -96;
}

/** Upstream emits this fit hint unconditionally on visual and title clips. */
const CONFORM_ELEMENT = '<adjust-conform type="fit"/>';

const SPEED_EPSILON = 0.001;

/**
 * Upstream's whole-media retime map. The output axis runs from zero to
 * `mediaDuration / effectiveSpeed`; the source axis advances by the same
 * effective speed. A non-unit speed also moves the clip's `start` onto that
 * output axis, so the map and source trim describe the same source window.
 */
function timeMapElement(
  clip: Clip,
  asset: MediaAsset,
  fps: number,
  unsupported: string[],
): string {
  if (clip.speed !== undefined && (!Number.isFinite(clip.speed) || clip.speed <= 0)) {
    unsupported.push(`Clip "${clip.id}" carries an invalid speed; FCPXML does not represent it.`);
    return '';
  }

  const speed = effectiveSpeed(clip.speed);
  if (Math.abs(speed - 1) <= SPEED_EPSILON) return '';
  if (!Number.isFinite(asset.duration) || asset.duration <= 0) {
    unsupported.push(
      `Clip "${clip.id}" carries a non-unit speed, but FCPXML cannot emit a timeMap without a positive media duration.`,
    );
    return '';
  }

  const mediaFrames = Math.max(1, Math.round(asset.duration));
  const { p, q } = rationalSpeed(speed);
  const originSeconds = asset.startTimecode
    ? timecodeToSeconds(asset.startTimecode, asset.fps ?? fps) ?? 0
    : 0;
  const mediaSeconds = projectFramesToSeconds(mediaFrames, fps);
  const outputEnd = rationalTime(mediaFrames * q, fps * p);
  const sourceEnd = sourceTimeValue(originSeconds + mediaSeconds);
  return '<timeMap frameSampling="floor">'
    + `<timept time="0s" value="${sourceTimeValue(originSeconds)}" interp="linear"/>`
    + `<timept time="${outputEnd}" value="${sourceEnd}" interp="linear"/>`
    + '</timeMap>';
}

/** Retimed clip starts are expressed on the timeMap's output axis. */
function retimedSourceStart(clip: Clip, fps: number): string {
  const speed = effectiveSpeed(clip.speed);
  if (Math.abs(speed - 1) <= SPEED_EPSILON) return sec(clip.inPoint, fps);
  const { p, q } = rationalSpeed(speed);
  return rationalTime(Math.round(clip.inPoint) * q, fps * p);
}

/**
 * `<adjust-blend amount>`: linear 0-1 opacity, upstream's 0.9995 threshold.
 * An opacity track rides the same `amount` parameter as a nested
 * `<keyframeAnimation>`, including when the static base is opaque. No
 * `mode`: our blend modes have no verified FCPXML integer mapping, and a
 * wrong composite in Resolve is worse than a plain one.
 */
function blendElement(clip: Clip, fps: number): string {
  const opacityFrames = clip.opacityTrack ?? [];
  if (!(clip.opacity < 0.9995) && opacityFrames.length === 0) return '';
  const amount = formatNumber(Math.max(0, clip.opacity));
  if (opacityFrames.length === 0) return `<adjust-blend amount="${amount}"/>`;
  const valueByFrame = new Map(opacityFrames.map((point) => [point.frame, point.value]));
  const param = keyframeParam('amount', amount, opacityFrames, clip, fps, (frame) =>
    formatNumber(valueByFrame.get(frame) ?? 0));
  return `<adjust-blend amount="${amount}">${param}</adjust-blend>`;
}

/** FCPXML center-based position pair for a box state (the static attribute's units). */
function positionOf(
  x: number,
  y: number,
  rotation: number,
  clip: Clip,
  canvasW: number,
  canvasH: number,
): [number, number] {
  const cx = clip.width / 2;
  const cy = clip.height / 2;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ox = cx - clip.anchorX;
  const oy = cy - clip.anchorY;
  const px = x + clip.anchorX + (ox * cos - oy * sin);
  const py = y + clip.anchorY + (ox * sin + oy * cos);
  const unit = canvasH / 100;
  return [(px - canvasW / 2) / unit, (canvasH / 2 - py) / unit];
}

/**
 * Keyframes of one or two independent axis tracks, deduped by frame and
 * sorted. Position and scale are single FCPXML params carrying a value pair,
 * so the union of both axes' frames is emitted; each axis is evaluated at
 * every frame (a missing axis holds its static value).
 */
function unionPoints(...tracks: Array<MotionTrack | undefined>): MotionPoint[] {
  const byFrame = new Map<number, MotionPoint>();
  for (const track of tracks) {
    for (const point of track ?? []) {
      if (!byFrame.has(point.frame)) byFrame.set(point.frame, point);
    }
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/**
 * Upstream's keyframeParam: `<param name value><keyframeAnimation>` with one
 * `<keyframe>` per point. `time` is the clip-relative output-axis offset in
 * seconds (absolute timeline frame minus the clip's start); the `curve`
 * attribute is written only for linear easing — FCPXML's default smooth curve
 * is left implicit for every other easing, exactly as upstream does.
 */
function keyframeParam(
  name: string,
  base: string,
  points: MotionPoint[],
  clip: Clip,
  fps: number,
  valueAt: (frame: number) => string,
): string {
  const keyframes = points
    .map((point) => {
      const curve = normalizeEasing(point.easing) === 'linear' ? ' curve="linear"' : '';
      return `<keyframe time="${sec(point.frame - clip.startFrame, fps)}"${curve} value="${valueAt(point.frame)}"/>`;
    })
    .join('');
  return `<param name="${name}" value="${base}"><keyframeAnimation>${keyframes}</keyframeAnimation></param>`;
}

/**
 * `<adjust-transform>`: FCPXML geometry is center-based — `position` is the
 * anchor point relative to the canvas center in percent of canvas height
 * (+x right, +y up), `scale` a multiplier with 1 = native, `rotation`
 * counter-clockwise degrees, `anchor` a center offset (so "0 0" is centered).
 *
 * Our clips are top-left boxes with clockwise-positive rotation about a pixel
 * anchor, so the mapping folds the anchor in: the position written is where
 * our transformed box center lands. The decode is assumed box-sized (it is
 * requested that way); rotation and scale transfer directly, rotation negated.
 * Anything within upstream's identity epsilons is omitted. Keyframed
 * position/scale/rotation append `<param>` children with values in the same
 * units as the attributes; the static values stay the param bases.
 */
function transformElement(
  clip: Clip,
  canvasW: number,
  canvasH: number,
  fittedW: number,
  fittedH: number,
  fps: number,
): string {
  const scaleX = (clip.width * clip.scaleX) / fittedW;
  const scaleY = (clip.height * clip.scaleY) / fittedH;
  const [posX, posY] = positionOf(clip.x, clip.y, clip.rotation, clip, canvasW, canvasH);
  const moved = Math.abs(posX) > 0.0005 || Math.abs(posY) > 0.0005;
  const scaled = Math.abs(scaleX - 1) > 0.0005 || Math.abs(scaleY - 1) > 0.0005;
  const rotated = Math.abs(clip.rotation) > 0.005;
  const positionFrames = unionPoints(clip.motionX, clip.motionY);
  const scaleFrames = unionPoints(clip.motionScaleX, clip.motionScaleY);
  const rotationFrames = unionPoints(clip.motionRot);
  if (!moved && !scaled && !rotated
    && positionFrames.length === 0 && scaleFrames.length === 0 && rotationFrames.length === 0) {
    return '';
  }

  const scaleBase = `${formatNumber(scaleX)} ${formatNumber(scaleY)}`;
  const positionBase = `${formatNumber(posX)} ${formatNumber(posY)}`;
  const rotationBase = formatNumber(-clip.rotation);

  const params: string[] = [];
  if (scaleFrames.length > 0) {
    params.push(keyframeParam('scale', scaleBase, scaleFrames, clip, fps, (frame) => {
      const sx = evaluateMotion(clip.motionScaleX, frame) ?? clip.scaleX;
      const sy = evaluateMotion(clip.motionScaleY, frame) ?? clip.scaleY;
      return `${formatNumber((clip.width * sx) / fittedW)} ${formatNumber((clip.height * sy) / fittedH)}`;
    }));
  }
  if (positionFrames.length > 0) {
    params.push(keyframeParam('position', positionBase, positionFrames, clip, fps, (frame) => {
      const x = evaluateMotion(clip.motionX, frame) ?? clip.x;
      const y = evaluateMotion(clip.motionY, frame) ?? clip.y;
      const rotation = evaluateMotion(clip.motionRot, frame) ?? clip.rotation;
      const [px, py] = positionOf(x, y, rotation, clip, canvasW, canvasH);
      return `${formatNumber(px)} ${formatNumber(py)}`;
    }));
  }
  if (rotationFrames.length > 0) {
    params.push(keyframeParam('rotation', rotationBase, rotationFrames, clip, fps, (frame) =>
      formatNumber(-(evaluateMotion(clip.motionRot, frame) ?? clip.rotation))));
  }
  const attrs = `scale="${scaleBase}"`
    + (rotated || rotationFrames.length > 0 ? ` rotation="${rotationBase}"` : '')
    + ` anchor="0 0" position="${positionBase}"`;
  return params.length > 0
    ? `<adjust-transform ${attrs}>${params.join('')}</adjust-transform>`
    : `<adjust-transform ${attrs}/>`;
}

/**
 * `<adjust-crop mode="trim">`: trim-rect units are percent of *frame* height
 * for every edge, so width fractions are aspect-corrected. The crop applies
 * to the source frame, hence source — not canvas — dimensions.
 */
function cropElement(
  clip: Clip,
  frameW: number,
  frameH: number,
): string {
  const crop = clip.crop;
  if (!crop) return '';
  const { left = 0, right = 0, top = 0, bottom = 0 } = crop;
  if (!(left > 0 || right > 0 || top > 0 || bottom > 0)) return '';
  const aspect = frameW > 0 && frameH > 0 ? frameW / frameH : 16 / 9;
  const widthEdge = (frac: number): string => formatNumber((frac * aspect * 100));
  const heightEdge = (frac: number): string => formatNumber(frac * 100);
  return '<adjust-crop mode="trim">'
    + `<trim-rect top="${heightEdge(top)}" right="${widthEdge(right)}"`
    + ` bottom="${heightEdge(bottom)}" left="${widthEdge(left)}"/>`
    + '</adjust-crop>';
}

/**
 * `<adjust-volume amount="…dB">`: upstream's threshold and floor. A muted clip
 * is silence, so it exports at the floor rather than at full volume — there is
 * no per-clip mute flag in FCPXML 1.11.
 */
function volumeElement(clip: Clip): string {
  const effective = clip.muted ? 0 : clip.volume;
  if (!clip.muted && Math.abs(effective - 1) <= 0.0005) return '';
  return `<adjust-volume amount="${formatNumber(linearToDb(effective))}dB"/>`;
}

/** Report effective, non-identity properties that the FCPXML subset cannot carry. */
function reportUnsupportedProperties(clip: Clip, unsupported: string[]): void {
  if (colorGradeOf(clip)) {
    unsupported.push(`Clip "${clip.id}" carries color grade; FCPXML does not represent it.`);
  }
  if (hasEffects(clip)) {
    unsupported.push(`Clip "${clip.id}" carries effects; FCPXML does not represent them.`);
  }
  if (clip.blendMode !== undefined && clip.blendMode !== 'normal') {
    unsupported.push(`Clip "${clip.id}" carries layer blend mode; FCPXML does not represent it.`);
  }
  if ((Number.isFinite(clip.fadeInFrames) && (clip.fadeInFrames ?? 0) > 0)
    || (Number.isFinite(clip.fadeOutFrames) && (clip.fadeOutFrames ?? 0) > 0)) {
    unsupported.push(`Clip "${clip.id}" carries fades; FCPXML does not represent them.`);
  }
  if (hasEdgeEffects(clip)) {
    const edge = [
      Number.isFinite(clip.edgeRounding) && (clip.edgeRounding ?? 0) > 0 ? 'edge rounding' : null,
      Number.isFinite(clip.edgeSoftness) && (clip.edgeSoftness ?? 0) > 0 ? 'edge softness' : null,
    ].filter((value): value is string => value !== null);
    unsupported.push(`Clip "${clip.id}" carries ${edge.join(' and ')}; FCPXML does not represent ${edge.length > 1 ? 'them' : 'it'}.`);
  }
}

/**
 * Upstream's `titleBasic` resource is a macOS `.moti` generator. The local
 * FCPXML contract uses `text-style-def`, and no local consumer or validator
 * requires that platform resource. Adding it would also change the mandatory
 * byte-compatible default-title output, so do not invent a UID or emit an
 * inert reference; report the decision instead.
 */
function reportTitleEffectResource(clip: Clip, unsupported: string[]): void {
  unsupported.push(
    `Title "${clip.id}" uses a text-style reference; the platform-specific Basic Title effect resource is not emitted.`,
  );
}

/** Flat clips preserve A/V content, but not the local link relationship on import. */
function reportLinkedAvGroups(clips: Clip[], unsupported: string[]): void {
  const groups = new Map<string, Clip[]>();
  for (const clip of clips) {
    if (!clip.linkGroupId) continue;
    const members = groups.get(clip.linkGroupId) ?? [];
    members.push(clip);
    groups.set(clip.linkGroupId, members);
  }
  for (const [groupId, members] of groups) {
    const hasVisual = members.some((clip) => clip.type === 'video' || clip.type === 'image');
    const hasAudio = members.some((clip) => clip.type === 'audio');
    if (hasVisual && hasAudio) {
      unsupported.push(
        `Linked A/V group "${groupId}" is emitted as separate flat clips; FCPXML link grouping is not round-tripped.`,
      );
    }
  }
}

interface TrackInfo {
  id: string;
  kind: 'video' | 'audio';
  /** Track order for layering (visual) or stacking (audio). */
  order: number;
  index: number;
  visible: boolean;
}

function describeTracks(project: Project): TrackInfo[] {
  return project.timeline.tracks.map((track, index) => ({
    id: track.id,
    kind: track.type,
    order: track.order,
    index,
    visible: track.visible,
  }));
}

/**
 * Export result: the FCPXML text plus one-line unsupported notes for clips
 * with no FCPXML form (shape clips, generated clips with missing media, or
 * any clip with no resolvable resource) and effective properties outside the
 * FCPXML subset. The XML is byte-identical to what exportFcpxml returns; the
 * notes carry clip ids so nothing is skipped silently, mirroring the
 * importer's unsupported contract.
 */
export interface FcpxmlExportResult {
  xml: string;
  unsupported: string[];
  /** Clips written to the spine (asset-clips, videos, and titles). */
  exportedClips: number;
  /** Clips skipped entirely; property-omission notes do not increment this. */
  skippedClips: number;
}

/**
 * Compound export keeps the legacy flat document for projects without a
 * compound carrier. Once a carrier exists, reachable nested timelines get
 * upstream's sequence/media resources and the parent gets ref-clips. The
 * importer deliberately remains flat/unsupported for this export-first slice.
 */
function exportCompoundFcpxmlWithReport(project: Project): FcpxmlExportResult {
  const fps = project.settings.fps;
  const { width, height } = project.settings;
  const unsupported: string[] = [];
  let skippedClips = 0;
  const timelines = project.timelines ?? {};

  interface TimelineLayout {
    tracks: TrackInfo[];
    videoTracks: TrackInfo[];
    audioTracks: TrackInfo[];
  }

  const layoutFor = (timeline: Timeline): TimelineLayout => {
    const tracks = timeline.tracks.map((track, index) => ({
      id: track.id,
      kind: track.type,
      order: track.order,
      index,
      visible: track.visible,
    }));
    return {
      tracks,
      videoTracks: tracks.filter((track) => track.kind === 'video'),
      audioTracks: tracks.filter((track) => track.kind === 'audio'),
    };
  };

  const laneFor = (clip: Clip, layout: TimelineLayout): number => {
    const track = layout.tracks.find((candidate) => candidate.id === clip.trackId);
    if (clip.type === 'audio' || track?.kind === 'audio') {
      const index = layout.audioTracks.findIndex((candidate) => candidate.id === clip.trackId);
      return -(index + 1);
    }
    // Upstream numbers visual lanes from the top: a lone video track is lane 1.
    const index = layout.videoTracks.findIndex((candidate) => candidate.id === clip.trackId);
    return index < 0 ? 1 : Math.max(1, layout.videoTracks.length - index);
  };

  const enabledFor = (clip: Clip, layout: TimelineLayout): boolean =>
    layout.tracks.find((track) => track.id === clip.trackId)?.visible !== false;

  const orderedClips = (timeline: Timeline, layout: TimelineLayout): Clip[] =>
    [...timeline.clips].sort((a, b) => {
      const start = a.startFrame - b.startFrame;
      if (start !== 0) return start;
      return laneFor(a, layout) - laneFor(b, layout);
    });

  const timelineFrameSpan = (timeline: Timeline): number =>
    timeline.clips.reduce((end, clip) => {
      const start = Number.isFinite(clip.startFrame) ? Math.max(0, clip.startFrame) : 0;
      const duration = Number.isFinite(clip.durationFrames) ? Math.max(0, clip.durationFrames) : 0;
      return Math.max(end, start + duration);
    }, 0);

  const compoundWindow = (clip: Clip, childDuration: number): { start: number; duration: number } => {
    const start = Number.isFinite(clip.inPoint) ? Math.max(0, clip.inPoint) : 0;
    const requestedDuration = Number.isFinite(clip.durationFrames) ? Math.max(0, clip.durationFrames) : 0;
    const hasOutPoint = Number.isFinite(clip.outPoint) && clip.outPoint > start;
    const endCandidate = hasOutPoint ? clip.outPoint : start + requestedDuration;
    const end = Math.min(childDuration, Number.isFinite(endCandidate) ? endCandidate : 0);
    return { start, duration: Math.min(requestedDuration, Math.max(0, end - start)) };
  };

  const compoundKey = (timelineId: string, clipId: string): string => JSON.stringify([timelineId, clipId]);
  const reported = new Set<string>();
  const reportOnce = (key: string, message: string): void => {
    if (reported.has(key)) return;
    reported.add(key);
    unsupported.push(message);
  };

  type CompoundState = 'visiting' | 'valid' | 'invalid';
  const states = new Map<string, CompoundState>();
  const compoundValid = new Map<string, boolean>();
  const validNestedIds = new Set<string>();

  // Validate the complete reachable graph before allocating any sequence ID.
  // A child that fails validation invalidates every carrier above it, so a
  // cyclic or over-depth branch can never leave a partial <media> resource.
  function inspectCompound(
    clip: Clip,
    timelineId: string,
    parentDepth: number,
    path: string[],
  ): boolean {
    const key = compoundKey(timelineId, clip.id);
    const known = compoundValid.get(key);
    if (known !== undefined) return known;

    const ref = sanitizeCompoundTimelineId(clip.compoundTimelineId);
    if (!ref) {
      compoundValid.set(key, false);
      reportOnce(key, `Compound clip "${clip.id}" has no nested timeline reference; it is skipped.`);
      return false;
    }

    if (path.includes(ref)) {
      compoundValid.set(key, false);
      reportOnce(
        key,
        `Compound clip "${clip.id}" forms a nested timeline cycle (${[...path, ref].join(' -> ')}); it is skipped.`,
      );
      return false;
    }

    const depth = parentDepth + 1;
    if (depth > MAX_COMPOUND_DEPTH) {
      compoundValid.set(key, false);
      reportOnce(
        key,
        `Compound clip "${clip.id}" would exceed the maximum nested depth of ${MAX_COMPOUND_DEPTH}; it is skipped.`,
      );
      return false;
    }

    const child = timelines[ref];
    if (!child) {
      compoundValid.set(key, false);
      reportOnce(
        key,
        `Compound clip "${clip.id}" references unknown nested timeline "${ref}"; it is skipped.`,
      );
      return false;
    }

    const childDuration = timelineFrameSpan(child);
    if (childDuration <= 0) {
      compoundValid.set(key, false);
      reportOnce(
        key,
        `Compound clip "${clip.id}" references empty nested timeline "${ref}"; it is skipped.`,
      );
      return false;
    }
    if (compoundWindow(clip, childDuration).duration <= 0) {
      compoundValid.set(key, false);
      reportOnce(
        key,
        `Compound clip "${clip.id}" has no usable source window in nested timeline "${ref}"; it is skipped.`,
      );
      return false;
    }

    const state = states.get(ref);
    if (state === 'invalid') {
      compoundValid.set(key, false);
      return false;
    }
    if (state === 'visiting') {
      compoundValid.set(key, false);
      reportOnce(
        key,
        `Compound clip "${clip.id}" forms a nested timeline cycle through "${ref}"; it is skipped.`,
      );
      return false;
    }
    if (state === 'valid') {
      compoundValid.set(key, true);
      return true;
    }

    states.set(ref, 'visiting');
    path.push(ref);
    const childLayout = layoutFor(child);
    let valid = true;
    for (const inner of orderedClips(child, childLayout)) {
      if (inner.type === 'compound' && !inspectCompound(inner, ref, depth, path)) valid = false;
    }
    path.pop();
    states.set(ref, valid ? 'valid' : 'invalid');
    compoundValid.set(key, valid);
    if (valid) validNestedIds.add(ref);
    return valid;
  }

  const rootLayout = layoutFor(project.timeline);
  const rootClips = orderedClips(project.timeline, rootLayout);
  for (const clip of rootClips) {
    if (clip.type === 'compound') inspectCompound(clip, '', 0, []);
  }

  // Allocate nest IDs in discovery/preorder, matching upstream's nest1,
  // nest2, ... naming while reusing a resource for shared references.
  const nestIds = new Map<string, string>();
  const compoundMedia = new Map<string, string>();
  const assignedTimelineIds = new Set<string>();
  let nextNestId = 1;
  function assignCompoundReferences(clip: Clip, timelineId: string): void {
    if (clip.type !== 'compound' || compoundValid.get(compoundKey(timelineId, clip.id)) !== true) return;
    const ref = sanitizeCompoundTimelineId(clip.compoundTimelineId);
    if (!ref || !validNestedIds.has(ref)) return;
    if (!nestIds.has(ref)) nestIds.set(ref, `nest${nextNestId++}`);
    compoundMedia.set(compoundKey(timelineId, clip.id), nestIds.get(ref)!);
    if (assignedTimelineIds.has(ref)) return;
    assignedTimelineIds.add(ref);
    const child = timelines[ref];
    if (!child) return;
    const childLayout = layoutFor(child);
    for (const inner of orderedClips(child, childLayout)) assignCompoundReferences(inner, ref);
  }
  for (const clip of rootClips) assignCompoundReferences(clip, '');

  const assetsByPath = new Map<string, { id: number; asset: MediaAsset }>();
  let nextResourceId = 2; // 1 is reserved for the project format
  const assetFor = (clip: Clip): MediaAsset | null =>
    project.media.find((asset) => asset.id === clip.assetId) ?? null;
  const resourceIdFor = (clip: Clip): number | null => {
    const asset = assetFor(clip);
    if (!asset) return null;
    const key = asset.path.replace(/\\/g, '/').toLowerCase();
    const existing = assetsByPath.get(key);
    if (existing) return existing.id;
    const id = nextResourceId++;
    assetsByPath.set(key, { id, asset });
    return id;
  };

  const collectAssetResources = (timeline: Timeline, visited: Set<string>): void => {
    const layout = layoutFor(timeline);
    for (const clip of orderedClips(timeline, layout)) {
      if (clip.type === 'compound') {
        const ref = sanitizeCompoundTimelineId(clip.compoundTimelineId);
        if (!ref || !nestIds.has(ref) || visited.has(ref)) continue;
        const child = timelines[ref];
        if (!child) continue;
        visited.add(ref);
        collectAssetResources(child, visited);
        continue;
      }
      if (clip.type === 'title' || clip.type === 'shape') continue;
      void resourceIdFor(clip);
    }
  };
  collectAssetResources(project.timeline, new Set());

  let styleSeq = 0;
  const styleDefs: string[] = [];

  const renderTitle = (clip: Clip, layout: TimelineLayout): string => {
    const styleId = `ts${++styleSeq}`;
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
    reportUnsupportedProperties(clip, unsupported);
    reportTitleEffectResource(clip, unsupported);
    const lane = laneFor(clip, layout);
    const enabled = enabledFor(clip, layout);
    return `<title ref="${styleId}" name="${escapeAttr(text.slice(0, 60))}" lane="${lane}"`
      + ` offset="${sec(clip.startFrame, fps)}" start="${sec(clip.inPoint, fps)}"`
      + ` duration="${sec(clip.durationFrames, fps)}" enabled="${enabled ? '1' : '0'}">`
      + `<text><text-style ref="${styleId}">${escapeXml(text)}</text-style></text>`
      + CONFORM_ELEMENT
      + transformElement(clip, width, height, width, height, fps)
      + blendElement(clip, fps)
      + `</title>`;
  };

  const renderCompound = (
    clip: Clip,
    timelineId: string,
    layout: TimelineLayout,
  ): string | null => {
    const ref = sanitizeCompoundTimelineId(clip.compoundTimelineId);
    const mediaId = compoundMedia.get(compoundKey(timelineId, clip.id));
    const child = ref ? timelines[ref] : undefined;
    if (!ref || !mediaId || !child) {
      skippedClips += 1;
      return null;
    }

    const sourceWindow = compoundWindow(clip, timelineFrameSpan(child));
    const { start: sourceStart, duration } = sourceWindow;
    if (!(duration > 0)) {
      skippedClips += 1;
      return null;
    }

    reportUnsupportedProperties(clip, unsupported);
    const lane = laneFor(clip, layout);
    const enabled = enabledFor(clip, layout);
    const name = child.name?.trim() || clip.label || 'Nested sequence';
    const attrs = `<ref-clip ref="${mediaId}" name="${escapeAttr(name)}" lane="${lane}"`
      + ` offset="${sec(clip.startFrame, fps)}" start="${sec(sourceStart, fps)}"`
      + ` duration="${sec(duration, fps)}" enabled="${enabled ? '1' : '0'}" srcEnable="video"`;
    const children = CONFORM_ELEMENT
      + cropElement(clip, width, height)
      + transformElement(clip, width, height, width, height, fps)
      + blendElement(clip, fps)
      + volumeElement(clip);
    return `${attrs}>${children}</ref-clip>`;
  };

  const renderAsset = (clip: Clip, layout: TimelineLayout): string | null => {
    const resourceId = resourceIdFor(clip);
    if (resourceId === null) {
      skippedClips += 1;
      const message = clip.type === 'generated'
        ? `Generated clip "${clip.id}" skipped; its media asset is missing.`
        : `Clip "${clip.id}" skipped; its media asset is missing.`;
      reportOnce(compoundKey('', clip.id), message);
      return null;
    }

    const lane = laneFor(clip, layout);
    const enabled = enabledFor(clip, layout);
    const offset = sec(clip.startFrame, fps);
    const duration = sec(clip.durationFrames, fps);
    const start = sec(clip.inPoint, fps);
    const name = escapeAttr(clip.label || (clip.type === 'audio' ? 'Audio' : 'Clip'));

    if (clip.type === 'audio' || layout.tracks.find((track) => track.id === clip.trackId)?.kind === 'audio') {
      reportUnsupportedProperties(clip, unsupported);
      const open = `<asset-clip ref="${resourceId}" name="${name}" lane="${lane}"`
        + ` offset="${offset}" start="${start}" duration="${duration}" enabled="${enabled ? '1' : '0'}"`
        + ` audioRole="dialogue"`;
      const adjust = volumeElement(clip);
      return adjust ? `${open}>${adjust}</asset-clip>` : `${open}/>`;
    }

    const asset = assetFor(clip);
    const fitted = aspectFit(asset?.width ?? 0, asset?.height ?? 0, width, height);
    reportUnsupportedProperties(clip, unsupported);
    const timeMap = asset ? timeMapElement(clip, asset, fps, unsupported) : '';
    const clipSourceIn = timeMap ? retimedSourceStart(clip, fps) : start;
    const elementName = clip.type === 'image' ? 'video' : 'asset-clip';
    const open = `<${elementName} ref="${resourceId}" name="${name}" lane="${lane}"`
      + ` offset="${offset}" start="${clipSourceIn}" duration="${duration}" enabled="${enabled ? '1' : '0'}"`;
    const adjust = timeMap
      + CONFORM_ELEMENT
      + blendElement(clip, fps)
      + transformElement(clip, width, height, fitted.w, fitted.h, fps)
      + cropElement(clip, asset?.width ?? width, asset?.height ?? height)
      + volumeElement(clip);
    return adjust ? `${open}>${adjust}</${elementName}>` : `${open}/>`;
  };

  const renderClip = (clip: Clip, timeline: Timeline, timelineId: string): string | null => {
    const layout = layoutFor(timeline);
    if (clip.type === 'title') return renderTitle(clip, layout);
    if (clip.type === 'shape') {
      unsupported.push(`Shape clip "${clip.id}" skipped; shape clips have no FCPXML form.`);
      skippedClips += 1;
      return null;
    }
    if (clip.type === 'compound') return renderCompound(clip, timelineId, layout);
    return renderAsset(clip, layout);
  };

  const renderTimelineBody = (timeline: Timeline, timelineId: string): { xml: string; exportedClips: number } => {
    const layout = layoutFor(timeline);
    reportLinkedAvGroups(orderedClips(timeline, layout), unsupported);
    const elements: string[] = [];
    for (const clip of orderedClips(timeline, layout)) {
      const element = renderClip(clip, timeline, timelineId);
      if (element) elements.push(element);
    }
    return { xml: elements.join(''), exportedClips: elements.length };
  };

  const rootBody = renderTimelineBody(project.timeline, '');
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE fcpxml>');
  lines.push(
    `<fcpxml version="1.11"><resources><format id="r1" frameDuration="${(1 / fps).toFixed(SEC_PRECISION)}s" width="${width}" height="${height}"/>`,
  );

  for (const { id, asset } of assetsByPath.values()) {
    const flags = [
      assetHasVideo(asset) ? 'hasVideo="1"' : null,
      assetHasAudio(asset) ? 'hasAudio="1"' : null,
    ].filter(Boolean).join(' ');
    const durSec = asset.duration > 0 ? `${asset.duration.toFixed(SEC_PRECISION)}s` : '0s';
    const assetAttrs =
      `<asset id="${id}" name="${escapeAttr(asset.filename)}" src="${escapeAttr(fileUrl(asset.path))}"`
      + ` start="0s" duration="${durSec}" ${flags} format="r1"`;
    const startSeconds = asset.startTimecode
      ? timecodeToSeconds(asset.startTimecode, asset.fps ?? fps)
      : null;
    if (startSeconds === null) {
      lines.push(`${assetAttrs}/>`);
    } else {
      lines.push(`${assetAttrs}>`);
      lines.push(`<timecode start="${startSeconds.toFixed(SEC_PRECISION)}s" duration="${durSec}" format="r1"/>`);
      lines.push('</asset>');
    }
  }

  const nestedEntries = [...nestIds.entries()].sort((a, b) => {
    const aNumber = Number(a[1].slice(4));
    const bNumber = Number(b[1].slice(4));
    return aNumber - bNumber;
  });
  for (const [timelineId, mediaId] of nestedEntries) {
    const timeline = timelines[timelineId];
    if (!timeline) continue;
    const duration = timelineFrameSpan(timeline);
    const body = renderTimelineBody(timeline, timelineId).xml;
    const gap = `<gap name="Timeline" offset="0s" start="0s" duration="${sec(duration, fps)}">`
      + `${body}</gap>`;
    const sequence = `<sequence format="r1" duration="${sec(duration, fps)}" tcStart="0s" tcFormat="NDF"`
      + ` audioLayout="stereo" audioRate="48k"><spine>${gap}</spine></sequence>`;
    const name = timeline.name?.trim() || `Nested ${mediaId}`;
    lines.push(`<media id="${mediaId}" name="${escapeAttr(name)}">${sequence}</media>`);
  }

  lines.push(
    `</resources><library><event name="${escapeAttr(project.name || 'Palmier Project')}"><project name="${escapeAttr(project.name || 'Palmier Project')}"><spine>${rootBody.xml}</spine></project></event></library>`,
  );
  for (const def of styleDefs.reverse()) lines.push(def);
  lines.push('</fcpxml>');

  return { xml: lines.join(''), unsupported, exportedClips: rootBody.exportedClips, skippedClips };
}

/**
 * Export the supported subset of a project as FCPXML 1.11 text.
 * Throws only when there is nothing representable at all (no clips).
 */
export function exportFcpxmlWithReport(project: Project): FcpxmlExportResult {
  if (project.timeline.clips.some((clip) => clip.type === 'compound')) {
    return exportCompoundFcpxmlWithReport(project);
  }

  const fps = project.settings.fps;
  const { width, height } = project.settings;
  const tracks = describeTracks(project);
  const unsupported: string[] = [];
  let skippedClips = 0;

  const sortedClips = [...project.timeline.clips].sort((a, b) => {
    const ta = tracks.find((t) => t.id === a.trackId);
    const tb = tracks.find((t) => t.id === b.trackId);
    return (ta?.order || 0) - (tb?.order || 0);
  });
  reportLinkedAvGroups(sortedClips, unsupported);

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

  const assetFor = (clip: Clip): MediaAsset | null =>
    project.media.find((m) => m.id === clip.assetId) ?? null;

  if (sortedClips.length === 0) {
    throw new Error('No clips to export — the timeline is empty.');
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
    const assetAttrs =
      `<asset id="${id}" name="${escapeAttr(asset.filename)}" src="${escapeAttr(fileUrl(asset.path))}"`
      + ` start="0s" duration="${durSec}" ${flags} format="r1"`;
    // A source start timecode (#154) rides a standard <timecode> child, so
    // conforming apps keep the source offset; drop-frame strings cannot be
    // converted exactly and are omitted rather than written wrong.
    const startSeconds = asset.startTimecode
      ? timecodeToSeconds(asset.startTimecode, asset.fps ?? fps)
      : null;
    if (startSeconds === null) {
      lines.push(`${assetAttrs}/>`);
    } else {
      lines.push(`${assetAttrs}>`);
      lines.push(
        `<timecode start="${startSeconds.toFixed(SEC_PRECISION)}s" duration="${durSec}" format="r1"/>`,
      );
      lines.push('</asset>');
    }
  }

  // ── Library / event / spine ────────────────────────────────────────────────
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
      reportUnsupportedProperties(clip, unsupported);
      reportTitleEffectResource(clip, unsupported);
      // Local titles carry the same real clip box as media; use the media
      // transform bridge so identity geometry stays omitted and imports agree.
      const titleTransform = transformElement(clip, width, height, width, height, fps);
      const titleBlend = blendElement(clip, fps);
      bodyLines.push(
        `<title name="${escapeAttr(text.slice(0, 60))}" lane="0" offset="${offset}"`
        + ` duration="${duration}" ref="${styleId}" start="${sourceIn}">`
        + `<text><text-style ref="${styleId}">${escapeXml(text)}</text-style></text>`
        + CONFORM_ELEMENT
        + titleTransform
        + titleBlend
        + `</title>`,
      );
      continue;
    }

    // Shape clips are Palmier-native vectors with no FCPXML form; report and
    // skip them explicitly rather than dropping them silently (the resource
    // lookup below would otherwise skip them without a note).
    if (clip.type === 'shape') {
      unsupported.push(`Shape clip "${clip.id}" skipped; shape clips have no FCPXML form.`);
      skippedClips += 1;
      continue;
    }

    if (clip.type === 'compound') {
      unsupported.push(
        `Compound clip "${clip.id}" is not represented by FCPXML; its nested timeline is not emitted.`,
      );
      skippedClips += 1;
      continue;
    }

    const resourceId = resourceIdFor(clip);
    if (!resourceId) {
      if (clip.type === 'generated') {
        unsupported.push(`Generated clip "${clip.id}" skipped; its media asset is missing.`);
      } else {
        unsupported.push(`Clip "${clip.id}" skipped; its media asset is missing.`);
      }
      skippedClips += 1;
      continue;
    }

    if (clip.type === 'audio' || track?.kind === 'audio') {
      reportUnsupportedProperties(clip, unsupported);
      const audioLane = -(1 + Math.max(0, audioTracks.findIndex((t) => t.id === clip.trackId)));
      const adjust = volumeElement(clip);
      const open =
        `<asset-clip name="${escapeAttr(clip.label || 'Audio')}" lane="${audioLane}"`
        + ` offset="${offset}" duration="${duration}" start="${sourceIn}"`
        + ` ref="${resourceId}" audioRole="dialogue"`;
      bodyLines.push(adjust.length > 0 ? `${open}>${adjust}</asset-clip>` : `${open}/>`);
      continue;
    }

    // Visual clip on the spine track vs a connected upper track. Lanes are
    // dense among upper tracks (1..N) so FCP stacks them in track order.
    // Retime, opacity, geometry, crop and volume ride clip children; identity
    // values are omitted so a plain clip stays a one-line element.
    const onSpine = clip.trackId === spineTrackId;
    let laneAttr = '';
    if (!onSpine) {
      const upperRank = videoTrackIds
        .filter((t) => t.id !== spineTrackId)
        .sort((a, b) => a.order - b.order)
        .findIndex((t) => t.id === clip.trackId);
      laneAttr = ` lane="${Math.max(0, upperRank) + 1}"`;
    }
    const asset = assetFor(clip);
    const fitted = aspectFit(asset?.width ?? 0, asset?.height ?? 0, width, height);
    reportUnsupportedProperties(clip, unsupported);
    const elementName = clip.type === 'image' ? 'video' : 'asset-clip';
    const timeMap = asset ? timeMapElement(clip, asset, fps, unsupported) : '';
    const clipSourceIn = timeMap ? retimedSourceStart(clip, fps) : sourceIn;
    const adjust =
      timeMap
      + CONFORM_ELEMENT
      + blendElement(clip, fps)
      + transformElement(clip, width, height, fitted.w, fitted.h, fps)
      + cropElement(clip, asset?.width ?? width, asset?.height ?? height)
      + volumeElement(clip);
    const open =
      `<${elementName} name="${escapeAttr(clip.label || 'Clip')}"${laneAttr}`
      + ` offset="${offset}" duration="${duration}" start="${clipSourceIn}"`
      + ` ref="${resourceId}"`;
    bodyLines.push(adjust.length > 0 ? `${open}>${adjust}</${elementName}>` : `${open}/>`);
  }

  lines.push(`<spine>${bodyLines.join('')}</spine></project></event></library>`);
  for (const def of styleDefs.reverse()) lines.push(def);
  lines.push('</fcpxml>');

  return { xml: lines.join(''), unsupported, exportedClips: bodyLines.length, skippedClips };
}

/**
 * Export the supported subset of a project as FCPXML 1.11 text.
 * Shape clips and clips with missing media are skipped
 * (see exportFcpxmlWithReport for the report).
 * Throws only when there is nothing representable at all (no clips).
 */
export function exportFcpxml(project: Project): string {
  return exportFcpxmlWithReport(project).xml;
}

/** Case transform mirroring the render paths (#330). */
function applyCase(text: string, mode?: 'original' | 'upper' | 'lower'): string {
  if (mode === 'upper') return text.toUpperCase();
  if (mode === 'lower') return text.toLowerCase();
  return text;
}

