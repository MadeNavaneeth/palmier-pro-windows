/**
 * Coverage for the project digest reaching the model (Track 2, L4): the
 * system prompt for a turn carries a freshly derived summary of the
 * authoritative project, so a long session does not need a full timeline
 * dump to know what it is editing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { PalmierAgent, type StreamCallbacks } from './agent';

afterEach(() => {
  vi.unstubAllGlobals();
});

function recorder(): StreamCallbacks {
  return {
    onToken: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onComplete: () => {},
    onError: () => {},
    onCancelled: () => {},
  };
}

describe('agent project digest (L4)', () => {
  it('injects the derived digest into the OpenAI-compatible system message', async () => {
    const controller = new EditorController();
    controller.addMedia({
      id: 'a', path: 'C:/media/a.mp4', filename: 'a.mp4', type: 'video',
      duration: 300, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
    });
    controller.addClip({ assetId: 'a', trackId: 'v1', startFrame: 0, durationFrames: 60 });
    controller.changeTimelineMarkers({ creates: [{ name: 'Pickup', startFrame: 10 }] });

    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'Done.' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }));

    const agent = new PalmierAgent(controller);
    agent.configure({
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
    });

    await agent.chat('What is in this project?', recorder());

    const system = bodies[0].messages.find((message) => message.role === 'system');
    expect(system).toBeDefined();
    expect(system!.content).toContain('## Current project');
    expect(system!.content).toContain('Clips: 1 total');
    expect(system!.content).toContain('Markers: 1 (1 open, 0 in review)');
    expect(system!.content).toContain('Media: 1 assets');
  });

  it('re-derives the digest each turn rather than caching it', async () => {
    const controller = new EditorController();
    const fetchMock = vi.fn(
      async (_url: string, _init?: { body?: string }) =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const agent = new PalmierAgent(controller);
    agent.configure({
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
    });

    await agent.chat('first', recorder());
    controller.addMedia({
      id: 'b', path: 'C:/media/b.mp4', filename: 'b.mp4', type: 'video',
      duration: 300, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
    });
    await agent.chat('second', recorder());

    const systemPrompts = fetchMock.mock.calls.map((call) => {
      const body = JSON.parse(String((call[1] as { body?: string })?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      return body.messages.find((message) => message.role === 'system')?.content ?? '';
    });
    expect(systemPrompts[0]).toContain('Media: 0 assets');
    expect(systemPrompts[1]).toContain('Media: 1 assets');
  });
});
