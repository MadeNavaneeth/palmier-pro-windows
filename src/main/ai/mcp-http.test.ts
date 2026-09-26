/**
 * Live coverage for the loopback HTTP MCP endpoint (#302/#532): real HTTP
 * against a real listener, a plain EditorController, and the v2 handler.
 * Verifies auth, routing, both protocol eras, the 2026-07-28 refusal ladder,
 * and that the full tool surface is listed and callable.
 *
 * Era map (verified against `@modelcontextprotocol/server` 2.0.0 itself):
 * - modern (2026-07-28): no `initialize` handshake. Every request carries a
 *   `_meta` envelope claim (`protocolVersion` + `clientInfo` +
 *   `clientCapabilities`) and the `Mcp-Method` header (plus `Mcp-Name` for
 *   `tools/call`); `MCP-Protocol-Version`, when present, must agree with the
 *   envelope. Discovery is a `server/discover` call. Served as plain JSON.
 * - legacy (2025-11-25 and older): the `initialize` handshake and plain
 *   JSON-RPC bodies with no envelope, served statelessly as SSE streams.
 *
 * The revision constants come from the v2 package rather than string
 * literals. Hard-coding one is how this row went stale before: the test
 * pinned `2024-11-05`, so nothing noticed the SDK had moved on.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import { createMcpHttpServer, type McpHttpHandle } from './mcp-http';
import { resolveMcpController } from './mcp-session';
import { toolsToJsonSchema } from './tools';
import { createSession, markSessionActive, resetSessions } from '../sessions';
import { EditorController } from '../../shared/editor/controller';

let handle: McpHttpHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
});

const MODERN_REVISION = '2026-07-28';
const OLDEST_SUPPORTED = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

function init(protocolVersion: string = LATEST_PROTOCOL_VERSION) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0' },
    },
  };
}

/** Per-request 2026-07-28 envelope claim (all three keys are required). */
function envelope(protocolVersion: string = MODERN_REVISION) {
  return {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': protocolVersion,
      'io.modelcontextprotocol/clientInfo': { name: 'vitest', version: '0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  };
}

/** Standard headers for a modern request; omit `name` for nameless methods. */
function modernHeaders(method: string, name?: string, version: string = MODERN_REVISION) {
  return {
    'mcp-protocol-version': version,
    'mcp-method': method,
    ...(name === undefined ? {} : { 'mcp-name': name }),
  };
}

async function post(
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
  path = '/mcp',
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Read one JSON-RPC exchange regardless of era framing: modern answers are
 * plain JSON, legacy stateless answers are SSE `data:` frames.
 */
async function readExchange(res: Response): Promise<unknown[]> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice('data:'.length).trim()));
  }
  return [JSON.parse(text)];
}

async function boot(): Promise<number> {
  handle = await createMcpHttpServer({
    controller: new EditorController(),
    token: 'test-token',
    port: 0,
  });
  return handle.port;
}

describe('loopback HTTP MCP endpoint', () => {
  it('advertises 2026-07-28 via server/discover (no handshake)', async () => {
    const port = await boot();
    const res = await post(
      port,
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: envelope() },
      { authorization: 'Bearer test-token', ...modernHeaders('server/discover') },
    );

    expect(res.status).toBe(200);
    const [body] = await readExchange(res) as [{
      result?: { supportedVersions?: string[]; _meta?: { 'io.modelcontextprotocol/serverInfo'?: { name?: string } } };
    }];
    expect(body.result?.supportedVersions).toContain(MODERN_REVISION);
    expect(body.result?._meta?.['io.modelcontextprotocol/serverInfo']?.name).toBe('palmier-pro-windows');
  });

  it('lists the full tool surface over 2026-07-28 and round-trips a call', async () => {
    const port = await boot();
    const expectedNames = toolsToJsonSchema().map((tool) => tool.name);

    const list = await post(
      port,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: envelope() },
      { authorization: 'Bearer test-token', ...modernHeaders('tools/list') },
    );
    expect(list.status).toBe(200);
    const [listBody] = await readExchange(list) as [{ result?: { tools?: { name?: string; inputSchema?: unknown }[] } }];
    const names = (listBody.result?.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual(expectedNames);
    expect(names).toContain('get_timeline');
    const getTimeline = listBody.result?.tools?.find((tool) => tool.name === 'get_timeline');
    expect(getTimeline?.inputSchema).toEqual(
      toolsToJsonSchema().find((tool) => tool.name === 'get_timeline')?.inputSchema,
    );

    const call = await post(
      port,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_timeline', arguments: {}, ...envelope() },
      },
      { authorization: 'Bearer test-token', ...modernHeaders('tools/call', 'get_timeline') },
    );
    expect(call.status).toBe(200);
    const [callBody] = await readExchange(call) as [{
      result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
    }];
    expect(callBody.result?.isError).toBeFalsy();
    const text = callBody.result?.content?.find((block) => block.type === 'text')?.text ?? '';
    expect((JSON.parse(text) as { success?: boolean }).success).toBe(true);
  });

  it('surfaces executor validation failures as isError tool results, not transport errors', async () => {
    const port = await boot();
    const call = await post(
      port,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'remove_clip', arguments: {}, ...envelope() },
      },
      { authorization: 'Bearer test-token', ...modernHeaders('tools/call', 'remove_clip') },
    );
    expect(call.status).toBe(200);
    const [body] = await readExchange(call) as [{
      result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
    }];
    expect(body.result?.isError).toBe(true);
  });

  it('refuses modern requests precisely where 2026-07-28 refuses them', async () => {
    const port = await boot();
    const auth = { authorization: 'Bearer test-token' };
    const listBody = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: envelope() };

    // Mcp-Method is required on every modern request.
    const missingMethod = await post(port, listBody, auth);
    expect(missingMethod.status).toBe(400);

    // A method header that disagrees with the body is a 400, not a dispatch.
    const mismatch = await post(port, listBody, {
      ...auth,
      ...modernHeaders('tools/call'),
    });
    expect(mismatch.status).toBe(400);

    // tools/call mirrors params.name into Mcp-Name; absent is a refusal.
    const callBody = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_timeline', arguments: {}, ...envelope() },
    };
    const missingName = await post(port, callBody, {
      ...auth,
      'mcp-protocol-version': MODERN_REVISION,
      'mcp-method': 'tools/call',
    });
    expect(missingName.status).toBe(400);

    // An envelope naming an unknown revision is answered with the supported
    // set, not served and not silently downgraded. The version header agrees
    // with the envelope here, so the refusal is unsupported-version (-32022)
    // rather than header/body disagreement (-32020).
    const unknown = await post(port,
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: envelope('1999-01-01') },
      { ...auth, ...modernHeaders('tools/list', undefined, '1999-01-01') },
    );
    expect(unknown.status).toBe(400);
    const [unknownBody] = await readExchange(unknown) as [{
      error?: { code?: number; data?: { supported?: string[]; requested?: string } };
    }];
    expect(unknownBody.error?.code).toBe(-32022);
    expect(unknownBody.error?.data?.supported).toContain(MODERN_REVISION);
    expect(unknownBody.error?.data?.requested).toBe('1999-01-01');

    // A malformed envelope (missing clientCapabilities) is a 400.
    const malformed = await post(port,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_REVISION } },
      },
      { ...auth, ...modernHeaders('tools/list') },
    );
    expect(malformed.status).toBe(400);

    // initialize is gone on the modern era: an enveloped handshake is not a
    // handshake at all and is refused as an unknown method.
    const envelopedInit = await post(port,
      { ...init(), params: { ...init().params, ...envelope() } },
      { ...auth, ...modernHeaders('initialize') },
    );
    expect(envelopedInit.status).toBe(404);
  });

  it('keeps serving the 2025-era handshake statelessly (initialize negotiates, headers enforced)', async () => {
    const port = await boot();
    const auth = { authorization: 'Bearer test-token' };

    const newest = await post(port, init(LATEST_PROTOCOL_VERSION), auth);
    expect(newest.status).toBe(200);
    const [newestBody] = await readExchange(newest) as [{ result?: { protocolVersion?: string } }];
    expect(newestBody.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);

    const older = await post(port, init(OLDEST_SUPPORTED), auth);
    const [olderBody] = await readExchange(older) as [{ result?: { protocolVersion?: string } }];
    expect(olderBody.result?.protocolVersion).toBe(OLDEST_SUPPORTED);

    // An unknown revision is answered with the newest legacy one rather than
    // failing the handshake: the spec puts the hard rejection on the header
    // of later requests, not on initialize.
    const unknown = await post(port, init('1999-01-01'), auth);
    expect(unknown.status).toBe(200);
    const [unknownBody] = await readExchange(unknown) as [{ result?: { protocolVersion?: string } }];
    expect(unknownBody.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);

    const listBody = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
    const bad = await post(port, listBody, {
      ...auth,
      'mcp-protocol-version': '1999-01-01',
    });
    expect(bad.status).toBe(400);

    // Absent header is allowed (a stateless server has nothing to look up and
    // falls back to the default revision), and a supported one resolves tools.
    const absent = await post(port, listBody, auth);
    expect(absent.status).toBe(200);

    const supported = await post(port, listBody, {
      ...auth,
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
    });
    expect(supported.status).toBe(200);
    const [supportedBody] = await readExchange(supported) as [{ result?: { tools?: { name?: string }[] } }];
    expect(supportedBody.result?.tools?.some((tool) => tool.name === 'get_timeline')).toBe(true);
  });

  it('rejects missing, wrong, and malformed tokens', async () => {
    const port = await boot();

    expect((await post(port, init())).status).toBe(401);
    expect((await post(port, init(), { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post(port, init(), { authorization: 'test-token' })).status).toBe(401);
  });

  it('rejects non-POST methods and unknown paths', async () => {
    const port = await boot();

    const get = await fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(get.status).toBe(405);

    const wrongPath = await post(port, init(), { authorization: 'Bearer test-token' }, '/other');
    expect(wrongPath.status).toBe(405);
  });

  it('rejects an invalid JSON body with 400', async () => {
    const port = await boot();

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-token',
      },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('resolves an ephemeral port and stops cleanly', async () => {
    const created = await createMcpHttpServer({
      controller: new EditorController(),
      token: 'test-token',
      port: 0,
    });
    expect(created.port).toBeGreaterThan(0);
    await created.close();
    // After close the socket no longer accepts connections.
    await expect(
      fetch(`http://127.0.0.1:${created.port}/mcp`, { method: 'POST', body: '{}' }),
    ).rejects.toThrow();
  });
});

describe('session-routed endpoint (#137 Slice 2)', () => {
  beforeEach(() => resetSessions());
  afterEach(() => resetSessions());

  /** One session each, with media only its own controller can see. */
  function bootWithSessions() {
    const a = createSession();
    const b = createSession(); // minted last → active
    a.controller.addMedia({
      id: 'a1', path: 'C:\\media\\alpha.mp4', filename: 'alpha.mp4',
      type: 'video', duration: 30, fileSize: 1, addedAt: '2026-09-01T00:00:00.000Z',
    });
    b.controller.addMedia({
      id: 'b1', path: 'C:\\media\\beta.mp4', filename: 'beta.mp4',
      type: 'video', duration: 30, fileSize: 1, addedAt: '2026-09-01T00:00:00.000Z',
    });
    return { a, b };
  }

  async function callGetMedia(port: number, sessionId?: string): Promise<Response> {
    return post(
      port,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_media', arguments: {}, ...envelope() },
      },
      {
        authorization: 'Bearer test-token',
        ...modernHeaders('tools/call', 'get_media'),
        ...(sessionId === undefined ? {} : { 'x-palmier-session': sessionId }),
      },
    );
  }

  /** Filenames the get_media call could see — i.e. which controller it hit. */
  async function mediaFilenames(res: Response): Promise<string[]> {
    const [body] = await readExchange(res) as [{
      result?: { content?: { type?: string; text?: string }[] };
    }];
    const text = body.result?.content?.find((block) => block.type === 'text')?.text ?? '';
    const parsed = JSON.parse(text) as { data?: { filename?: string }[] };
    return (parsed.data ?? []).map((asset) => asset.filename ?? '');
  }

  it('routes a request to the session the header names', async () => {
    const { a, b } = bootWithSessions();
    handle = await createMcpHttpServer({
      controller: new EditorController(),
      resolveController: resolveMcpController,
      token: 'test-token',
      port: 0,
    });

    expect(await mediaFilenames(await callGetMedia(handle.port, a.id))).toEqual(['alpha.mp4']);
    expect(await mediaFilenames(await callGetMedia(handle.port, b.id))).toEqual(['beta.mp4']);
  });

  it('defaults to the active session when the header is absent', async () => {
    const { a } = bootWithSessions();
    handle = await createMcpHttpServer({
      controller: new EditorController(),
      resolveController: resolveMcpController,
      token: 'test-token',
      port: 0,
    });

    // b was minted last, so it starts active; focusing a retargets.
    expect(await mediaFilenames(await callGetMedia(handle.port))).toEqual(['beta.mp4']);
    markSessionActive(a.id);
    expect(await mediaFilenames(await callGetMedia(handle.port))).toEqual(['alpha.mp4']);
  });

  it('refuses an unknown explicit session id with 404', async () => {
    bootWithSessions();
    handle = await createMcpHttpServer({
      controller: new EditorController(),
      resolveController: resolveMcpController,
      token: 'test-token',
      port: 0,
    });

    const res = await callGetMedia(handle.port, 'not-a-session');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Unknown session.' });
  });

  it('keeps one fixed controller when no resolver is configured (windowless mode)', async () => {
    const standalone = new EditorController();
    standalone.addMedia({
      id: 's1', path: 'C:\\media\\gamma.mp4', filename: 'gamma.mp4',
      type: 'video', duration: 30, fileSize: 1, addedAt: '2026-09-01T00:00:00.000Z',
    });
    handle = await createMcpHttpServer({
      controller: standalone,
      token: 'test-token',
      port: 0,
    });

    // Even with the header present, no resolver means the fixed controller —
    // the windowless `--mcp-server` mode never learns about GUI sessions.
    expect(await mediaFilenames(await callGetMedia(handle.port, 'any-session')))
      .toEqual(['gamma.mp4']);
  });
});
