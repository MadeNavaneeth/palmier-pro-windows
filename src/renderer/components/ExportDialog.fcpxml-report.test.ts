/**
 * FCPXML omission reporting in the export panel (#154).
 *
 * The exporter declines to transport grade, effects, blend modes, fades and
 * edge treatments, and skips clip kinds with no FCPXML form, reporting each in
 * `FcpxmlExportResult.unsupported`. These notes used to be dropped on the floor,
 * so a graded clip or a shape came back different with the panel claiming a
 * clean write. The notes must now reach the user, grouped rather than dumped,
 * without ever looking like a failure.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project } from '../../shared/types/project';
import { exportFcpxmlWithReport } from '../../shared/fcpxml/exporter';
import { summarizeXmlOmissions, XmlExportReport } from './ExportDialog';

const VIDEO_PATH = 'X:/media/clip.mp4';

function projectWith(clips: Array<Record<string, unknown>>): Project {
  return {
    version: 2,
    name: 'Omission Fixture',
    settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000, backgroundColor: '#000000' },
    media: [{
      id: 'v', path: VIDEO_PATH, filename: 'clip.mp4', type: 'video', duration: 600,
      width: 1920, height: 1080, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
    }],
    timeline: {
      tracks: [{ id: 'v1', name: 'Video 1', type: 'video', locked: false, visible: true, syncLocked: true, order: 0 }],
      clips: clips.map((clip, index) => ({
        id: `c${index}`, assetId: 'v', label: 'Clip', trackId: 'v1', type: 'video',
        startFrame: index * 60, durationFrames: 60, inPoint: 0, outPoint: 60,
        x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
        opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
        ...clip,
      })) as unknown as Project['timeline']['clips'],
      playheadFrame: 0,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Project;
}

function render(summary: ReturnType<typeof summarizeXmlOmissions> | null): string {
  return renderToStaticMarkup(
    React.createElement(XmlExportReport, { note: 'Written to X:/out.fcpxml', summary }),
  );
}

describe('FCPXML omission report in the export panel', () => {
  it('groups the exporter notes by property kind and names the clips', () => {
    const project = projectWith([
      { id: 'graded', brightness: 0.2, fadeInFrames: 12 },
      { id: 'faded-out', fadeOutFrames: 8, edgeSoftness: 0.3 },
      { id: 'blended', blendMode: 'multiply' },
      { id: 'plain' },
    ]);

    const report = exportFcpxmlWithReport(project);
    const summary = summarizeXmlOmissions(report.unsupported);

    expect(summary.total).toBe(5);
    expect(summary.subjectCount).toBe(3);
    expect(summary.groups.map((group) => [group.label, group.count, group.subjects])).toEqual([
      ['color grade', 1, ['graded']],
      ['fades', 2, ['graded', 'faded-out']],
      ['edge softness', 1, ['faded-out']],
      ['layer blend mode', 1, ['blended']],
    ]);
    // The exporter's wording is the contract; the verbatim note rides along so
    // a hover never shows a reshaped version of it.
    expect(summary.groups[0]?.note).toBe(report.unsupported[0]);
    expect(summary.groups.map((group) => `${group.count} ${group.plural}`)).toEqual([
      '1 clips', '2 clips', '1 clips', '1 clips',
    ]);

    const markup = render(summary);
    expect(markup).toContain('color grade');
    expect(markup).toContain('fades');
    expect(markup).toContain('edge softness');
    expect(markup).toContain('layer blend mode');
    expect(markup).toContain('graded');
    expect(markup).toContain('Written to X:/out.fcpxml');
    // The explicit-default clip raised no note, so it is not named.
    expect(markup).not.toContain('plain');
  });

  it('reports a clip kind with no FCPXML form alongside property omissions', () => {
    const project = projectWith([
      { id: 'graded', brightness: 0.2 },
      { id: 'shape-1', type: 'shape', shapeKind: 'rect' },
      { id: 'shape-2', type: 'shape', shapeKind: 'ellipse' },
    ]);

    const summary = summarizeXmlOmissions(exportFcpxmlWithReport(project).unsupported);

    const shape = summary.groups.find((group) => group.label.includes('shape clips have no FCPXML form'));
    expect(shape).toMatchObject({
      count: 2,
      singular: 'shape clip',
      plural: 'shape clips',
      subjects: ['shape-1', 'shape-2'],
    });
    expect(render(summary)).toContain('2 shape clips');
    expect(render(summary)).toContain('shape-1');
  });

  it('stays readable for a project with hundreds of omissions', () => {
    const project = projectWith(
      Array.from({ length: 200 }, (_, index) => ({ id: `g${index}`, brightness: 0.2 })),
    );

    const summary = summarizeXmlOmissions(exportFcpxmlWithReport(project).unsupported);

    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]).toMatchObject({ label: 'color grade', count: 200 });
    expect(summary.groups[0]?.subjects).toEqual(['g0', 'g1', 'g2']);
    expect(summary.groups[0]?.moreSubjects).toBe(197);

    const markup = render(summary);
    // One row, three ids, and a tail — not two hundred lines.
    expect(markup.match(/<li/g)).toHaveLength(1);
    expect(markup).toContain('200 clips');
    expect(markup).toContain('g0, g1, g2 +197 more');
  });

  it('keeps every distinct reason visible without listing each one', () => {
    const kinds = [
      'color grade', 'effects', 'layer blend mode', 'fades',
      'edge rounding', 'edge softness', 'an invalid speed', 'a non-unit speed',
    ];
    const notes = kinds.flatMap((kind, index) => [
      `Clip "c${index}" carries ${kind}; FCPXML does not represent it.`,
      `Clip "d${index}" carries ${kind}; FCPXML does not represent it.`,
    ]);

    const summary = summarizeXmlOmissions(notes);
    const markup = render(summary);

    expect(summary.groups.map((group) => group.label)).toEqual([
      'color grade', 'effects', 'layer blend mode', 'fades',
      'edge rounding', 'edge softness', 'invalid speed', 'non-unit speed',
    ]);
    expect(summary.total).toBe(16);
    expect(summary.subjectCount).toBe(16);
    // Every kind is summarized, and the list is capped rather than truncated.
    expect(markup).toContain('+2 more kinds');
    expect(markup.match(/<li/g)).toHaveLength(6);
  });

  it('passes a note with no quoted subject through instead of dropping it', () => {
    const summary = summarizeXmlOmissions(['The whole project has no FCPXML form.']);

    expect(summary.groups).toEqual([expect.objectContaining({
      label: 'The whole project has no FCPXML form.',
      count: 1,
      singular: 'item',
      plural: 'items',
      subjects: [],
    })]);
    expect(render(summary)).toContain('The whole project has no FCPXML form.');
  });
});

describe('FCPXML write result presentation', () => {
  it('reports a clean export exactly as before, with no omission notice', () => {
    const project = projectWith([{ id: 'plain' }]);
    const report = exportFcpxmlWithReport(project);
    expect(report.unsupported).toEqual([]);

    const markup = render(summarizeXmlOmissions(report.unsupported));

    expect(markup).toContain('✓ Written to X:/out.fcpxml');
    expect(markup).not.toContain('data-export-xml-omissions');
    expect(markup).not.toContain('amber');
    // The success line keeps the panel's existing styling verbatim.
    expect(markup).toContain('class="mt-1 flex items-center gap-1.5 text-[10px] text-emerald-400"');
  });

  it('shows a successful export with omissions as a notice, not an error', () => {
    const summary = summarizeXmlOmissions(exportFcpxmlWithReport(
      projectWith([{ id: 'graded', brightness: 0.2 }]),
    ).unsupported);
    const markup = render(summary);

    // The write still succeeded, and says so.
    expect(markup).toContain('✓ Written to X:/out.fcpxml');
    expect(markup).toContain('text-emerald-400');
    expect(markup).toContain('The file was written without them.');
    // The panel's error line is red; the notice must not borrow it.
    expect(markup).toContain('text-amber-300');
    expect(markup).not.toContain('text-red-400');
    expect(markup).not.toContain('role="alert"');
  });

  it('renders the success line alone when no report was carried', () => {
    const markup = render(null);
    expect(markup).toContain('✓ Written to X:/out.fcpxml');
    expect(markup).not.toContain('data-export-xml-omissions');
  });
});
