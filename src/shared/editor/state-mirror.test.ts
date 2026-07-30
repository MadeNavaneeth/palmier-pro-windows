/**
 * Regression coverage for renderer/main state mirroring (upstream issue #89).
 *
 * The bug this pins down: recording a snapshot as mirrored before the IPC call
 * resolved meant one transient failure permanently desynchronized the
 * main-process controller, because the dedupe check then matched and the failed
 * snapshot was never retried. The Agent and MCP server read that controller.
 */

import { describe, it, expect, vi } from 'vitest';
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
