/**
 * Title FCPXML parity (upstream #154/#289).
 *
 * The title path uses the same geometry/opacity helpers as media clips, while
 * the platform-specific Basic Title effect resource and compound resources
 * remain explicitly reported rather than guessed.
 */
import { describe, expect, it } from 'vitest';
import { EditorController } from '../editor/controller';
import { applyFcpxmlPlan } from './apply';
import { exportFcpxml, exportFcpxmlWithReport } from './exporter';
import { parseFcpxml, type ImportedTitle } from './importer';

function titleEditor(patch: Record<string, unknown> = {}): { editor: EditorController; clipId: string } {
  const editor = new EditorController();
  const clipId = editor.addTitleClip({
    trackId: 'v1',
    text: 'Title',
    startFrame: 0,
    durationFrames: 60,
  });
  if (Object.keys(patch).length > 0) {
    editor.applyClipProperties([clipId], 'Title fixture', (draft) => {
      Object.assign(draft, patch);
      return true;
    });
  }
  return { editor, clipId };
}

function titleTag(xml: string): string {
  const tag = xml.match(/<title\b[\s\S]*?<\/title>/)?.[0];
  if (!tag) throw new Error('expected a title element');
  return tag;
}

function importedTitle(xml: string): ImportedTitle {
  const title = parseFcpxml(xml).clips.find((clip): clip is ImportedTitle => clip.kind === 'title');
  if (!title) throw new Error('expected an imported title');
  return title;
}

describe('title FCPXML geometry and opacity (#154/#289)', () => {
  it('emits a shared adjust-transform only for non-identity title geometry', () => {
    const identity = titleEditor({
      x: 0, y: 0, width: 1920, height: 1080, rotation: 0,
      scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0,
    });
    const changed = titleEditor({
      x: 240, y: 160, width: 960, height: 270, rotation: 15,
      scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0,
    });

    const identityTag = titleTag(exportFcpxml(identity.editor.getProject()));
    const changedTag = titleTag(exportFcpxml(changed.editor.getProject()));

    expect(identityTag).not.toContain('<adjust-transform');
    expect(changedTag).toContain('<adjust-transform scale="0.5 0.25"');
    expect(changedTag).toMatch(/position="-?[0-9.]+ -?[0-9.]+"/);
    expect(changedTag).toContain('rotation="-15"');
  });

  it('emits adjust-blend below the upstream opacity threshold and omits it at unity', () => {
    const translucentSource = titleEditor({ opacity: 0.5 });
    const opaqueSource = titleEditor({ opacity: 1 });
    const thresholdSource = titleEditor({ opacity: 0.9995 });
    const translucent = titleTag(exportFcpxml(translucentSource.editor.getProject()));
    const opaque = titleTag(exportFcpxml(opaqueSource.editor.getProject()));
    const threshold = titleTag(exportFcpxml(thresholdSource.editor.getProject()));

    expect(translucent).toContain('<adjust-blend amount="0.5"/>');
    expect(opaque).not.toContain('<adjust-blend');
    expect(threshold).not.toContain('<adjust-blend');
  });

  it('round-trips title geometry and opacity through import and apply', () => {
    const source = titleEditor({
      x: 240, y: 160, width: 960, height: 270, rotation: 15,
      opacity: 0.5,
    });
    const first = exportFcpxml(source.editor.getProject());
    const parsed = importedTitle(first);

    expect(parsed.opacity).toBe(0.5);
    expect(parsed.transform).toMatchObject({ scaleX: 0.5, scaleY: 0.25, rotation: -15 });

    const target = new EditorController();
    const result = applyFcpxmlPlan(target, parseFcpxml(first), new Map());
    expect(result.titles).toBe(1);
    const restored = target.getClips().find((clip) => clip.type === 'title')!;

    expect(restored.opacity).toBe(0.5);
    expect(restored.x).toBeCloseTo(240, 2);
    expect(restored.y).toBeCloseTo(160, 2);
    expect(restored.width).toBeCloseTo(960, 2);
    expect(restored.height).toBeCloseTo(270, 2);
    expect(restored.rotation).toBeCloseTo(15, 2);
    expect(restored.scaleX).toBe(1);
    expect(restored.scaleY).toBe(1);

    expect(exportFcpxml(target.getProject())).toBe(first);
  });

  it('applies title geometry and opacity in one adjustment undo step', () => {
    const source = titleEditor({
      x: 240, y: 160, width: 960, height: 270, rotation: 15,
      opacity: 0.5,
    });
    const plan = parseFcpxml(exportFcpxml(source.editor.getProject()));
    const target = new EditorController();

    applyFcpxmlPlan(target, plan, new Map());
    const restored = target.getClips().find((clip) => clip.type === 'title')!;
    expect(target.getLastCommandDescription()).toBe('setClipProperties');
    expect(restored.x).toBeCloseTo(240, 2);
    expect(restored.rotation).toBeCloseTo(15, 2);
    expect(restored.opacity).toBe(0.5);

    expect(target.undo()).toBe(true);
    const reverted = target.getClips().find((clip) => clip.type === 'title')!;
    expect(reverted.x).toBe(0);
    expect(reverted.y).toBe(0);
    expect(reverted.width).toBe(1920);
    expect(reverted.height).toBe(1080);
    expect(reverted.rotation).toBe(0);
    expect(reverted.scaleX).toBe(1);
    expect(reverted.scaleY).toBe(1);
    expect(reverted.opacity).toBe(1);
    expect(target.getLastCommandDescription()).toBe('replaceClips');
    expect(target.undo()).toBe(true);
    expect(target.getClips()).toHaveLength(0);
  });

  it('keeps identity title XML byte-compatible with the pre-adjustment shape', () => {
    const plain = titleEditor();
    const explicit = titleEditor({
      x: 0, y: 0, width: 1920, height: 1080, rotation: 0,
      scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, opacity: 1,
    });
    const before = exportFcpxml(plain.editor.getProject());
    const after = exportFcpxml(explicit.editor.getProject());

    expect(after).toBe(before);
    expect(titleTag(after)).toBe(
      '<title name="Title" lane="0" offset="0.000000s" duration="2.000000s" ref="ts1" start="0.000000s">'
      + '<text><text-style ref="ts1">Title</text-style></text>'
      + '<adjust-conform type="fit"/></title>',
    );
  });
});

describe('FCPXML title resource and compound reporting', () => {
  it('skips the macOS Basic Title effect resource and reports the ambiguity', () => {
    const report = exportFcpxmlWithReport(titleEditor().editor.getProject());

    expect(report.xml).not.toContain('<effect id="titleBasic"');
    expect(report.xml).toContain('ref="ts1"');
    expect(report.unsupported).toHaveLength(1);
    expect(report.unsupported[0]).toMatch(/Title ".*" uses a text-style reference/);
    expect(report.unsupported[0]).toMatch(/Basic Title effect resource/);
  });

  it('reports that linked A/V groups are emitted as separate flat clips', () => {
    const editor = new EditorController();
    editor.addMedia({
      id: 'av', path: 'X:/media/av.mp4', filename: 'av.mp4', type: 'video',
      duration: 300, width: 1920, height: 1080, fileSize: 1, audioCodec: 'aac',
      addedAt: new Date().toISOString(),
    });
    editor.addClip({ assetId: 'av', trackId: 'v1', startFrame: 0, durationFrames: 30 });

    const report = exportFcpxmlWithReport(editor.getProject());
    expect(report.xml.match(/<asset-clip\b/g)).toHaveLength(2);
    expect(report.unsupported.some((note) => /linked A\/V group/i.test(note))).toBe(true);
  });

  it('exports compound clips as a nested sequence and parent ref-clip', () => {
    const editor = new EditorController();
    editor.addMedia({
      id: 'v', path: 'X:/media/clip.mp4', filename: 'clip.mp4', type: 'video',
      duration: 300, width: 1920, height: 1080, fileSize: 1,
      addedAt: new Date().toISOString(),
    });
    const clipId = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 30 });
    editor.nestClips([clipId], { name: 'Intro' });

    const report = exportFcpxmlWithReport(editor.getProject());
    expect(report.skippedClips).toBe(0);
    expect(report.exportedClips).toBe(1);
    expect(report.unsupported).toEqual([]);
    expect(report.xml).toContain('<media id="nest1" name="Intro">');
    expect(report.xml).toMatch(/<ref-clip ref="nest1"/);
  });
});
