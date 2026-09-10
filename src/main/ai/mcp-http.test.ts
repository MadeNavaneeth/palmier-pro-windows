/**
 * Live coverage for the loopback HTTP MCP endpoint (#302/#532): real HTTP
 * against a real listener, a plain EditorController, and the SDK transport.
 * Verifies auth, routing, protocol-version negotiation, and that the MCP
 * handshake returns our tools.
 *
 * The revisions come from the SDK's own constants rather than string literals.
 * Hard-coding one is how this row went stale: the test pinned `2024-11-05`, so
 * nothing noticed that the SDK had moved on and the server was already
 * negotiating the newer revision.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { createMcpHttpServer, type McpHttpHandle } from './mcp-http';
import { EditorController } from '../../shared/editor/controller';

let handle: McpHttpHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
});

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

describe('loopback HTTP MCP endpoint', () => {
  it('completes the initialize handshake with a valid bearer token', async () => {
    handle = await createMcpHttpServer({
      controller: new EditorController(),
      token: 'test-token',
      port: 0,
    });

    const res = await post(handle.port, init(), { authorization: 'Bearer test-token' });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      result?: { serverInfo?: { name?: string }; capabilities?: unknown; protocolVersion?: string };
    };
    expect(body.result?.serverInfo?.name).toBe('palmier-pro-windows');
    expect(body.result?.capabilities).toBeDefined();
  });

  it('negotiates the newest revision the SDK supports, and older ones on request', async () => {
    handle = await createMcpHttpServer({
      controller: new EditorController(),
      token: 'test-token',
      port: 0,
    });

    const newest = await post(handle.port, init(LATEST_PROTOCOL_VERSION), { authorization: 'Bearer test-token' });
    const newestBody = await newest.json() as { result?: { protocolVersion?: string } };
    expect(newestBody.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);

    const older = await post(handle.port, init(OLDEST_SUPPORTED), { authorization: 'Bearer test-token' });
    const olderBody = await older.json() as { result?: { protocolVersion?: string } };
    expect(olderBody.result?.protocolVersion).toBe(OLDEST_SUPPORTED);

    // An unknown revision is answered with the newest one we speak rather than
    // failing the handshake: the spec puts the hard rejection on the header of
    // later requests, not on initialize.
    const unknown = await post(handle.port, init('1999-01-01'), { authorization: 'Bearer test-token' });
    expect(unknown.status).toBe(200);
    const unknownBody = await unknown.json() as { result?: { protocolVersion?: string } };
    expect(unknownBody.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('rejects an unsupported protocol-version header on later requests', async () => {
    handle = await createMcpHttpServer({
      controller: new EditorController(),
      token: 'test-token',
      port: 0,
    });
    const listBody = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

    const bad = await post(handle.port, listBody, {
      authorization: 'Bearer test-token',
      'mcp-protocol-version': '1999-01-01',
    });
    expect(bad.status).toBe(400);

    // Absent header is allowed (a stateless server has nothing to look up and
    // falls back to the default revision), and a supported one resolves tools.
    const absent = await post(handle.port, listBody, { authorization: 'Bearer test-token' });
    expect(absent.status).toBe(200);

    const supported = await post(handle.port, listBody, {
      authorization: 'Bearer test-token',
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
    });
    expect(supported.status).toBe(200);
    const supportedBody = await supported.json() as { result?: { tools?: { name?: string }[] } };
    expect(supportedBody.result?.tools?.some((tool) => tool.name === 'get_timeline')).toBe(true);
  });

  it('rejects missing, wrong, and malformed tokens', async () => {
    handle = await createMcpHttpServer({
      controller: new EditorController(),
      token: 'test-token',
      port: 0,
    });

    expect((await post(handle.port, init())).status).toBe(401);
    expect((await post(handle.port, init(), { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post(handle.port, init(), { authorization: 'test-token' })).status).toBe(401);
  });

  it('rejects non-POST methods and unknown paths', async () => {
    handle = await createMcpHttpServer({
      controller: new EditorController(),
      token: 'test-token',
      port: 0,
    });

    const get = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(get.status).toBe(405);

    const wrongPath = await post(handle.port, init(), { authorization: 'Bearer test-token' }, '/other');
    expect(wrongPath.status).toBe(405);
  });

  it('rejects an invalid JSON body with 400', async () => {
    handle = await createMcpHttpServer({
      controller: new EditorController(),
      token: 'test-token',
      port: 0,
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
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
