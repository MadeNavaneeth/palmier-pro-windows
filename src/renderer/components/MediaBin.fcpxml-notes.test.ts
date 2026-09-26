/**
 * FCPXML import omissions in the media bin (#154).
 *
 * `parseFcpxml` collects what the format carried but this editor cannot place
 * into `plan.unsupported`, and the applier adds its own refusals to the same
 * list. These notes used to be dropped in the bin, so a document refused
 * wholesale reported "Imported: 0 clips, 0 titles, 0 tracks." and never said
 * why nothing arrived. They must reach the user, whole and in their own
 * wording, without dressing a successful run up as a failure.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFcpxml } from '../../shared/fcpxml/importer';
import { degenerateRateRefusal } from '../../shared/fcpxml/apply';
import { FcpxmlImportNotes } from './MediaBin';

function document(spine: string, format = '1001/30000s'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.9">
  <resources>
    <format id="r1" frameDuration="${format}" width="1920" height="1080"/>
    <asset id="r2" name="interview.mov" src="file:///C:/footage/interview.mov"
      hasVideo="1" hasAudio="1" start="0s" duration="120s"/>
  </resources>
  <library>
    <event name="Interview">
      <project name="Cut">
        <sequence format="r1" duration="120s" tcStart="0s" tcFormat="NDF">
          <spine>${spine}</spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
}

/** Nothing here is unrepresentable, so the plan reports no note at all. */
const CLEAN = document('<asset-clip ref="r2" name="Interview" offset="0s" start="0s" duration="30s"/>');

/** A constant speed, an effect and a shape: three reasons the plan must report. */
const DECORATED = document(`<asset-clip ref="r2" name="Interview_Season_2_Episode_10_Master_Shot_A001_C012.mov" offset="0s" start="0s" duration="30s">
              <timeMap>
                <timept time="0s" value="0s"/>
                <timept time="30s" value="60s"/>
              </timeMap>
              <effect-ref ref="r3"/>
            </asset-clip>
            <generator-clip name="Lower third" ref="r4" offset="30s" duration="10s"/>`);

/** A document rate below one frame per second. */
const SUB_FPS = document(
  '<asset-clip ref="r2" name="Interview" offset="0s" start="0s" duration="30s"/>',
  '2s',
);

function render(notes: readonly string[]): string {
  return renderToStaticMarkup(React.createElement(FcpxmlImportNotes, { notes }));
}

/** The note as it appears in the markup, where the text entities are escaped. */
function escaped(note: string): string {
  return note
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

describe('FCPXML import omissions in the media bin', () => {
  it('stays out of the way when the plan reported nothing', () => {
    const markup = render([]);

    expect(markup).toBe('');
    expect(markup).not.toContain('Not imported');
  });

  it('leaves a clean import visually unchanged', () => {
    const plan = parseFcpxml(CLEAN);

    expect(plan.unsupported).toEqual([]);
    expect(render(plan.unsupported)).toBe('');
  });

  it('lists every importer note verbatim, as a list', () => {
    const plan = parseFcpxml(DECORATED);
    const markup = render(plan.unsupported);

    expect(plan.unsupported.length).toBeGreaterThan(1);
    expect(markup).toContain(`Not imported (${plan.unsupported.length}):`);
    expect(markup.match(/<li/g)).toHaveLength(plan.unsupported.length);
    for (const note of plan.unsupported) {
      // No paraphrasing and no clipping: the sentence that explains the
      // omission is the sentence the user reads.
      expect(markup).toContain(escaped(note));
    }
  });

  it('shows the note the applier adds for a rate below one frame per second', () => {
    const plan = parseFcpxml(SUB_FPS);
    expect(plan.clips.length).toBeGreaterThan(0);

    const refusal = degenerateRateRefusal(plan, 30);
    const markup = render(plan.unsupported);

    expect(refusal).not.toBeNull();
    expect(markup).toContain(escaped(refusal!));
  });

  it('keeps a document with many notes complete, capped and scrollable', () => {
    const notes = Array.from(
      { length: 40 },
      (_, index) => `Asset-clip "Interview_Season_2_Episode_10_Master_Shot_A${index}" has an unsupported timeMap: only linear interpolation represents a constant speed.`,
    );

    const markup = render(notes);

    expect(markup).toContain('Not imported (40):');
    expect(markup.match(/<li/g)).toHaveLength(40);
    for (const note of notes) expect(markup).toContain(escaped(note));
    // The list scrolls inside its own cap rather than growing the panel, and
    // nothing is elided to fit.
    expect(markup).toContain('max-h-28');
    expect(markup).toContain('overflow-y-auto');
    expect(markup).not.toContain('truncate');
    expect(markup).not.toContain('line-clamp');
  });

  it('is a notice, not an error: the import itself succeeded', () => {
    const markup = render(parseFcpxml(DECORATED).unsupported);

    expect(markup).toContain('text-amber-300');
    expect(markup).not.toContain('text-red');
    expect(markup).not.toContain('role="alert"');
  });
});
