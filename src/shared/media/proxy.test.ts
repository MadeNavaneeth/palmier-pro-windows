import { describe, it, expect } from 'vitest';
import {
  effectiveSourcePath,
  proxyArgs,
  PROXY_WIDTH_CAP,
} from './proxy';

describe('effectiveSourcePath (R2 proxies)', () => {
  const base = { path: 'D:/src/heavy.mp4' };

  it('preview reads the proxy when one exists', () => {
    expect(effectiveSourcePath({ ...base, proxyPath: 'C:/px/a.mp4' }, 'preview'))
      .toBe('C:/px/a.mp4');
  });

  it('export ALWAYS reads the original, proxy or not', () => {
    expect(effectiveSourcePath({ ...base, proxyPath: 'C:/px/a.mp4' }, 'export'))
      .toBe('D:/src/heavy.mp4');
    expect(effectiveSourcePath(base, 'preview')).toBe('D:/src/heavy.mp4');
    expect(effectiveSourcePath(base, 'export')).toBe('D:/src/heavy.mp4');
  });
});

describe('proxyArgs', () => {
  it('caps width, re-encodes audio and faststarts the container', () => {
    const args = proxyArgs('D:/src/heavy.mp4', 'C:/px/out.mp4');
    const joined = args.join(' ');
    expect(joined).toContain(`min(${PROXY_WIDTH_CAP},iw)`);
    expect(joined).toContain('libx264');
    expect(joined).toContain('crf 26');
    expect(joined).toContain('aac');
    expect(joined).toContain('faststart');
    expect(args[args.length - 1]).toBe('C:/px/out.mp4');
  });
});
