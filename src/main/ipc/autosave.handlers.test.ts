/**
 * IPC-level recovery regression coverage.
 *
 * These tests exercise the real sender/session routing and filesystem writes;
 * the pure path tests above cover the narrower path invariant.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createEmptyProject } from '../../shared/types/project';
import { drainWrites } from '../services/project-writer';
import {
  addWindow,
  createSession,
  resetSessions,
  type SessionWindow,
} from '../sessions';

type MockHandler = (
  event: { sender: { id: number } },
  ...args: unknown[]
) => Promise<unknown>;

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, MockHandler>(),
  userData: '',
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: MockHandler) => {
      electronState.handlers.set(channel, handler);
    },
  },
  app: {
    getPath: () => electronState.userData,
  },
}));

const { registerAutosaveHandlers, recoveryFileForSession } = await import('./autosave');

const scratchDirs: string[] = [];
let nextWindowId = 1;

function fakeWindow(id: number): SessionWindow {
  return {
    id,
    isDestroyed: () => false,
    send: () => {},
  };
}

async function makeUserData(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-recovery-ipc-'));
  scratchDirs.push(dir);
  electronState.userData = dir;
  return dir;
}

async function invoke(channel: string, senderId: number, ...args: unknown[]): Promise<unknown> {
  const handler = electronState.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler: ${channel}`);
  return handler({ sender: { id: senderId } }, ...args);
}

function dataFor(name: string): string {
  return JSON.stringify(createEmptyProject(name));
}

beforeAll(() => {
  registerAutosaveHandlers();
});

beforeEach(async () => {
  resetSessions();
  electronState.handlers.clear();
  // Re-register after clearing the mock map; the real application registers
  // once, while each test gets a clean handler table.
  registerAutosaveHandlers();
  await makeUserData();
  nextWindowId = 1;
});

afterEach(async () => {
  await drainWrites();
  resetSessions();
  while (scratchDirs.length > 0) {
    await fs.rm(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe('recovery IPC session routing', () => {
  it('writes two live sessions to separate files and discovers the other after a restart', async () => {
    const first = createSession();
    const second = createSession();
    const firstWindowId = nextWindowId++;
    const secondWindowId = nextWindowId++;
    addWindow(first.id, fakeWindow(firstWindowId));
    addWindow(second.id, fakeWindow(secondWindowId));

    await invoke('project:autosave', firstWindowId, 'First', null, dataFor('First'));
    await invoke('project:autosave', secondWindowId, 'Second', null, dataFor('Second'));
    await drainWrites();

    const firstPath = recoveryFileForSession(path.join(electronState.userData, 'recovery'), first.id);
    const secondPath = recoveryFileForSession(path.join(electronState.userData, 'recovery'), second.id);
    expect(await fs.readFile(firstPath, 'utf-8')).toContain('First');
    expect(await fs.readFile(secondPath, 'utf-8')).toContain('Second');
    expect(firstPath).not.toBe(secondPath);

    // A fresh session represents the next process launch. Its UUID is not the
    // crashed file's UUID, but enumeration still finds the orphan.
    resetSessions();
    const next = createSession();
    const nextId = nextWindowId++;
    addWindow(next.id, fakeWindow(nextId));
    const result = await invoke('project:recovery-check', nextId) as {
      hasRecovery: boolean;
      recoveryId?: string;
    };

    expect(result.hasRecovery).toBe(true);
    expect([first.id, second.id]).toContain(result.recoveryId);
    // Both old sessions are no longer live after the simulated restart.
    expect(result.recoveryId).not.toBe(next.id);
  });

  it('does not offer or clear another live session snapshot', async () => {
    const first = createSession();
    const second = createSession();
    const firstWindowId = nextWindowId++;
    const secondWindowId = nextWindowId++;
    addWindow(first.id, fakeWindow(firstWindowId));
    addWindow(second.id, fakeWindow(secondWindowId));

    await invoke('project:autosave', secondWindowId, 'Live second', null, dataFor('Live second'));
    await drainWrites();
    const secondPath = recoveryFileForSession(path.join(electronState.userData, 'recovery'), second.id);

    const check = await invoke('project:recovery-check', firstWindowId) as { hasRecovery: boolean };
    expect(check.hasRecovery).toBe(false);
    await expect(fs.access(secondPath)).resolves.toBeUndefined();

    const clear = await invoke('project:recovery-clear', firstWindowId, second.id) as {
      success: boolean;
    };
    expect(clear.success).toBe(false);
    await expect(fs.access(secondPath)).resolves.toBeUndefined();
  });

  it('removes a specifically selected orphan on discard', async () => {
    const old = createSession();
    const oldWindowId = nextWindowId++;
    addWindow(old.id, fakeWindow(oldWindowId));
    await invoke('project:autosave', oldWindowId, 'Old', null, dataFor('Old'));
    await drainWrites();
    const oldPath = recoveryFileForSession(path.join(electronState.userData, 'recovery'), old.id);
    resetSessions();

    const next = createSession();
    const nextId = nextWindowId++;
    addWindow(next.id, fakeWindow(nextId));
    const check = await invoke('project:recovery-check', nextId) as { recoveryId?: string };
    const result = await invoke('project:recovery-clear', nextId, check.recoveryId) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    await expect(fs.access(oldPath)).rejects.toThrow();
  });
});
