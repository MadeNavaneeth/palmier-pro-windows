/**
 * FCPXML import (#154) — parse Final Cut Pro XML into a structured plan.
 *
 * Phase 2a: pure parser, no Electron, no editor mutation. Callers (executor /
 * future dialog) receive assets by absolute path plus clips keyed to lane
 * numbers they can materialize onto real tracks.
 *
 * Supported: <format> timing, <asset> resources, spine asset-clips, still-image
 * <video> elements and connected visual elements (lane attr), compound
 * <ref-clip> carriers with recursively validated <media>/<sequence> resources,
 * titles with inline text-style refs; upstream <adjust-conform type="fit"/> is accepted
 * and ignored because it is a consumer fit hint with no local clip field (and
 * because this writer puts it on every visual element, so reporting it would be
 * a note per clip on every import),
 * decimal ("1.5s") and rational ("45/30s") times, opacity (`adjust-blend`,
 * including nested amount keyframes), constant visual retiming
 * (`<timeMap>` with two linear `<timept>` children), static geometry
 * (`adjust-transform` attributes) and keyframed
 * position/scale/rotation (`<param>`/`<keyframeAnimation>` children, mapped
 * to the motion tracks), crop (`adjust-crop` **in `trim` mode only** — see
 * `cropTrimOf` for why every other mode is refused rather than read) and volume
 * (title keyframes remain explicitly reported rather than partially applied)
 * (`adjust-volume`) as the exporter writes them — plus the same elements from
 * third-party files, narrowed on read. Gaps are implicit —
 * absolute clip offsets already encode spacing. Everything else lands in
 * `unsupported` as readable notes so nothing disappears silently, by five
 * mechanisms:
 *
 * 1. `UNREPRESENTED_ELEMENTS` — every element this importer reads for nothing,
 *    reported ONCE PER DOCUMENT each, every name quoted from Apple's published
 *    FCPXML DTD and grouped by the DTD group that makes it legal: the four
 *    remaining `%marker_item`s; the per-channel and per-role audio components
 *    under both the 1.4 and the 1.10 names plus their `<mute>`; the
 *    `%intrinsic-params-video` members added after the first pass (360
 *    re-projection, reorient, orientation, cinematic, `object-tracker`); the
 *    `<asset>` children; and library organisation. Several mirror a feature this
 *    editor SHIPS — color grade, EQ, noise reduction, fades, and
 *    `MediaAsset.channels`/`sampleRate` below — which is what made their silence
 *    a defect rather than a gap.
 * 2. `adjust-crop` in any mode but `trim` is REFUSED, not read (see
 *    `cropTrimOf`).
 * 3. `adjust-blend mode` is reported while its `amount` still applies as plain
 *    opacity, because the DTD's `mode` is an open `CDATA` with no published value
 *    list to map and a wrong composite is worse than a plain one.
 * 4. Spine-element attributes are reported only when they state something: a
 *    DISABLED `enabled="0"`, an `audioRole` other than the `dialogue` our writer
 *    stamps on every audio element, a `videoRole` other than the `video` default,
 *    a J/L split edit, `useAudioSubroles="1"`, and the `<asset>` component and
 *    colour-management attributes (one note per asset, since which asset is the
 *    actionable part).
 * 5. The construct scan below, for the effects, filters, notes and shape-ish
 *    elements.
 *
 * Shape-ish constructs (generators, shapes, graphics) have no Windows analogue —
 * upstream has no shapes and no FCPXML shape transport — so they are reported and
 * skipped the same way, as is any unknown spine element.
 */

import { secondsToTimecode } from '../media/timecode';
import { effectiveSpeed } from '../media/source-time';
import { sanitizeMotion, type MotionEasing, type MotionPoint, type MotionTrack } from '../media/motion';
import {
  COMPOUND_NAME_MAX_LENGTH,
  MAX_COMPOUND_DEPTH,
  sanitizeCompoundTimelineId,
} from '../editor/compound';
import { asValidFrame } from '../utils/safe-number';
import type {
  FcpxmlKeyframePair,
  FcpxmlKeyframeScalar,
  FcpxmlTransform,
  FcpxmlTransformKeyframes,
} from './geometry';

export interface ImportedAsset {
  /** Resource id as referenced by clips (e.g. "4"). */
  ref: string;
  /** Absolute filesystem path from the file:// src. */
  path: string;
  hasVideo: boolean;
  hasAudio: boolean;
  durationSec: number;
  /**
   * Source start timecode rebuilt from the asset's `<timecode>` child
   * (#154), in the project's frame rate. Absent when the XML carries none.
   */
  startTimecode?: string;
}

export interface ImportedVideoClip {
  kind: 'video';
  /** Lane 0 = spine, ≥1 = connected above in ascending order. */
  lane: number;
  startFrame: number;
  durationFrames: number;
  sourceInFrame: number;
  assetPath: string;
  label: string;
  /** Linear 0-1 opacity from <adjust-blend>; absent means opaque. */
  opacity?: number;
  /** Constant source-time multiplier recovered from a linear <timeMap>. */
  speed?: number;
  /** Absolute-timeline opacity automation from adjust-blend amount keyframes. */
  opacityTrack?: MotionTrack;
  /** Linear gain from <adjust-volume>; absent means unity. */
  volume?: number;
  /** Silence has no per-clip flag in FCPXML; ≤-90dB arrives muted. */
  muted?: boolean;
  /** Source fractions from <adjust-crop> trim-rect (see geometry). */
  cropTrim?: { left: number; top: number; right: number; bottom: number };
  /** FCPXML-native geometry (see geometry.placementFromTransform). */
  transform?: { positionX: number; positionY: number; scaleX: number; scaleY: number; rotation: number };
  /**
   * FCPXML-native transform keyframes (absolute timeline frames); apply.ts
   * converts them onto the motion tracks (see geometry.motionFromTransformKeyframes).
   */
  transformKeyframes?: FcpxmlTransformKeyframes;
  /**
   * Present only on a parsed <ref-clip>. Keeping the carrier in the video
   * variant preserves legacy ImportedClip narrowing for existing callers;
   * apply.ts checks this field before the ordinary asset path.
   */
  compoundSequenceRef?: string;
}

export interface ImportedAudioClip {
  kind: 'audio';
  /** Negative: -1 is the first lane below the spine. */
  lane: number;
  startFrame: number;
  durationFrames: number;
  sourceInFrame: number;
  assetPath: string;
  label: string;
  /** Linear gain from <adjust-volume>; absent means unity. */
  volume?: number;
  /** Silence has no per-clip flag in FCPXML; ≤-90dB arrives muted. */
  muted?: boolean;
}

export interface ImportedTitle {
  kind: 'title';
  lane: number;
  startFrame: number;
  durationFrames: number;
  text: string;
  fontFamily?: string;
  fontSizePx?: number;
  colorHex?: string;
  alignment?: 'left' | 'center' | 'right';
  /** Linear 0-1 opacity from <adjust-blend>. */
  opacity?: number;
  /** FCPXML-native title geometry. */
  transform?: FcpxmlTransform;
}

export type ImportedCompoundClip = ImportedVideoClip & {
  /** Sanitized FCPXML media-resource id; never used directly as a local id. */
  compoundSequenceRef: string;
};

export function isImportedCompoundClip(clip: ImportedClip): clip is ImportedCompoundClip {
  return clip.kind === 'video' && typeof clip.compoundSequenceRef === 'string';
}

export type ImportedClip =
  | ImportedVideoClip
  | ImportedAudioClip
  | ImportedTitle;

export interface ImportedSequence {
  /** Sanitized id of the owning <media id="…"> resource. */
  ref: string;
  name: string;
  durationFrames: number;
  clips: ImportedClip[];
}

export interface ParsedFcpxml {
  name: string;
  /** Rounded from <format frameDuration>; null when absent/non-integer. */
  fps: number | null;
  width: number;
  height: number;
  assets: ImportedAsset[];
  clips: ImportedClip[];
  /**
   * Reachable sequence resources in preorder. Omitted entirely for legacy
   * flat documents so their parsed plan remains shape-for-shape compatible.
   */
  sequences?: ImportedSequence[];
  /** Readable notes for constructs present but not representable here. */
  unsupported: string[];
}

/** Parse "1.500000s" or "45/30s" (or bare "1.5") into seconds. */
export function parseFcpxmlTime(value: string): number | null {
  const trimmed = value.trim();
  const rational = trimmed.match(/^(-?\d+)\/(\d+(?:\.\d+)?)s$/);
  if (rational) {
    const den = Number(rational[2]);
    return den > 0 ? Number(rational[1]) / den : null;
  }
  const decimal = trimmed.match(/^(-?\d+(?:\.\d+)?)s$/);
  if (decimal) return Number(decimal[1]);
  const bare = Number(trimmed);
  return Number.isFinite(bare) ? bare : null;
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

function numAttr(tag: string, name: string): number | null {
  const raw = attr(tag, name);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function fileUrlToPath(src: string): string {
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch { /* keep raw */ }
  return decoded.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '/');
}

/** "sx sy" pair, e.g. adjust-transform scale/position. */
function parsePair(value: string | null): [number, number] | null {
  if (value === null) return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return Number.isFinite(first) && Number.isFinite(second) ? [first, second] : null;
}

/** "−6.0206dB" (suffix optional) to decibels. */
function parseDbAmount(value: string | null): number | null {
  if (value === null) return null;
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(dB)?$/);
  if (!match) return null;
  const db = Number(match[1]);
  return Number.isFinite(db) ? db : null;
}

/** Linear 0-1 opacity from <adjust-blend>; undefined when absent/unusable. */
function blendOf(tag: string): number | undefined {
  const match = tag.match(/<adjust-blend\b[^>]*amount="([^"]*)"/);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function transformOf(tag: string): ImportedVideoClip['transform'] {
  const match = tag.match(/<adjust-transform\b[^>]*>/);
  if (!match) return undefined;
  const scale = parsePair(attr(match[0], 'scale')) ?? [1, 1];
  const rotation = numAttr(match[0], 'rotation') ?? 0;
  const position = parsePair(attr(match[0], 'position')) ?? [0, 0];
  if (scale[0] === 1 && scale[1] === 1 && rotation === 0 && position[0] === 0 && position[1] === 0) {
    return undefined;
  }
  return {
    positionX: position[0],
    positionY: position[1],
    scaleX: scale[0],
    scaleY: scale[1],
    rotation,
  };
}

/**
 * The whole of one clip's `<adjust-crop>`, and the only mode this importer reads.
 *
 * `adjust-crop@mode` is **#REQUIRED** in Apple's FCPXML DTD and its value set is
 * exactly `(trim | crop | pan)`:
 *
 *     <!-- This element contains an optional adjustment for each crop mode,
 *          although only one mode is active. -->
 *     <!ELEMENT adjust-crop (crop-rect?, trim-rect?, (pan-rect, pan-rect)?)>
 *     <!ATTLIST adjust-crop mode (trim | crop | pan) #REQUIRED>
 *
 * The mode selects WHICH child rect is the live adjustment, and the three mean
 * different things. `trim-rect` "specifies trim values as a percentage of
 * original frame height" — the edges trimmed OFF, i.e. the region kept — which is
 * what `cropFromTrim` inverts, and it is the only mode whose rect is a set of
 * edge amounts. `crop-rect` is the scale-in ("Crop" in FCP's Cropping panel), not
 * an edge trim. `pan-rect` is a start/end pair driving a Ken Burns move, and the
 * DTD notes its attributes cannot be keyframed.
 *
 * So `trim` is applied and nothing else is. That is not only a missing-feature
 * boundary: because the DTD lets a document carry `crop-rect?`, `trim-rect?` AND
 * `(pan-rect, pan-rect)?` together with only ONE active, a `mode="crop"`
 * document can legitimately carry an inactive `<trim-rect>` beside its live
 * `<crop-rect>`. Reading that as the crop would apply a rect the document itself
 * says is switched off — a wrong crop, with nothing to distinguish it from a
 * right one. Refusing every other mode (and a missing one, which the DTD does
 * not permit at all) turns that silent wrong value into a visible omission, which
 * is the same stance the exporter takes on `adjust-blend@mode`: a wrong composite
 * is worse than a plain one.
 *
 * The crop keyframe report lives here rather than at the call site because its
 * truth now depends on the mode: "base crop kept" would be a lie about a block
 * that was refused outright.
 */
function cropTrimOf(
  tag: string,
  element: string,
  label: string,
  unsupported: string[],
): ImportedVideoClip['cropTrim'] {
  const block = adjustBlock(tag, 'adjust-crop');
  if (!block) return undefined;
  const mode = attr(block, 'mode');
  if (mode !== 'trim') {
    unsupported.push(
      `${element} "${label}" has adjust-crop mode="${mode ?? '(none)'}";`
      + ' only mode="trim" is imported, so no crop is applied from it.',
    );
    return undefined;
  }
  // In trim mode the keyframe note is true whether or not a non-identity base
  // was read: an absent base IS identity, and identity is what is kept.
  if (block.includes('<keyframeAnimation')) {
    unsupported.push(
      `${element} "${label}" animates crop; crop keyframes are not transported (base crop kept).`,
    );
  }
  const rect = block.match(/<trim-rect\b[^>]*>/)?.[0];
  if (!rect) return undefined;
  const read = (name: string): number => numAttr(rect, name) ?? 0;
  const trim = { left: read('left'), top: read('top'), right: read('right'), bottom: read('bottom') };
  if (!(trim.left > 0 || trim.right > 0 || trim.top > 0 || trim.bottom > 0)) return undefined;
  return trim;
}

/**
 * Volume from <adjust-volume>: decibels to linear gain. At or below −90dB the
 * clip arrives muted — FCPXML has no per-clip mute flag, and that floor is
 * inaudible either way. Unity gain carries nothing, keeping plans clean.
 */
function volumeOf(tag: string): { volume: number; muted: boolean } | undefined {
  const match = tag.match(/<adjust-volume\b[^>]*amount="([^"]*)"/);
  if (!match) return undefined;
  const db = parseDbAmount(match[1]);
  if (db === null) return undefined;
  if (db <= -90) return { volume: 0, muted: true };
  const linear = Math.pow(10, db / 20);
  if (Math.abs(linear - 1) <= 0.0005) return undefined;
  return { volume: Math.min(1, Math.max(0, linear)), muted: false };
}

function hasTimeMapElement(tag: string): boolean {
  return /<timeMap\b/.test(tag);
}

function reportTimeMap(label: string, reason: string, unsupported: string[]): void {
  unsupported.push(`Asset-clip "${label}" has an unsupported timeMap: ${reason}.`);
}

/**
 * Two spine-element attributes this importer never represented, reported here so
 * a document carrying them cannot lose them without a word.
 *
 * `enabled` is the element's OWN on/off state — FCPXML's per-element Enabled
 * toggle, which our writer derives from the owning track's `visible` rather than
 * from anything per clip. The model has no per-clip equivalent: `Track.visible`
 * is the nearest field, and switching a whole track off is not the same
 * statement as disabling one element inside it, so this is unrepresentable
 * rather than a missing two-line mapping, and a disabled element imports
 * enabled. Only a DISABLED element is reported, because `enabled="1"` states
 * nothing: it is the value our writer puts on every element it emits, so a
 * per-element note for it would be a note per element on every document we
 * produce. That is the same rule `transformOf`, `volumeOf` and
 * `reporting.test.ts`'s "explicitly present but effective default" case already
 * apply to an identity value written out in full.
 *
 * `audioRole` designates which standard audio role a clip carries (dialogue,
 * narration, music, ambience, effects) for role-based analysis. `Clip` has no
 * role field at all, so no element can represent it. `dialogue` is the role our
 * writer puts on every audio element, so reporting it would add one note per
 * audio element to every round trip and bury every other note in the list; any
 * other designation is information a third-party document authored and this
 * editor cannot hold, which is what gets reported.
 *
 * `adjust-blend@mode` is the one of the three that is NOT a missing model field:
 * `Clip.blendMode` ships twelve W3C modes end to end, so a document naming a
 * composite is a SHIPPED feature arriving unreported rather than a format feature
 * we lack. It is still not honoured, and the reason is upstream's, not ours —
 * `<!ATTLIST adjust-blend mode CDATA #IMPLIED>`, an OPEN enumeration, so the
 * DTD publishes no value list to map from, and the exporter emits no `mode`
 * because "a wrong composite in Resolve is worse than a plain one". Honouring it
 * is therefore gated on finding a verified value mapping, not assumed, and until
 * then the note says so while `amount` keeps applying as the plain opacity it
 * always was.
 */
function reportUnrepresentedAttributes(
  tag: string,
  element: string,
  label: string,
  unsupported: string[],
): void {
  if (attr(tag, 'enabled') === '0') {
    unsupported.push(`${element} "${label}" is disabled (enabled="0"); the disabled state is not imported.`);
  }
  const role = attr(tag, 'audioRole');
  if (role !== null && role !== 'dialogue') {
    unsupported.push(`${element} "${label}" has audioRole="${role}"; audio roles are not imported.`);
  }
  const blend = adjustBlock(tag, 'adjust-blend');
  const blendMode = blend === null ? null : attr(blend, 'mode');
  if (blendMode !== null) {
    unsupported.push(
      `${element} "${label}" has adjust-blend mode="${blendMode}";`
      + ' the composite mode is not imported, and the amount still applies.',
    );
  }
  // `audioStart`/`audioDuration` are a J/L split edit: "Use 'audioStart' and
  // 'audioDuration' to define J/L cuts (i.e., split edits) on composite A/V
  // clips" (DTD 1.10). The model has ONE `inPoint`/`outPoint` pair per clip, so a
  // clip whose audio starts away from its picture has no representation at all,
  // and there is no `Clip` field to add one to without changing what a clip IS.
  // Reported on either attribute, since a duration with no start is still a
  // statement about the audio window.
  const audioStart = attr(tag, 'audioStart');
  if (audioStart !== null || attr(tag, 'audioDuration') !== null) {
    unsupported.push(
      `${element} "${label}" has a J/L split edit (audioStart/audioDuration);`
      + ' split edits are not imported.',
    );
  }
  // `videoRole` defaults to "video" (DTD 1.10), and our writer emits no value at
  // all, so only a designation that says something is reported — the same
  // calibration as `enabled="1"` and `audioRole="dialogue"`.
  const videoRole = attr(tag, 'videoRole');
  if (videoRole !== null && videoRole !== 'video') {
    unsupported.push(`${element} "${label}" has videoRole="${videoRole}"; video roles are not imported.`);
  }
  // `useAudioSubroles` defaults to "0"; "1" asks for the carrier's role-based
  // sub-audio to be used, which this importer has no way to express.
  if (attr(tag, 'useAudioSubroles') === '1') {
    unsupported.push(
      `${element} "${label}" sets useAudioSubroles="1"; role-based sub-audio is not imported.`,
    );
  }
}

/**
 * `srcEnable` is read for nothing and is DELIBERATELY not reported — the reason,
 * recorded here because the silence is a decision rather than an oversight.
 *
 * `exporter.ts` writes `srcEnable="video"` on every `<ref-clip>` it emits — the
 * compound carrier's own audio is unused because the nested clips carry it — and
 * the DTD default is `"all"`, so this is a value our own documents state on every
 * compound carrier. A note here would be a note per carrier on every palmier
 * round trip, which is exactly the noise the calibration rule exists to prevent.
 * A document from another producer setting it to `audio` or `all` is a real
 * omission and is recorded as open rather than reported here.
 */

/**
 * The `<asset>` attributes this importer reads for nothing, one note per asset
 * that states any of them.
 *
 * Per asset rather than per document, because the note is only useful if it says
 * WHICH asset: a location-sound document states these on its multichannel
 * recordings and not on its B-roll, and "some asset has four audio sources" is
 * not actionable where "asset 7 has four audio sources" is. The count is still
 * bounded by the number of assets that actually declare one, and our writer emits
 * none of them on an `<asset>`, so a document we produced stays silent.
 *
 * Scoped to the asset's own tag on purpose. A document-wide scan for the bare
 * name `audioRate` would match the compound writer's
 * `<sequence audioRate="48k">` — which it emits on every nested sequence — and
 * fire on every palmier round trip.
 *
 * Two groups, because they are two different omissions:
 * - `videoSources`/`audioSources` say how many media components the asset has,
 *   and `audioChannels`/`audioRate` describe them. This importer places ONE clip
 *   per asset regardless. `MediaAsset.channels` and `MediaAsset.sampleRate` do
 *   ship, so those two are a shipped field not being transported — the same class
 *   as an unreported `adjust-blend mode` — while the component COUNTS have no
 *   field at all.
 * - The colour-management overrides. `MediaAsset` has no colour-space,
 *   projection, stereoscopic or LUT field, so there is nowhere for them to land.
 */
function reportUnrepresentedAssetAttributes(
  tag: string,
  ref: string,
  unsupported: string[],
): void {
  const components = ['videoSources', 'audioSources', 'audioChannels', 'audioRate']
    .filter((name) => attr(tag, name) !== null);
  if (components.length > 0) {
    unsupported.push(
      `Asset ${ref} declares ${components.join(', ')}; its media component layout is not imported,`
      + ' and the asset is placed as one clip.',
    );
  }
  const colour = ['colorSpaceOverride', 'projectionOverride', 'stereoscopicOverride', 'customLUTOverride']
    .filter((name) => attr(tag, name) !== null);
  if (colour.length > 0) {
    unsupported.push(
      `Asset ${ref} declares ${colour.join(', ')}; colour-management overrides are not imported.`,
    );
  }
}

/**
 * The elements this importer reads for NOTHING, reported once per document each.
 *
 * Every name here is quoted from Apple's published FCPXML DTD, and each is
 * grouped by the DTD group that makes it legal, so the coverage of each group can
 * be checked against the group rather than against this list:
 *
 * - `%marker_item "(marker | chapter-marker | rating | keyword | analysis-marker)"`.
 *   `chapter-marker` is not repeated here because the older construct scan above
 *   already reports it, and two notes for one element is worse than one.
 * - The per-channel and per-role audio components. The DTD renamed these between
 *   versions — `<audio-source>`/`<audio-aux-source>` in 1.4,
 *   `<audio-channel-source>`/`<audio-role-source>` in 1.10 — and this module
 *   targets 1.11, so all four are listed: a reader must report what a document
 *   actually contains, not only what the newest revision calls it. `<mute>` is
 *   legal only inside these, and is a time-RANGED output suppression, which is a
 *   different thing from `Clip.muted` (a whole-clip flag read from an
 *   `adjust-volume` floor).
 * - `%intrinsic-params-video` members added after the ones already listed:
 *   360 re-projection, reorient, orientation, cinematic, and `object-tracker`.
 *   `tracking-shape` needs no entry of its own; it is reachable only inside
 *   `object-tracker`.
 * - The `<asset>` children. `media-rep` is the one that matters: 1.10 moved
 *   `src` off `<asset>` and onto `<media-rep>`, and this importer reads
 *   `asset@src` — see the note in the asset loop for what that does and does not
 *   break today.
 * - Library organisation, which has no timeline content at all but is still a
 *   construct the document had and the imported project will not.
 *
 * ONE note per document rather than one per element, which is the calibration
 * that keeps this safe to add: our writer emits only `adjust-conform`,
 * `adjust-blend@amount`, `adjust-transform`, `adjust-crop`, `adjust-volume`,
 * `timeMap` and — on a `<sequence>` — `audioLayout`/`audioRate`, so a document we
 * produced can never trip any entry here. `adjust-conform` is deliberately absent
 * for the same reason it is deliberately read and discarded: the writer puts it
 * on every visual element, so reporting it would be a note per clip on every
 * import.
 *
 * Deliberately NOT here, each for its own reason rather than by oversight:
 *
 * - `adjust-blend`, `adjust-transform`, `adjust-crop`, `adjust-volume`,
 *   `adjust-conform`, `timeMap` — the five we read, plus the conform hint.
 * - `filter-video`, `filter-audio`, `<effect-ref>`, `<effect `, `<note>`,
 *   `<chapter-marker>`, `<generator*`, `<shape*`, `<graphic*` — the older
 *   construct scan above. That scan is a plain substring test, so
 *   `<filter-video-mask>` is already covered by its `'<filter-video'` needle; it
 *   is left to that scan rather than given a second note here, and the entry
 *   boundary below means adding it would double-report.
 * - `caption`, `sync-clip`, `audio`, `mc-source`, `sync-source` at SPINE level —
 *   `reportSpineElement` already names each one as an unknown spine element. Only
 *   their ANCHORED form (a child of a spine element this module consumes whole)
 *   is a gap, and that is recorded rather than given a duplicate note.
 * - `match-text` and its siblings — reachable only inside `<smart-collection>`,
 *   which is listed.
 * - `audioRole`, `videoRole`, `enabled`, `srcEnable` — attributes, handled where
 *   the element that carries them is parsed, because each has a value that is an
 *   effective default rather than an omission.
 *
 * Spelled as the DTD spells it, including the internal capitals
 * (`adjust-EQ`, `adjust-noiseReduction`, `adjust-humReduction`, `fadeIn`), and
 * matched CASE-INSENSITIVELY (producers are not consistent) but on an element-name
 * BOUNDARY, so `keyword` cannot also match `keyword-collection`.
 */
const UNREPRESENTED_ELEMENTS: readonly string[] = [
  // %marker_item (chapter-marker is in the older construct scan)
  'marker',
  'rating',
  'keyword',
  'analysis-marker',
  // Per-channel / per-role audio components, both DTD generations
  'audio-channel-source',
  'audio-role-source',
  'audio-source',
  'audio-aux-source',
  'mute',
  // %intrinsic-params-video, the members added after the first pass
  'adjust-360-transform',
  'adjust-reorient',
  'adjust-orientation',
  'adjust-cinematic',
  'object-tracker',
  // <asset> children
  'media-rep',
  'bookmark',
  'metadata',
  // Library organisation
  'keyword-collection',
  'collection-folder',
  'smart-collection',
  'import-options',
  // From the first pass: %intrinsic-params-video / -audio / %timing-params
  'info-asc-cdl',
  'adjust-color',
  'adjust-corners',
  'adjust-stabilization',
  'adjust-rollingShutter',
  'adjust-loudness',
  'adjust-noiseReduction',
  'adjust-humReduction',
  'adjust-EQ',
  'adjust-matchEQ',
  'adjust-panner',
  'conform-rate',
  'fadeIn',
  'fadeOut',
];

/**
 * `<name` on an ELEMENT-NAME boundary in an already-lowercased document, so
 * `keyword` cannot also match `keyword-collection` and `audio-source` cannot also
 * match `audio-role-source`. The older construct scan above is a plain substring
 * test and is deliberately left that way, so this is not a replacement for it —
 * it is what makes a longer list safe to add.
 */
function containsElementName(lowered: string, name: string): boolean {
  return new RegExp(`<${name.toLowerCase()}(?=[\\s/>])`).test(lowered);
}

/**
 * Read the upstream constant-speed map. The model has one speed scalar, so a
 * faithful import requires exactly two linear points and a strictly positive
 * constant source/output slope. Anything else is reported instead of being
 * mistaken for normal-speed playback.
 */
function timeMapSpeed(
  tag: string,
  label: string,
  unsupported: string[],
): number | undefined {
  if (!hasTimeMapElement(tag)) return undefined;
  const openingCount = (tag.match(/<timeMap\b/g) ?? []).length;
  const blocks = tag.match(/<timeMap\b[^>]*(?:\/>|>[\s\S]*?<\/timeMap>)/g) ?? [];
  if (openingCount !== 1 || blocks.length !== 1) {
    reportTimeMap(label, 'could not be parsed as one complete timeMap', unsupported);
    return undefined;
  }

  const block = blocks[0]!;
  if (attr(block, 'frameSampling') !== 'floor') {
    reportTimeMap(label, 'frameSampling must be "floor"', unsupported);
    return undefined;
  }

  const pointTags = block.match(/<timept\b[^>]*(?:\/>|>[\s\S]*?<\/timept>)/g) ?? [];
  if (pointTags.length !== 2) {
    reportTimeMap(label, 'a constant speed needs exactly two timept children', unsupported);
    return undefined;
  }

  const points = pointTags.map((point) => {
    const timeText = attr(point, 'time');
    const valueText = attr(point, 'value');
    return {
      time: timeText === null ? null : parseFcpxmlTime(timeText),
      value: valueText === null ? null : parseFcpxmlTime(valueText),
      interp: attr(point, 'interp'),
    };
  });
  if (points.some((point) => point.time === null || point.value === null)) {
    reportTimeMap(label, 'a timept time or value is unparseable', unsupported);
    return undefined;
  }
  if (points.some((point) => point.interp !== 'linear')) {
    reportTimeMap(label, 'only linear interpolation represents a constant speed', unsupported);
    return undefined;
  }

  const first = points[0]!;
  const second = points[1]!;
  const outputSpan = second.time! - first.time!;
  const sourceSpan = second.value! - first.value!;
  if (!Number.isFinite(outputSpan) || !Number.isFinite(sourceSpan)
    || !(outputSpan > 0) || !(sourceSpan > 0) || first.value! < 0 || second.value! < 0) {
    reportTimeMap(label, 'the time points do not describe a positive source/output mapping', unsupported);
    return undefined;
  }

  const rawSpeed = sourceSpan / outputSpan;
  if (!Number.isFinite(rawSpeed) || rawSpeed <= 0) {
    reportTimeMap(label, 'the source/output slope is not a usable positive speed', unsupported);
    return undefined;
  }
  const speed = effectiveSpeed(rawSpeed);
  if (!Number.isFinite(speed) || speed <= 0) {
    reportTimeMap(label, 'the source/output slope is not a usable positive speed', unsupported);
    return undefined;
  }
  return speed;
}

/**
 * One adjust element's block: self-closing or paired. Non-greedy up to the
 * first closing tag — our supported elements never nest themselves.
 */
function adjustBlock(tag: string, name: string): string | null {
  return tag.match(new RegExp(`<${name}\\b[^>]*(?:/>|>[\\s\\S]*?</${name}>)`))?.[0] ?? null;
}

interface AdjustParam {
  name: string;
  body: string;
}

/** `<param>` children of an adjust block, with their keyframeAnimation bodies. */
function paramsIn(block: string): AdjustParam[] {
  const params: AdjustParam[] = [];
  const re = /<param\b([^>]*?)(?:\/>|>([\s\S]*?)<\/param>)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block)) !== null) {
    const name = attr(match[1]!, 'name');
    if (name) params.push({ name, body: match[2] ?? '' });
  }
  return params;
}

/**
 * FCPXML curve → our easing. Upstream writes `curve` only for linear, so the
 * default (and an explicit "smooth") is the S-curve we approximate with
 * easeInOut; "hold" and unknown curves degrade to linear and are reported.
 */
function easingFromCurve(curve: string | null): MotionEasing {
  if (curve === 'linear') return 'linear';
  if (curve === null || curve === 'smooth') return 'easeInOut';
  return 'linear';
}

interface ParsedKeyframe {
  frame: number;
  value: string;
  easing: MotionEasing;
  curve: string | null;
}

/**
 * `<keyframe>` entries of a param body on the absolute timeline: `time` is the
 * clip-relative output-axis offset upstream writes. Unusable entries are
 * skipped so one malformed keyframe cannot break the rest.
 */
function keyframesIn(body: string, clipStartFrame: number, fps: number): ParsedKeyframe[] {
  const keyframes: ParsedKeyframe[] = [];
  const re = /<keyframe\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const time = parseFcpxmlTime(attr(match[1]!, 'time') ?? '');
    const value = attr(match[1]!, 'value');
    if (time === null || value === null) continue;
    const curve = attr(match[1]!, 'curve');
    keyframes.push({
      frame: clipStartFrame + Math.round(time * fps),
      value,
      easing: easingFromCurve(curve),
      curve,
    });
  }
  return keyframes.sort((a, b) => a.frame - b.frame);
}

/**
 * `<adjust-blend amount>` keyframes → our absolute-timeline opacity track.
 * Static-only blend elements intentionally return undefined. A malformed
 * animation is reported and the static amount remains available, rather than
 * letting an untrusted XML file partially replace the clip with a bad track.
 */
function opacityKeyframesOf(
  tag: string,
  clipStartFrame: number,
  fps: number,
  label: string,
  unsupported: string[],
): MotionTrack | undefined {
  const block = adjustBlock(tag, 'adjust-blend');
  if (!block || !block.includes('<keyframeAnimation')) return undefined;
  const allParams = paramsIn(block);
  for (const param of allParams) {
    if (param.name !== 'amount' && param.body.includes('<keyframe')) {
      unsupported.push(`Asset-clip "${label}" animates opacity parameter "${param.name}"; it is not imported.`);
    }
  }
  const amountParams = allParams.filter((param) => param.name === 'amount');
  if (amountParams.length === 0) {
    unsupported.push(`Asset-clip "${label}" animates opacity, but no amount parameter was found.`);
    return undefined;
  }

  const points: MotionPoint[] = [];
  let sawKeyframe = false;
  for (const param of amountParams) {
    const keyframeTags = [...param.body.matchAll(/<keyframe\b[^>]*>/g)];
    if (keyframeTags.length === 0) continue;
    sawKeyframe = true;
    const keyframes = keyframesIn(param.body, clipStartFrame, fps);
    if (keyframes.length < keyframeTags.length) {
      unsupported.push(`Asset-clip "${label}" has a malformed opacity keyframe; it is skipped.`);
    }
    if (keyframes.length === 0) continue;

    const unsupportedCurve = keyframes.find(
      (keyframe) => keyframe.curve !== null
        && keyframe.curve !== 'linear'
        && keyframe.curve !== 'smooth',
    );
    if (unsupportedCurve) {
      unsupported.push(
        `Asset-clip "${label}" uses an unsupported "${unsupportedCurve.curve}" keyframe curve; it is read as linear.`,
      );
    }

    for (const keyframe of keyframes) {
      if (keyframe.value.trim() === '') {
        unsupported.push(`Asset-clip "${label}" has a malformed opacity keyframe; it is skipped.`);
        continue;
      }
      const value = Number(keyframe.value);
      if (!Number.isFinite(value)) {
        unsupported.push(`Asset-clip "${label}" has a malformed opacity keyframe; it is skipped.`);
        continue;
      }
      if (value < 0 || value > 1) {
        unsupported.push(`Asset-clip "${label}" has an out-of-range opacity keyframe; it is skipped.`);
        continue;
      }
      if (keyframe.frame < clipStartFrame) {
        unsupported.push(`Asset-clip "${label}" has an opacity keyframe before the clip; it is skipped.`);
        continue;
      }
      points.push({
        frame: keyframe.frame,
        value,
        ...(keyframe.easing === 'linear' ? {} : { easing: keyframe.easing }),
      });
    }
  }

  if (!sawKeyframe) {
    unsupported.push(`Asset-clip "${label}" animates opacity without readable keyframes.`);
    return undefined;
  }
  const track = sanitizeMotion(points);
  if (!track) {
    unsupported.push(`Asset-clip "${label}" has no usable opacity keyframes; the base amount is kept.`);
    return undefined;
  }
  const bounded = track.filter((point) => point.value >= 0 && point.value <= 1);
  if (bounded.length < 2) {
    unsupported.push(`Asset-clip "${label}" needs two usable opacity keyframes; the base amount is kept.`);
    return undefined;
  }
  return bounded;
}

/**
 * `<adjust-transform>` keyframes → FCPXML-native tracks. position/scale/
 * rotation are what upstream transports; other parameters, malformed values
 * and non-linear curves (which FCPXML cannot express in our model) are
 * reported so they cannot vanish silently.
 */
function transformKeyframesOf(
  tag: string,
  clipStartFrame: number,
  fps: number,
  label: string,
  unsupported: string[],
): FcpxmlTransformKeyframes | undefined {
  const block = adjustBlock(tag, 'adjust-transform');
  if (!block || !block.includes('<keyframeAnimation')) return undefined;
  const result: FcpxmlTransformKeyframes = {};
  let parsed = false;
  for (const param of paramsIn(block)) {
    if (!param.body.includes('<keyframe')) continue;
    const keyframes = keyframesIn(param.body, clipStartFrame, fps);
    if (keyframes.length === 0) continue;
    const unsupportedCurve = keyframes.find(
      (k) => k.curve !== null && k.curve !== 'linear' && k.curve !== 'smooth',
    );
    if (unsupportedCurve) {
      unsupported.push(
        `Asset-clip "${label}" uses an unsupported "${unsupportedCurve.curve}" keyframe curve; it is read as linear.`,
      );
    }
    if (param.name === 'position' || param.name === 'scale') {
      const points: FcpxmlKeyframePair[] = [];
      for (const keyframe of keyframes) {
        const pair = parsePair(keyframe.value);
        if (!pair) {
          unsupported.push(`Asset-clip "${label}" has a malformed ${param.name} keyframe; it is skipped.`);
          continue;
        }
        points.push({ frame: keyframe.frame, a: pair[0], b: pair[1], easing: keyframe.easing });
      }
      if (points.length > 0) {
        if (param.name === 'position') result.position = points;
        else result.scale = points;
        parsed = true;
      }
    } else if (param.name === 'rotation') {
      const points: FcpxmlKeyframeScalar[] = [];
      for (const keyframe of keyframes) {
        const value = Number(keyframe.value);
        if (!Number.isFinite(value)) {
          unsupported.push(`Asset-clip "${label}" has a malformed rotation keyframe; it is skipped.`);
          continue;
        }
        points.push({ frame: keyframe.frame, value, easing: keyframe.easing });
      }
      if (points.length > 0) {
        result.rotation = points;
        parsed = true;
      }
    } else {
      unsupported.push(`Asset-clip "${label}" animates "${param.name}"; that parameter is not imported.`);
    }
  }
  return parsed ? result : undefined;
}

/** Reports a keyframed adjust child we do not transport (the base value still lands). */
function reportAnimatedElement(
  tag: string,
  element: string,
  message: string,
  unsupported: string[],
): void {
  if (adjustBlock(tag, element)?.includes('<keyframeAnimation')) unsupported.push(message);
}

/** True when a keyframeAnimation lives outside the elements already handled for this clip. */
function hasUnclaimedKeyframes(tag: string, claimedElements: string[]): boolean {
  let rest = tag;
  for (const name of claimedElements) {
    const block = adjustBlock(tag, name);
    if (block) rest = rest.replace(block, '');
  }
  return rest.includes('<keyframeAnimation');
}

function extractTagBlock(xml: string, tagName: string): string[] {
  // Non-greedy up to the closing tag; our supported elements never nest
  // themselves, and <title>'s inner <text> tags don't collide with its name.
  const re = new RegExp(`<${tagName}\\b[^>]*(?:/>|>[\\s\\S]*?</${tagName}>)`, 'g');
  return xml.match(re) ?? [];
}

const TITLE_STYLE_RE = /<text-style-def\b[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/text-style-def>/g;

function titleStyleOf(defBody: string): {
  fontFamily?: string;
  fontSizePx?: number;
  colorHex?: string;
  alignment?: 'left' | 'center' | 'right';
} {
  const styleTag = defBody.match(/<text-style\b[^>]*/)?.[0] ?? '';
  return {
    fontFamily: attr(styleTag, 'font') ?? undefined,
    fontSizePx: numAttr(styleTag, 'fontSize') ?? undefined,
    colorHex: attr(styleTag, 'fontColor')?.toUpperCase() ?? undefined,
    alignment: (attr(styleTag, 'alignment')?.toLowerCase() as 'left' | 'center' | 'right' | undefined)
      ?? undefined,
  };
}

function parseAssetClipTag(
  tag: string,
  label: string,
  lane: number,
  startFrame: number,
  durationFrames: number,
  startSec: number,
  fps: number,
  assetByRef: ReadonlyMap<string, ImportedAsset>,
  unsupported: string[],
): ImportedClip | null {
  const ref = attr(tag, 'ref');
  const asset = ref ? assetByRef.get(ref) : undefined;
  if (!asset) {
    unsupported.push(`Asset-clip "${label}" references unknown resource ${ref ?? '(none)'}.`);
    return null;
  }
  const timeMapPresent = hasTimeMapElement(tag);
  const isAudioOnly = asset.hasAudio && !asset.hasVideo;
  const speed = timeMapPresent && !isAudioOnly
    ? timeMapSpeed(tag, label, unsupported)
    : undefined;
  if (speed !== undefined && lane < 0) {
    // A negative lane is an audio lane, and an element there is the exporter's
    // redundant audio half of a linked A/V group, which both materializers DROP
    // so the visual element can rebuild the pair (apply.ts `isLinkedAudioHalf`).
    // The speed parses cleanly and lands in the plan, then goes out with the
    // element — so say so instead of dropping it silently. Deliberately NOT
    // honoured: both halves of a group hold ONE source window because
    // `setClipSpeed` writes the speed and the scaled outPoint onto every linked
    // partner, so a divergent audio-half retime is a second authority the model
    // cannot express, and the group already takes its speed from the visual half.
    reportTimeMap(
      label,
      'a linked group takes its speed from its visual element, so an audio-lane timeMap is ignored',
      unsupported,
    );
  }
  const sourceInFrame = speed === undefined
    ? Math.round(startSec * fps)
    : Math.max(0, Math.round(startSec * fps * effectiveSpeed(speed)));
  const base = { lane, startFrame, durationFrames, sourceInFrame };
  reportUnrepresentedAttributes(tag, 'Asset-clip', label, unsupported);
  if (isAudioOnly) {
    if (timeMapPresent) {
      reportTimeMap(label, 'constant speed is visual-only and is not imported', unsupported);
    }
    reportAnimatedElement(tag, 'adjust-volume',
      `Audio-clip "${label}" animates volume; keyframed volume is not transported (static level kept).`,
      unsupported);
    return { kind: 'audio', ...base, assetPath: asset.path, label, ...volumeOf(tag) };
  }

  const opacity = blendOf(tag);
  const opacityTrack = opacityKeyframesOf(tag, startFrame, fps, label, unsupported);
  // Owns the whole <adjust-crop> block, including its mode refusal and its
  // keyframe report: see cropTrimOf for why the note cannot live out here.
  const cropTrim = cropTrimOf(tag, 'Asset-clip', label, unsupported);
  const transform = transformOf(tag);
  const transformKeyframes = transformKeyframesOf(tag, startFrame, fps, label, unsupported);
  reportAnimatedElement(tag, 'adjust-volume',
    `Asset-clip "${label}" animates volume; keyframed volume is not transported (static level kept).`,
    unsupported);
  const clip: ImportedClip = {
    kind: 'video',
    ...base,
    assetPath: asset.path,
    label,
    ...(speed !== undefined ? { speed } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
    ...(opacityTrack ? { opacityTrack } : {}),
    ...volumeOf(tag),
    ...(cropTrim ? { cropTrim } : {}),
    ...(transform ? { transform } : {}),
    ...(transformKeyframes ? { transformKeyframes } : {}),
  };
  if (hasUnclaimedKeyframes(tag, ['adjust-transform', 'adjust-blend', 'adjust-volume', 'adjust-crop'])) {
    unsupported.push(`Asset-clip "${label}" animates a parameter; keyframes are not imported.`);
  }
  return clip;
}

function parseTitleTag(
  tag: string,
  label: string,
  lane: number,
  startFrame: number,
  durationFrames: number,
  stylesById: ReadonlyMap<string, ReturnType<typeof titleStyleOf>>,
  unsupported: string[],
): ImportedTitle {
  if (hasTimeMapElement(tag)) {
    reportTimeMap(label, 'constant speed is not imported for titles', unsupported);
  }
  reportUnrepresentedAttributes(tag, 'Title', label, unsupported);
  const styleRef = attr(tag, 'ref') ?? '';
  const style = stylesById.get(styleRef);
  const text = tag.match(/<text-style[^>]*>([\s\S]*?)<\/text-style>/)?.[1]
    ?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    ?? '';
  const opacity = blendOf(tag);
  const transform = transformOf(tag);
  if (tag.includes('<keyframeAnimation')) {
    unsupported.push(`Title "${label}" animates a parameter; title keyframes are not imported.`);
  }
  return {
    kind: 'title',
    lane,
    startFrame,
    durationFrames,
    text,
    ...(opacity !== undefined ? { opacity } : {}),
    ...(transform ? { transform } : {}),
    ...style,
  };
}

function reportSpineElement(kind: string, tag: string, unsupported: string[], context = 'Spine'): void {
  const elementName = attr(tag, 'name');
  unsupported.push(elementName
    ? `${context} element "<${kind}>" "${elementName}" is not imported; it is skipped.`
    : `${context} element "<${kind}>" is not imported; it is skipped.`);
}

function sanitizeSequenceName(value: string | null): string {
  const cleaned = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, COMPOUND_NAME_MAX_LENGTH) || 'Nested sequence';
}

/**
 * Sequence bodies from the exporter live inside one timeline gap. Peel that
 * wrapper once, while leaving ordinary gaps in the spine to retain the legacy
 * "absolute offsets encode spacing" behavior.
 */
function sequenceSpineBody(sequenceTag: string): string | null {
  const spine = extractTagBlock(sequenceTag, 'spine')[0];
  if (!spine) return null;
  let body = spine.slice(spine.indexOf('>') + 1);
  const first = body.match(/<([A-Za-z][\w-]*)\b[^>]*>/);
  if (first?.[1] !== 'gap') return body;
  const gap = extractTagBlock(body, 'gap')[0];
  const close = '</gap>';
  if (!gap?.endsWith(close)) return body;
  return gap.slice(gap.indexOf('>') + 1, -close.length);
}

export function parseFcpxml(xml: string): ParsedFcpxml {
  const unsupported: string[] = [];

  // ── Project canvas ──────────────────────────────────────────────────────
  const formatTag = extractTagBlock(xml, 'format')[0] ?? '';
  const frameDuration = attr(formatTag, 'frameDuration');
  const frameDurationSec = frameDuration ? parseFcpxmlTime(frameDuration) : null;
  let fps: number | null = null;
  if (frameDurationSec && frameDurationSec > 0) {
    const exact = 1 / frameDurationSec;
    const rounded = Math.round(exact);
    fps = Math.abs(exact - rounded) < 0.01 ? rounded : Math.round(exact * 1000) / 1000;
  }
  const width = numAttr(formatTag, 'width') ?? 1920;
  const height = numAttr(formatTag, 'height') ?? 1080;
  const fpsForFrames = fps;

  const eventName = attr(extractTagBlock(xml, 'event')[0] ?? '', 'name');

  // ── Assets ──────────────────────────────────────────────────────────────
  const assets: ImportedAsset[] = [];
  for (const tag of extractTagBlock(xml, 'asset')) {
    const ref = attr(tag, 'id');
    const src = attr(tag, 'src');
    if (!ref || !src) continue;
    // A <timecode> child carries the source start offset; rebuild the SMPTE
    // string at the project rate so the asset round-trips through export.
    const timecodeTag = tag.match(/<timecode\b[^>]*/)?.[0] ?? '';
    const startSeconds = timecodeTag
      ? parseFcpxmlTime(attr(timecodeTag, 'start') ?? '')
      : null;
    const startTimecode = startSeconds !== null && fps
      ? secondsToTimecode(startSeconds, fps) ?? undefined
      : undefined;
    reportUnrepresentedAssetAttributes(tag, ref, unsupported);
    assets.push({
      ref,
      path: fileUrlToPath(src),
      hasVideo: attr(tag, 'hasVideo') === '1',
      hasAudio: attr(tag, 'hasAudio') === '1',
      durationSec: parseFcpxmlTime(attr(tag, 'duration') ?? '') ?? 0,
      ...(startTimecode !== undefined ? { startTimecode } : {}),
    });
  }
  const assetByRef = new Map(assets.map((a) => [a.ref, a]));

  // ── Title styles ────────────────────────────────────────────────────────
  const stylesById = new Map<string, ReturnType<typeof titleStyleOf>>();
  for (const match of xml.matchAll(TITLE_STYLE_RE)) {
    stylesById.set(match[1], titleStyleOf(match[2]));
  }

  interface SequenceResource {
    ref: string;
    name: string;
    durationFrames: number;
    sequenceTag: string;
  }

  interface SequenceNode extends ImportedSequence {
    childRefs: string[];
  }

  const sequenceResources = new Map<string, SequenceResource | null>();
  const resourceIssues = new Map<string, string>();
  for (const mediaTag of extractTagBlock(xml, 'media')) {
    const ref = sanitizeCompoundTimelineId(attr(mediaTag, 'id'));
    if (ref === undefined) continue;
    if (sequenceResources.has(ref) || resourceIssues.has(ref)) {
      sequenceResources.set(ref, null);
      resourceIssues.set(ref, `Sequence resource "${ref}" is defined more than once.`);
      continue;
    }
    const sequenceTag = extractTagBlock(mediaTag, 'sequence')[0];
    if (!sequenceTag) {
      sequenceResources.set(ref, null);
      resourceIssues.set(ref, `Media resource "${ref}" does not contain a sequence.`);
      continue;
    }
    const duration = parseFcpxmlTime(attr(sequenceTag, 'duration') ?? '');
    const durationFrames = duration === null || !fpsForFrames
      ? null
      : asValidFrame(Math.round(duration * fpsForFrames));
    if (durationFrames === null || durationFrames <= 0) {
      sequenceResources.set(ref, null);
      resourceIssues.set(ref, `Sequence resource "${ref}" has no usable duration.`);
      continue;
    }
    sequenceResources.set(ref, {
      ref,
      name: sanitizeSequenceName(attr(mediaTag, 'name')),
      durationFrames,
      sequenceTag,
    });
  }

  const sequenceMemo = new Map<string, SequenceNode | null>();
  const sequenceNodesByRef = new Map<string, SequenceNode>();
  const sequencePath: string[] = [];
  const reportedSequenceIssues = new Set<string>();

  const reportSequenceIssue = (key: string, message: string): void => {
    if (reportedSequenceIssues.has(key)) return;
    reportedSequenceIssues.add(key);
    unsupported.push(message);
  };

  function parseCompoundClipTag(
    tag: string,
    label: string,
    lane: number,
    startFrame: number,
    durationFrames: number,
    startSec: number,
    fps: number,
    depth: number,
  ): ImportedCompoundClip | null {
    const ref = sanitizeCompoundTimelineId(attr(tag, 'ref'));
    if (ref === undefined) {
      reportSequenceIssue(
        `missing:${label}`,
        `Ref-clip "${label}" has no usable sequence resource reference.`,
      );
      return null;
    }
    const sequence = sequenceAtDepth(ref, depth, label);
    if (!sequence) return null;

    const sourceInFrame = asValidFrame(Math.round(startSec * fps));
    if (
      asValidFrame(startFrame) === null
      || sourceInFrame === null
      || durationFrames <= 0
      || sourceInFrame + durationFrames > sequence.durationFrames
    ) {
      reportSequenceIssue(
        `window:${ref}:${label}`,
        `Ref-clip "${label}" has an unusable source window in sequence resource "${ref}".`,
      );
      return null;
    }
    if (hasTimeMapElement(tag)) {
      reportTimeMap(label, 'constant speed is not imported for compound clips', unsupported);
    }
    reportUnrepresentedAttributes(tag, 'Ref-clip', label, unsupported);

    const opacity = blendOf(tag);
    const opacityTrack = opacityKeyframesOf(tag, startFrame, fps, label, unsupported);
    const cropTrim = cropTrimOf(tag, 'Ref-clip', label, unsupported);
    const transform = transformOf(tag);
    const transformKeyframes = transformKeyframesOf(tag, startFrame, fps, label, unsupported);
    reportAnimatedElement(tag, 'adjust-volume',
      `Ref-clip "${label}" animates volume; keyframed volume is not transported (static level kept).`,
      unsupported);
    if (hasUnclaimedKeyframes(tag, ['adjust-transform', 'adjust-blend', 'adjust-volume', 'adjust-crop'])) {
      unsupported.push(`Ref-clip "${label}" animates a parameter; keyframes are not imported.`);
    }
    return {
      kind: 'video',
      lane,
      startFrame,
      durationFrames,
      sourceInFrame,
      assetPath: '',
      label,
      compoundSequenceRef: ref,
      ...(opacity !== undefined ? { opacity } : {}),
      ...(opacityTrack ? { opacityTrack } : {}),
      ...volumeOf(tag),
      ...(cropTrim ? { cropTrim } : {}),
      ...(transform ? { transform } : {}),
      ...(transformKeyframes ? { transformKeyframes } : {}),
    };
  }

  function parseSequenceSpine(
    body: string,
    depth: number,
    sequenceRef: string,
  ): { clips: ImportedClip[]; childRefs: string[] } | null {
    const parsedClips: ImportedClip[] = [];
    const childRefs: string[] = [];
    let valid = true;
    const openRe = /<([A-Za-z][\w-]*)\b([^>]*?)(\/?)>/g;
    let match: RegExpExecArray | null;
    while ((match = openRe.exec(body)) !== null) {
      const kind = match[1];
      const selfClosed = match[3] === '/';
      let tag = match[0];
      if (!selfClosed) {
        const closeTag = `</${kind}>`;
        const closeIdx = body.indexOf(closeTag, openRe.lastIndex);
        if (closeIdx !== -1) {
          tag = body.slice(match.index, closeIdx + closeTag.length);
          openRe.lastIndex = closeIdx + closeTag.length;
        }
      }
      if (kind === 'gap') continue;
      if (kind !== 'asset-clip' && kind !== 'video' && kind !== 'title' && kind !== 'ref-clip') {
        reportSpineElement(kind, tag, unsupported, 'Sequence');
        continue;
      }
      if (!fpsForFrames) {
        valid = false;
        continue;
      }
      const offset = parseFcpxmlTime(attr(tag, 'offset') ?? '');
      const duration = parseFcpxmlTime(attr(tag, 'duration') ?? '');
      const offsetFrame = offset === null ? null : asValidFrame(Math.round(offset * fpsForFrames));
      const durationFrames = duration === null
        ? null
        : asValidFrame(Math.round(duration * fpsForFrames));
      const label = attr(tag, 'name') ?? '';
      if (offsetFrame === null || durationFrames === null || durationFrames <= 0) {
        reportSequenceIssue(
          `timing:${sequenceRef}:${label}`,
          `Sequence element "${label}" in "${sequenceRef}" has invalid timing; the sequence is refused.`,
        );
        valid = false;
        continue;
      }
      const lane = numAttr(tag, 'lane') ?? 0;
      const startSec = parseFcpxmlTime(attr(tag, 'start') ?? '') ?? 0;
      if (kind === 'asset-clip' || kind === 'video') {
        const clip = parseAssetClipTag(
          tag,
          label,
          lane,
          offsetFrame,
          durationFrames,
          startSec,
          fpsForFrames,
          assetByRef,
          unsupported,
        );
        if (!clip) {
          valid = false;
          continue;
        }
        parsedClips.push(clip);
        continue;
      }
      if (kind === 'title') {
        parsedClips.push(parseTitleTag(
          tag,
          label,
          lane,
          offsetFrame,
          durationFrames,
          stylesById,
          unsupported,
        ));
        continue;
      }
      const clip = parseCompoundClipTag(
        tag,
        label,
        lane,
        offsetFrame,
        durationFrames,
        startSec,
        fpsForFrames,
        depth + 1,
      );
      if (!clip) {
        valid = false;
        continue;
      }
      parsedClips.push(clip);
      childRefs.push(clip.compoundSequenceRef);
    }
    if (parsedClips.length === 0) {
      reportSequenceIssue(
        `empty:${sequenceRef}`,
        `Sequence resource "${sequenceRef}" has no importable clips; the sequence is refused.`,
      );
      valid = false;
    }
    return valid ? { clips: parsedClips, childRefs } : null;
  }

  function sequenceAtDepth(rawRef: string, depth: number, requesterLabel: string): SequenceNode | null {
    const ref = sanitizeCompoundTimelineId(rawRef);
    if (ref === undefined) return null;
    if (depth > MAX_COMPOUND_DEPTH) {
      reportSequenceIssue(
        `depth:${ref}:${depth}`,
        `Ref-clip "${requesterLabel}" exceeds the maximum nested depth of ${MAX_COMPOUND_DEPTH}; it is skipped.`,
      );
      sequenceMemo.set(JSON.stringify([depth, ref]), null);
      return null;
    }
    const memoKey = JSON.stringify([depth, ref]);
    const memoized = sequenceMemo.get(memoKey);
    if (memoized !== undefined) return memoized;
    if (sequencePath.includes(ref)) {
      reportSequenceIssue(
        `cycle:${[...sequencePath, ref].join('>')}`,
        `Nested sequence cycle refused: ${[...sequencePath, ref].map((entry) => `"${entry}"`).join(' -> ')} contains itself.`,
      );
      sequenceMemo.set(memoKey, null);
      return null;
    }
    const resource = sequenceResources.get(ref);
    if (!resource) {
      const detail = resourceIssues.get(ref);
      reportSequenceIssue(
        `resource:${ref}:${depth}:${requesterLabel}`,
        detail
          ? `Ref-clip "${requesterLabel}" cannot use sequence resource "${ref}": ${detail}`
          : `Ref-clip "${requesterLabel}" references unknown sequence resource "${ref}".`,
      );
      sequenceMemo.set(memoKey, null);
      return null;
    }
    const body = sequenceSpineBody(resource.sequenceTag);
    if (body === null) {
      reportSequenceIssue(
        `spine:${ref}`,
        `Sequence resource "${ref}" has no usable spine; the sequence is refused.`,
      );
      sequenceMemo.set(memoKey, null);
      return null;
    }
    sequencePath.push(ref);
    const parsed = parseSequenceSpine(body, depth, ref);
    sequencePath.pop();
    if (!parsed) {
      sequenceMemo.set(memoKey, null);
      return null;
    }
    const node: SequenceNode = { ...resource, clips: parsed.clips, childRefs: parsed.childRefs };
    sequenceMemo.set(memoKey, node);
    sequenceNodesByRef.set(ref, node);
    return node;
  }

  const sequences: ImportedSequence[] = [];
  const includedSequenceRefs = new Set<string>();
  function includeSequence(rawRef: string): void {
    const ref = sanitizeCompoundTimelineId(rawRef);
    if (ref === undefined || includedSequenceRefs.has(ref)) return;
    const sequence = sequenceNodesByRef.get(ref);
    if (!sequence) return;
    includedSequenceRefs.add(ref);
    sequences.push({
      ref: sequence.ref,
      name: sequence.name,
      durationFrames: sequence.durationFrames,
      clips: sequence.clips,
    });
    for (const childRef of sequence.childRefs) includeSequence(childRef);
  }

  // ── Spine children ──────────────────────────────────────────────────────
  const projectTags = extractTagBlock(xml, 'project');
  const rootProject = [...projectTags].reverse().find((tag) => extractTagBlock(tag, 'spine')[0]);
  const spineXml = rootProject
    ? extractTagBlock(rootProject, 'spine')[0]!
    : extractTagBlock(xml, 'spine').at(-1) ?? '';
  const clips: ImportedClip[] = [];

  // Titles carry a body (<text>…), so scan opening tags and consume through
  // each element's closing tag rather than matching self-contained tokens.
  // Skip the outer spine's own opening tag so it is not mistaken for nested.
  const innerXml = spineXml.slice(spineXml.indexOf('>') + 1);
  const openRe = /<([A-Za-z][\w-]*)\b([^>]*?)(\/?)>/g;
  // Explicit exec loop, not matchAll: matchAll clones the regex, so reading
  // lastIndex inside the loop would always see 0 and every non-self-closed
  // element after the first would consume from the document start instead of
  // from its own opening tag.
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(innerXml)) !== null) {
    const kind = match[1];
    const selfClosed = match[3] === '/';
    let tag = match[0];
    if (!selfClosed) {
      const closeTag = `</${kind}>`;
      const closeIdx = innerXml.indexOf(closeTag, openRe.lastIndex);
      if (closeIdx !== -1) {
        tag = innerXml.slice(match.index, closeIdx + closeTag.length);
        // Continue after the consumed element so a nested lookalike cannot
        // resync the scan into the middle of this element's children.
        openRe.lastIndex = closeIdx + closeTag.length;
      }
    }

    if (kind === 'gap') continue; // absolute clip offsets already encode spacing
    if (kind !== 'asset-clip' && kind !== 'video' && kind !== 'title' && kind !== 'ref-clip' && kind !== 'spine') {
      reportSpineElement(kind, tag, unsupported);
      continue;
    }
    const offset = parseFcpxmlTime(attr(tag, 'offset') ?? '');
    const duration = parseFcpxmlTime(attr(tag, 'duration') ?? '');
    if (offset === null || duration === null || !fpsForFrames) {
      if (kind === 'ref-clip') {
        reportSequenceIssue(
          `root-timing:${attr(tag, 'name') ?? ''}`,
          `Ref-clip "${attr(tag, 'name') ?? ''}" has invalid timing; it is skipped.`,
        );
      }
      continue;
    }

    const lane = numAttr(tag, 'lane') ?? 0;
    const startSec = parseFcpxmlTime(attr(tag, 'start') ?? '') ?? 0;
    const label = attr(tag, 'name') ?? '';
    const startFrame = Math.round(offset * fpsForFrames);
    const durationFrames = Math.max(1, Math.round(duration * fpsForFrames));

    if (kind === 'ref-clip') {
      const compoundDuration = asValidFrame(Math.round(duration * fpsForFrames));
      if (compoundDuration === null || compoundDuration <= 0) {
        reportSequenceIssue(
          `root-duration:${label}`,
          `Ref-clip "${label}" has an unusable duration; it is skipped.`,
        );
        continue;
      }
      const compound = parseCompoundClipTag(
        tag,
        label,
        lane,
        startFrame,
        compoundDuration,
        startSec,
        fpsForFrames,
        1,
      );
      if (!compound) continue;
      clips.push(compound);
      includeSequence(compound.compoundSequenceRef);
      continue;
    }
    if (kind === 'asset-clip' || kind === 'video') {
      const clip = parseAssetClipTag(
        tag,
        label,
        lane,
        startFrame,
        durationFrames,
        startSec,
        fpsForFrames,
        assetByRef,
        unsupported,
      );
      if (clip) clips.push(clip);
      continue;
    }
    if (kind === 'title') {
      clips.push(parseTitleTag(
        tag,
        label,
        lane,
        startFrame,
        durationFrames,
        stylesById,
        unsupported,
      ));
      continue;
    }

    unsupported.push('Nested spines are flattened without their group transforms.');
  }

  // Nested <role>, <marker>, effect refs etc. anywhere in the doc.
  // <effect> children (color effects, third-party filters) have no
  // representation here; grades and blend modes land here too. Shape-ish
  // constructs (generators, shapes, graphics) have no Windows analogue and
  // are reported the same way.
  for (const construct of ['<effect-ref', '<effect ', '<filter-video', '<filter-audio', '<note>', '<chapter-marker', '<generator', '<shape', '<graphic']) {
    if (xml.includes(construct)) {
      unsupported.push(`${construct.replace(/[<>=]/g, '')} elements are skipped.`);
    }
  }

  // The elements read for nothing, once per document each. Its own loop because
  // the match is on an element-name boundary, which the construct list above is
  // not and deliberately was not made — that list's plain substring test is what
  // already covers `<filter-video-mask>` via `'<filter-video'`, and narrowing it
  // would un-report that element rather than tidy it.
  const loweredXml = xml.toLowerCase();
  for (const element of UNREPRESENTED_ELEMENTS) {
    if (containsElementName(loweredXml, element)) {
      unsupported.push(`${element} elements are skipped.`);
    }
  }

  if (!fpsForFrames) {
    // Not an approximation: every spine child needs a rate to turn its offset
    // and duration into frames and is dropped above, so say that.
    unsupported.push('No usable <format frameDuration>; spine timing cannot be mapped to frames, so no clip is imported.');
  }

  return {
    name: eventName ?? 'Imported Project',
    fps: fpsForFrames,
    width,
    height,
    assets,
    clips,
    ...(sequences.length > 0 ? { sequences } : {}),
    unsupported,
  };
}




