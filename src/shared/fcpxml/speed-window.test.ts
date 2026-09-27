/**
 * The imported SOURCE WINDOW, across the whole speed x in-point x length cross
 * product (#154 speed audit).
 *
 * Three things are pinned here, and they are deliberately different claims:
 *
 *  1. The end state equals the source project window, for every variant.
 *  2. The end state is BYTE-IDENTICAL to the arithmetic this change replaced,
 *     copied verbatim below. So the fix is behaviour-preserving where a user can
 *     see it — which is the point of running it against a copy of the old code
 *     rather than against an expectation.
 *  3. The INTERMEDIATE — the state one undo back, which is the trim own output before
 *     the adjustment batch — now carries the plan source window. This is the part
 *     that changed, and it is the defect: the old span was a TIMELINE length added
 *     to a SOURCE position, correct only at 1x and rescued by a later patch.
 */
import { describe, it, expect } from 'vitest';
import { EditorController } from '../editor/controller';
import { effectiveSpeed } from '../media/source-time';
import { exportFcpxml } from './exporter';
import { parseFcpxml } from './importer';
import { applyFcpxmlPlan } from './apply';

const MEDIA_PATH = 'X:/media/window.mp4';
const DIMS = new Map([[MEDIA_PATH, { width: 1920, height: 1080 }]]);

interface Opts { speed?: number; inPoint: number; durationFrames: number }

function sourceEditor(o: Opts) {
  const editor = new EditorController();
  editor.addMedia({
    id: 'source', path: MEDIA_PATH, filename: 'window.mp4', type: 'video',
    duration: 900, width: 1920, height: 1080, fileSize: 1, addedAt: '',
  });
  const id = editor.addClip({
    assetId: 'source', trackId: 'v1', startFrame: 0, durationFrames: o.durationFrames,
  });
  if (o.inPoint !== 0) editor.trimClip(id, o.inPoint, o.inPoint + o.durationFrames);
  if (o.speed !== undefined) editor.setClipSpeed(id, o.speed);
  return editor;
}

function targetEditor() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'imported', path: MEDIA_PATH, filename: 'window.mp4', type: 'video',
    duration: 900, width: 1920, height: 1080, fileSize: 1, addedAt: '',
  });
  return editor;
}

interface Window { inPoint: number; outPoint: number; durationFrames: number; speed: number | undefined }
const fmt = (w: Window) => `{in=${w.inPoint},out=${w.outPoint},len=${w.durationFrames},speed=${String(w.speed)}}`;

function imported(o: Opts): { final: Window; afterOneUndo: Window | null } {
  const plan = parseFcpxml(exportFcpxml(sourceEditor(o).getProject()));
  const target = targetEditor();
  applyFcpxmlPlan(target, plan, new Map([[MEDIA_PATH, 'imported']]), DIMS);
  const find = () => target.getClips().find((x) => x.assetId === 'imported');
  const read = (): Window => {
    const c = find();
    if (!c) throw new Error('no clip placed');
    return { inPoint: c.inPoint, outPoint: c.outPoint, durationFrames: c.durationFrames, speed: c.speed };
  };
  const final = read();
  // One undo. Where the clip had NEITHER a trim nor an adjustment batch this
  // removes the placement itself, so there is no intermediate to read.
  target.undo();
  const mid = find();
  return {
    final,
    afterOneUndo: mid
      ? { inPoint: mid.inPoint, outPoint: mid.outPoint, durationFrames: mid.durationFrames, speed: mid.speed }
      : null,
  };
}

/**
 * The pre-fix arithmetic, VERBATIM, on the public primitives in the order
 * apply.ts shipped: `trimClip(sourceIn, sourceIn + durationFrames)` — a TIMELINE
 * length added to a SOURCE position — then the speed patch as it was before this
 * change (speed and outPoint only, no length).
 *
 * `speed` comes from the PLAN, so a 1x document supplies `undefined` exactly as
 * in the real path: a linear timeMap at 1x is never emitted.
 */
function preFix(o: Opts): Window {
  const editor = targetEditor();
  const id = editor.addClip({
    assetId: 'imported', trackId: 'v1', startFrame: 0, durationFrames: o.durationFrames,
  });
  if (o.inPoint !== 0) editor.trimClip(id, o.inPoint, o.inPoint + o.durationFrames);
  // The PLAN's speed, not the caller's: a linear timeMap at exactly 1x is never
  // emitted, so a 1x document reaches the applier as "no speed" and takes the
  // unscaled path. Forcing `1` here would invent a batch the real import has not
  // got, and compare two different imports.
  const planSpeed = o.speed === 1 ? undefined : o.speed;
  if (planSpeed !== undefined) {
    const s = effectiveSpeed(planSpeed);
    editor.applyClipProperties([id], 'pre-fix speed', (d) => {
      d.speed = s;
      d.outPoint = d.inPoint + Math.round(d.durationFrames * s);
      return true;
    });
  }
  const c = editor.getClips().find((x) => x.id === id)!;
  return { inPoint: c.inPoint, outPoint: c.outPoint, durationFrames: c.durationFrames, speed: c.speed };
}

const SPEEDS: (number | undefined)[] = [undefined, 0.5, 1, 1.5, 2, 3];
const IN_POINTS = [0, 1, 15, 37];
const DURATIONS = [1, 7, 30, 90];
const CELLS: Opts[] = SPEEDS.flatMap((speed) => IN_POINTS.flatMap((inPoint) => DURATIONS.map((durationFrames) => ({ speed, inPoint, durationFrames }))));
const TRIMMED = CELLS.filter((c) => c.inPoint !== 0);

describe('the imported source window (#154 speed audit)', () => {
  it('matches the source project window across the full cross product', () => {
    const bad: string[] = [];
    for (const c of CELLS) {
      const src = sourceEditor(c).getClips().find((x) => x.assetId === 'source')!;
      const got = imported(c).final;
      const wantSpeed = c.speed === 1 ? undefined : c.speed;
      if (got.inPoint !== src.inPoint || got.outPoint !== src.outPoint
        || got.durationFrames !== src.durationFrames || got.speed !== wantSpeed) {
        bad.push(`speed=${String(c.speed)} in=${c.inPoint} dur=${c.durationFrames} src=${fmt({ inPoint: src.inPoint, outPoint: src.outPoint, durationFrames: src.durationFrames, speed: src.speed })} got=${fmt(got)}`);
      }
    }
    expect(bad, `end state differed from the source project:\n${bad.join('\n')}`).toEqual([]);
  });

  it('is byte-identical to the VERBATIM pre-fix arithmetic, at every speed', () => {
    const rows: string[] = [];
    let differed = 0;
    for (const c of CELLS) {
      const fixed = imported(c).final;
      const pre = preFix(c);
      if (JSON.stringify(fixed) !== JSON.stringify(pre)) {
        differed++;
        rows.push(`  speed=${String(c.speed)} in=${c.inPoint} dur=${c.durationFrames} fixed=${fmt(fixed)} pre=${fmt(pre)}`);
      }
    }
    expect(differed, `end state differed from the verbatim pre-fix arithmetic:\n${rows.join('\n')}`).toBe(0);
  });

  it('leaves the INTERMEDIATE carrying the plan own source window', () => {
    // The part that DID change, and it is the defect. One undo puts the clip back
    // on the trim's own state, before the adjustment batch runs.
    //
    // The pre-fix intermediate was SELF-CONSISTENT — at trim time the speed is
    // still 1, so `out - in === duration` held — which is exactly why the bug hid.
    // What it was not was the plan's window: it carried `sourceIn + durationFrames`
    // where the plan names `sourceIn + round(durationFrames * speed)`. So the
    // assertion is against the PLAN, not against the model invariant.
    // Only cells where an adjustment BATCH exists, because that is the only case
    // with an intermediate to observe: at unit speed there is no speed patch, the
    // trim is the LAST command, and one undo reverts the trim itself rather than
    // the batch. At unit speed the trim's own output IS the final state, which the
    // first test already pins.
    const batched = TRIMMED.filter((c) => c.speed !== undefined && c.speed !== 1);
    const after: string[] = [];
    const before: string[] = [];
    for (const c of batched) {
      const wantOut = c.inPoint + Math.round(c.durationFrames * effectiveSpeed(c.speed));

      const mid = imported(c).afterOneUndo!;
      if (mid.outPoint !== wantOut) {
        after.push(`speed=${String(c.speed)} in=${c.inPoint} dur=${c.durationFrames} out=${mid.outPoint} want ${wantOut}`);
      }

      const editor = targetEditor();
      const id = editor.addClip({ assetId: 'imported', trackId: 'v1', startFrame: 0, durationFrames: c.durationFrames });
      editor.trimClip(id, c.inPoint, c.inPoint + c.durationFrames);
      const pre = editor.getClips().find((x) => x.id === id)!;
      if (pre.outPoint !== wantOut) {
        before.push(`speed=${String(c.speed)} in=${c.inPoint} dur=${c.durationFrames} out=${pre.outPoint} want ${wantOut}`);
      }
    }
    expect(after, `intermediate did not carry the plan's window:\n${after.join('\n')}`).toEqual([]);
    // The contrast must be real or the test is vacuous.
    expect(before.length).toBeGreaterThan(0);
  });
});
