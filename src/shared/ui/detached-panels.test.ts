import { describe, expect, it } from 'vitest';
import {
  DETACHABLE_PANELS,
  DETACHED_WINDOW_CONFIG,
  asMirroredProject,
  isDetachablePanel,
  parseDetachedPanel,
} from './detached-panels';

describe('detached panels contract (#286)', () => {
  it('allows the detachable panels and nothing else', () => {
    expect([...DETACHABLE_PANELS].sort()).toEqual(['agent', 'export', 'inspector', 'media']);
    for (const panel of ['media', 'inspector', 'agent', 'export']) {
      expect(isDetachablePanel(panel)).toBe(true);
    }
    // The Agent detaches only with a transcript hand-off and the busy rule
    // (see the module docs); the query parser still narrows everything else.
    for (const bad of ['timeline', 'preview', '', null, undefined, 42, {}, []]) {
      expect(isDetachablePanel(bad)).toBe(false);
    }
  });

  it('reads the panel from the window query, narrowing everything else to null', () => {
    expect(parseDetachedPanel('?panel=media')).toBe('media');
    expect(parseDetachedPanel('?panel=agent')).toBe('agent');
    expect(parseDetachedPanel('?panel=inspector')).toBe('inspector');
    expect(parseDetachedPanel('?panel=export')).toBe('export');
    expect(parseDetachedPanel('')).toBeNull();
    expect(parseDetachedPanel('?panel=Media')).toBeNull();
    expect(parseDetachedPanel('?panel=media%00')).toBeNull();
    expect(parseDetachedPanel('?other=1')).toBeNull();
    expect(parseDetachedPanel('not a query at all')).toBeNull();
  });

  it('accepts a well-formed mirror payload', () => {
    const data = { version: 2, name: 'x', media: [], settings: {}, timeline: {} };
    expect(asMirroredProject({ success: true, data })).toBe(data);
  });

  it('rejects anything that is not a well-formed mirror payload', () => {
    const valid = { version: 2, name: 'x', media: [], settings: {}, timeline: {} };
    for (const bad of [
      null,
      undefined,
      42,
      'ok',
      [],
      { success: false, data: valid },
      { success: true },
      { success: true, data: null },
      { success: true, data: { ...valid, version: '2' } },
      { success: true, data: { ...valid, media: {} } },
      { success: true, data: { ...valid, settings: null } },
      { success: true, data: { ...valid, timeline: undefined } },
    ]) {
      expect(asMirroredProject(bad)).toBeNull();
    }
  });

  it('gives every detachable panel a usable window size', () => {
    for (const panel of DETACHABLE_PANELS) {
      const config = DETACHED_WINDOW_CONFIG[panel];
      expect(config.width).toBeGreaterThanOrEqual(config.minWidth);
      expect(config.height).toBeGreaterThanOrEqual(config.minHeight);
      expect(config.minWidth).toBeGreaterThanOrEqual(200);
      expect(config.minHeight).toBeGreaterThanOrEqual(200);
      expect(config.title.length).toBeGreaterThan(0);
    }
  });
});
