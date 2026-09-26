/**
 * Regression coverage for renderer/main state mirroring (upstream issue #89).
 *
 * The bug this pins down: recording a snapshot as mirrored before the IPC call
 * resolved meant one transient failure permanently desynchronized the
 * main-process controller, because the dedupe check then matched and the failed
 * snapshot was never retried. The Agent and MCP server read that controller.
 */

import { describe, it, expect, vi } from 'vitest';
import { EditorController } from './controller';
import { createEmptyProject } from '../types/project';
import { StateMirror } from './state-mirror';

describe('deduplication', () => {
  it('skips a snapshot the peer already confirmed', async () => {
    const mirror = new StateMirror();
    const send = vi.fn(async () => undefined);

    expect(await mirror.push('a', send)).toEqual({ attempted: true, delivered: true });
    expect(await mirror.push('a', send)).toEqual({ attempted: false, delivered: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('pushes again once the state changes', async () => {
    const mirror = new StateMirror();
    const send = vi.fn(async (_serialized: string) => undefined);

    await mirror.push('a', send);
    await mirror.push('b', send);
    await mirror.push('a', send);

    expect(send.mock.calls.map((call) => call[0])).toEqual(['a', 'b', 'a']);
  });

  it('reports what the peer holds', async () => {
    const mirror = new StateMirror();
    expect(mirror.lastConfirmed()).toBeNull();
    expect(mirror.needsPush('a')).toBe(true);

    await mirror.push('a', async () => undefined);
    expect(mirror.lastConfirmed()).toBe('a');
    expect(mirror.needsPush('a')).toBe(false);
  });
});

describe('failed push', () => {
  it('does not record the snapshot, so the next attempt retries it', async () => {
    const mirror = new StateMirror();
    const send = vi.fn(async (serialized: string) => {
      if (serialized === 'a') throw new Error('IPC down');
      return undefined;
    });

    const failure = await mirror.push('a', send);
    expect(failure.attempted).toBe(true);
    expect(failure.delivered).toBe(false);
    expect(failure.error).toBeInstanceOf(Error);
    // The whole point: main does not hold 'a', so we must not believe it does.
    expect(mirror.lastConfirmed()).toBeNull();
    expect(mirror.needsPush('a')).toBe(true);
  });

  it('recovers on a later attempt at the same state', async () => {
    const mirror = new StateMirror();
    let failNext = true;
    const send = vi.fn(async () => {
      if (failNext) {
        failNext = false;
        throw new Error('transient');
      }
      return undefined;
    });

    expect((await mirror.push('a', send)).delivered).toBe(false);
    expect((await mirror.push('a', send)).delivered).toBe(true);
    expect(mirror.lastConfirmed()).toBe('a');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('treats a resolved success:false reply as a failed delivery', async () => {
    const mirror = new StateMirror();
    const refusal = { success: false, error: 'main refused the sync' };

    const result = await mirror.push('a', async () => refusal);

    expect(result).toMatchObject({
      attempted: true,
      delivered: false,
      error: refusal.error,
    });
    expect(mirror.lastConfirmed()).toBeNull();
    expect(mirror.needsPush('a')).toBe(true);
  });

  it('returns the rejection instead of throwing at the caller', async () => {
    const mirror = new StateMirror();
    // The caller is a detached subscriber with nowhere to propagate a throw.
    await expect(
      mirror.push('a', async () => {
        throw new Error('boom');
      }),
    ).resolves.toMatchObject({ delivered: false });
  });

  it('keeps an earlier confirmed state after a later failure', async () => {
    const mirror = new StateMirror();
    await mirror.push('a', async () => undefined);
    await mirror.push('b', async () => {
      throw new Error('down');
    });

    expect(mirror.lastConfirmed()).toBe('a');
    expect(mirror.needsPush('b')).toBe(true);
  });
});

describe('in-flight tracking', () => {
  it('is set while awaiting confirmation and cleared afterwards', async () => {
    const mirror = new StateMirror();
    let release: (() => void) | null = null;
    const pending = mirror.push('a', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    expect(mirror.isPushing()).toBe(true);
    release!();
    await pending;
    expect(mirror.isPushing()).toBe(false);
  });

  it('is cleared after a failure too', async () => {
    const mirror = new StateMirror();
    await mirror.push('a', async () => {
      throw new Error('down');
    });
    expect(mirror.isPushing()).toBe(false);
  });
});

describe('echo handling', () => {
  it('recognizes our own state coming back from the peer', async () => {
    const mirror = new StateMirror();
    await mirror.push('a', async () => undefined);

    expect(mirror.isEcho('a')).toBe(true);
    expect(mirror.isEcho('b')).toBe(false);
  });

  it('treats nothing as an echo before the first successful push', () => {
    const mirror = new StateMirror();
    expect(mirror.isEcho('')).toBe(false);
    expect(mirror.isEcho('a')).toBe(false);
  });

  it('adopts a peer push without sending it back', async () => {
    const mirror = new StateMirror();
    const send = vi.fn(async () => undefined);

    mirror.markConfirmed('from-peer');
    expect(await mirror.push('from-peer', send)).toEqual({
      attempted: false,
      delivered: false,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('forgets the peer state on reset', async () => {
    const mirror = new StateMirror();
    await mirror.push('a', async () => undefined);
    mirror.reset();

    expect(mirror.lastConfirmed()).toBeNull();
    expect(mirror.needsPush('a')).toBe(true);
  });
});

/**
 * Snapshots cross the boundary in two spellings: `EditorController.serialize`
 * pretty-prints, and every peer payload is compact. Comparing the raw strings
 * meant neither the dedupe check nor the echo guard could ever match, so every
 * snapshot after an inbound adoption shipped a redundant push and the echo
 * guard documented at useEditorSync did not exist.
 */
describe('canonical comparison across spellings', () => {
  const pretty = JSON.stringify({ b: 1, a: [1, { d: 4, c: 3 }] }, null, 2);
  const compact = JSON.stringify({ b: 1, a: [1, { d: 4, c: 3 }] });
  const reordered = JSON.stringify({ a: [1, { c: 3, d: 4 }], b: 1 });

  it('does not need the fix to be a no-op for identical strings', async () => {
    const mirror = new StateMirror();
    await mirror.push(pretty, async () => undefined);

    expect(mirror.needsPush(pretty)).toBe(false);
    expect(mirror.isEcho(pretty)).toBe(true);
  });

  it('sees a compact peer payload as the state it already holds', async () => {
    const mirror = new StateMirror();
    const send = vi.fn(async () => undefined);
    await mirror.push(pretty, send);

    expect(mirror.needsPush(compact)).toBe(false);
    expect(mirror.isEcho(compact)).toBe(true);
    // ...and back the other way, which is the direction the renderer actually
    // hits after adopting an inbound push.
    expect(mirror.needsPush(pretty)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ignores key order, which JSON.stringify does not promise to preserve', () => {
    const mirror = new StateMirror();
    mirror.markConfirmed(compact);

    expect(mirror.isEcho(reordered)).toBe(true);
    expect(mirror.needsPush(reordered)).toBe(false);
  });

  it('still distinguishes a real change in either spelling', async () => {
    const mirror = new StateMirror();
    mirror.markConfirmed(pretty);

    const edited = JSON.stringify({ b: 2, a: [1, { d: 4, c: 3 }] });
    expect(mirror.needsPush(edited)).toBe(true);
    expect(mirror.isEcho(edited)).toBe(false);
    expect(mirror.needsPush(JSON.stringify({ b: 1, a: [1, { d: 5, c: 3 }] }, null, 2))).toBe(true);
    expect(mirror.needsPush(JSON.stringify({ b: 1, a: [1, { d: 4, c: 3 }], extra: 1 }))).toBe(true);
  });

  it('round-trips a real project through both spellings', () => {
    const mirror = new StateMirror();
    const controller = new EditorController(createEmptyProject('Round trip'));
    controller.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 30, durationFrames: 90 });
    const serialized = controller.serialize();

    // What main hands the peer back after accepting it.
    mirror.markConfirmed(JSON.stringify(controller.getProject()));
    expect(mirror.isEcho(serialized)).toBe(true);
    expect(mirror.needsPush(serialized)).toBe(false);

    // And what a peer sends after adopting that same state from us.
    mirror.markConfirmed(serialized);
    expect(mirror.isEcho(JSON.stringify(controller.getProject()))).toBe(true);
  });

  it('falls back to the raw string for a snapshot that is not JSON', () => {
    const mirror = new StateMirror();
    mirror.markConfirmed('not json');

    expect(mirror.needsPush('not json')).toBe(false);
    expect(mirror.isEcho('not json')).toBe(true);
    expect(mirror.isEcho('other')).toBe(false);
  });
});
