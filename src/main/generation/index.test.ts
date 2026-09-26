import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type {
  GenerationProvider,
  GenerationRequest,
  GenerationResult,
} from './types';
import { setGenerationProviders } from './manager';

type MockIpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const { ipcHandlers, fromWebContents } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, MockIpcHandler>(),
  fromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: MockIpcHandler) => {
      ipcHandlers.set(channel, listener);
    },
  },
  BrowserWindow: { fromWebContents },
  safeStorage: {
    isEncryptionAvailable: () => false,
    decryptString: () => '',
    encryptString: () => Buffer.alloc(0),
  },
  app: undefined,
}));

vi.mock('electron-store', () => ({
  default: class MockStore {
    store: Record<string, unknown> = { keys: {} };
    set() {}
  },
}));

import { registerGenerationHandlers } from './index';
import { FalProvider } from './provider-fal';

interface FakeWindow {
  webContents: {
    id: number;
    send: ReturnType<typeof vi.fn>;
  };
}

function fakeWindow(id: number): FakeWindow {
  return { webContents: { id, send: vi.fn() } };
}

function handler(channel: string): MockIpcHandler {
  const listener = ipcHandlers.get(channel);
  if (!listener) throw new Error(`Missing IPC handler: ${channel}`);
  return listener;
}

function fakeProvider(overrides: Partial<GenerationProvider> = {}): GenerationProvider {
  return {
    id: 'ipc-fake',
    name: 'IPC Fake',
    supportedTypes: ['image', 'video'],
    isConfigured: () => true,
    configure: () => {},
    getModels: () => ['fake-model'],
    generate: async (request: GenerationRequest) => ({
      id: request.id,
      status: 'completed',
      outputPath: `C:/generated/${request.id}.png`,
    }),
    cancel: async () => {},
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  ipcHandlers.clear();
  fromWebContents.mockReset();
  setGenerationProviders([]);
  registerGenerationHandlers();
});

describe('generation IPC lifecycle', () => {
  it('keeps progress and completion targeted to the requesting window', async () => {
    const provider = fakeProvider({
      generate: async (
        request: GenerationRequest,
        onProgress,
      ): Promise<GenerationResult> => {
        onProgress?.({
          id: request.id,
          status: 'processing',
          percent: 25,
          message: 'working',
        });
        return { id: request.id, status: 'completed', outputPath: 'result.png' };
      },
    });
    setGenerationProviders([provider]);
    const winA = fakeWindow(1);
    const winB = fakeWindow(2);
    const windows = new Map([[1, winA], [2, winB]]);
    fromWebContents.mockImplementation((sender: { id: number }) => windows.get(sender.id));

    const start = handler('generation:start');
    const startedA = await start(
      { sender: { id: 1 } },
      { type: 'image', prompt: 'A', provider: 'ipc-fake' },
    ) as { success: boolean; id: string };
    const startedB = await start(
      { sender: { id: 2 } },
      { type: 'image', prompt: 'B', provider: 'ipc-fake' },
    ) as { success: boolean; id: string };
    await flushPromises();

    expect(startedA).toMatchObject({ success: true });
    expect(startedB).toMatchObject({ success: true });
    expect(winA.webContents.send.mock.calls).toEqual([
      ['generation:progress', expect.objectContaining({ id: startedA.id, percent: 25 })],
      ['generation:complete', expect.objectContaining({ id: startedA.id, status: 'completed' })],
    ]);
    expect(winB.webContents.send.mock.calls).toEqual([
      ['generation:progress', expect.objectContaining({ id: startedB.id, percent: 25 })],
      ['generation:complete', expect.objectContaining({ id: startedB.id, status: 'completed' })],
    ]);
  });

  it('emits no completion after cancellation, so a late result cannot be imported', async () => {
    let release!: (result: GenerationResult) => void;
    let captured!: () => void;
    const providerRequestCaptured = new Promise<void>((resolve) => { captured = resolve; });
    setGenerationProviders([
      fakeProvider({
        generate: (_request, _onProgress, execution) => {
          execution?.onProviderRequest('provider-prediction-id');
          captured();
          return new Promise<GenerationResult>((resolve) => { release = resolve; });
        },
      }),
    ]);
    const win = fakeWindow(3);
    fromWebContents.mockReturnValue(win);

    const started = await handler('generation:start')(
      { sender: { id: 3 } },
      { type: 'image', prompt: 'late', provider: 'ipc-fake' },
    ) as { success: boolean; id: string };
    expect(started.success).toBe(true);
    await providerRequestCaptured;

    await expect(handler('generation:cancel')({}, started.id)).resolves.toMatchObject({
      success: true,
      remoteCancellation: 'confirmed',
    });
    release({ id: started.id, status: 'completed', outputPath: 'must-not-import.png' });
    await flushPromises();

    expect(win.webContents.send.mock.calls.some(
      ([channel]) => channel === 'generation:complete',
    )).toBe(false);
  });
});

/**
 * The dialog's path to the same adapters. The shell forwards the request
 * untouched, so the reference must survive to the provider as bytes on the wire
 * and must fail loudly, before any provider call, when it cannot be used.
 */
describe('generation:start reference images', () => {
  const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const DATA_URI = `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`;

  let tmpDir: string;
  let referencePath: string;
  let win: FakeWindow;
  let bodies: string[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-ipc-ref-'));
    referencePath = path.join(tmpDir, 'reference.png');
    await fs.writeFile(referencePath, ONE_PIXEL_PNG);
    win = fakeWindow(7);
    fromWebContents.mockReturnValue(win);
    bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return {
        ok: false,
        status: 422,
        json: async () => ({}),
        text: async () => 'provider rejected the request',
      } as Response;
    }));

    const fal = new FalProvider();
    fal.configure('fal-key');
    setGenerationProviders([fal]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function completeMessages(): string[] {
    return win.webContents.send.mock.calls
      .filter(([channel]) => channel === 'generation:complete')
      .map(([, payload]) => (payload as GenerationResult).error ?? '');
  }

  /** Waits for the settled completion event; the adapter reads the file first. */
  async function settle(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      if (win.webContents.send.mock.calls.some(([channel]) => channel === 'generation:complete')) {
        return;
      }
    }
  }

  async function start(request: Record<string, unknown>): Promise<void> {
    await handler('generation:start')({ sender: { id: 7 } }, {
      type: 'image',
      prompt: 'the same harbour at night',
      provider: 'fal',
      ...request,
    });
    await settle();
  }

  it('sends a data URI in the outbound request, not the local path', async () => {
    await start({ referenceImagePath: referencePath });

    expect(bodies).toHaveLength(1);
    const payload = JSON.parse(bodies[0]!) as { image_url?: string };
    expect(payload.image_url).toBe(DATA_URI);
    expect(bodies[0]).not.toContain(referencePath);
  });

  it('sends a request without an image field when no reference is attached', async () => {
    await start({});

    expect(bodies).toEqual(['{"prompt":"the same harbour at night"}']);
  });

  it('refuses an unreadable reference before the provider is called', async () => {
    await start({ referenceImagePath: path.join(tmpDir, 'gone.png') });

    expect(bodies).toHaveLength(0);
    expect(completeMessages().join('\n')).toMatch(/Reference image not found/);
  });

  it('refuses a non-image reference before the provider is called', async () => {
    const notes = path.join(tmpDir, 'notes.txt');
    await fs.writeFile(notes, 'not an image');

    await start({ referenceImagePath: notes });

    expect(bodies).toHaveLength(0);
    expect(completeMessages().join('\n'))
      .toMatch(/is not one of \.png, \.jpg, \.jpeg, \.webp, \.gif, \.bmp/);
  });

  it('refuses an oversized reference before the provider is called', async () => {
    const huge = path.join(tmpDir, 'huge.png');
    await fs.writeFile(huge, Buffer.alloc(8 * 1024 * 1024 + 1));

    await start({ referenceImagePath: huge });

    expect(bodies).toHaveLength(0);
    expect(completeMessages().join('\n')).toMatch(/the cap is 8 MB/);
  });

  it('refuses a reference on a video request instead of dropping it', async () => {
    await start({ type: 'video', durationSeconds: 5, referenceImagePath: referencePath });

    expect(bodies).toHaveLength(0);
    expect(completeMessages().join('\n')).toMatch(/generates video from text only.*would be ignored/s);
  });
});
