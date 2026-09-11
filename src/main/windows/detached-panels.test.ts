import { describe, expect, it } from 'vitest';
import {
  DetachedPanelsManager,
  detachedPanelUrl,
  type DetachedWindowLike,
} from './detached-panels';
import type { DetachablePanel } from '../../shared/ui/detached-panels';

function fakeWindow(): DetachedWindowLike & { fireClosed(): void; destroyed: boolean; focused: boolean } {
  const listeners = new Map<string, Array<() => void>>();
  const win = {
    destroyed: false,
    focused: false,
    focus: () => { win.focused = true; },
    destroy: () => {
      win.destroyed = true;
      for (const listener of listeners.get('closed') ?? []) listener();
    },
    isDestroyed: () => win.destroyed,
    on: (event: 'closed', listener: () => void) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    fireClosed: () => {
      for (const listener of listeners.get('closed') ?? []) listener();
    },
  };
  return win;
}

function harness() {
  const created: Array<{ panel: DetachablePanel; url: string }> = [];
  const broadcasts: DetachablePanel[][] = [];
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const manager = new DetachedPanelsManager({
    createWindow: (panel, url) => {
      created.push({ panel, url });
      const win = fakeWindow();
      windows.push(win);
      return win;
    },
    broadcast: (panels) => { broadcasts.push([...panels]); },
  });
  return { manager, created, broadcasts, windows };
}

describe('detached panel windows (#286)', () => {
  it('opens a window with the panel query and broadcasts the detached set', () => {
    const { manager, created, broadcasts } = harness();

    manager.detach('media');

    expect(created).toEqual([{ panel: 'media', url: detachedPanelUrl('media') }]);
    expect(detachedPanelUrl('media')).toBe('?panel=media');
    expect(manager.listDetached()).toEqual(['media']);
    expect(broadcasts).toEqual([['media']]);
  });

  it('detaching twice focuses the existing window instead of opening another', () => {
    const { manager, created, broadcasts, windows } = harness();

    manager.detach('export');
    manager.detach('export');

    expect(created).toHaveLength(1);
    expect(windows[0].focused).toBe(true);
    expect(manager.listDetached()).toEqual(['export']);
    // One broadcast for the open; the focus is local and says nothing.
    expect(broadcasts).toEqual([['export']]);
  });

  it('attach closes the window and broadcasts the empty set', () => {
    const { manager, broadcasts, windows } = harness();

    manager.detach('inspector');
    manager.attach('inspector');

    expect(windows[0].destroyed).toBe(true);
    expect(manager.listDetached()).toEqual([]);
    expect(broadcasts).toEqual([['inspector'], []]);
  });

  it('closing the window from its own chrome detaches exactly once', () => {
    const { manager, broadcasts, windows } = harness();

    manager.detach('media');
    windows[0].fireClosed();

    expect(manager.listDetached()).toEqual([]);
    expect(broadcasts).toEqual([['media'], []]);
  });

  it('attaching a panel with no window is a no-op and says nothing', () => {
    const { manager, broadcasts } = harness();

    manager.attach('media');

    expect(broadcasts).toEqual([]);
  });

  it('tracks several panels independently', () => {
    const { manager, broadcasts } = harness();

    manager.detach('media');
    manager.detach('export');
    manager.attach('media');

    expect(manager.listDetached()).toEqual(['export']);
    expect(broadcasts).toEqual([['media'], ['media', 'export'], ['export']]);
  });

  it('does not double-broadcast when attach destroys a window that reports closed', () => {
    const { manager, broadcasts, windows } = harness();

    manager.detach('media');
    manager.attach('media');
    // The destroy() above fired 'closed' on the fake; only attach's broadcast
    // may have gone out.
    expect(broadcasts).toEqual([['media'], []]);
    expect(windows[0].destroyed).toBe(true);
  });
});
