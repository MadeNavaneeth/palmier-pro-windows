/**
 * Live coverage for the loopback HTTP MCP endpoint (#302/#532): real HTTP
 * against a real listener, a plain EditorController, and the SDK transport.
 * Verifies auth, routing, and that the MCP handshake returns our tools.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createMcpHttpServer, type McpHttpHandle } from './mcp-http';
import { EditorController } from '../../shared/editor/controller';

let handle: McpHttpHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
});

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '0' },
  },
};

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

    const res = await post(handle.port, INIT, { authorization: 'Bearer test-token' });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      result?: { serverInfo?: { name?: string }; capabilities?: unknown };
    };
    expect(body.result?.serverInfo?.name).toBe('palmier-pro-windows');
    expect(body.result?.capabilities).toBeDefined();
  });

  it('rejects missing, wrong, and malformed tokens', async () => {
    handle = await createMcpHttpServer({
      controller: new EditorController(),
      token: 'test-token',
      port: 0,
    });

    expect((await post(handle.port, INIT)).status).toBe(401);
    expect((await post(handle.port, INIT, { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post(handle.port, INIT, { authorization: 'test-token' })).status).toBe(401);
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

    const wrongPath = await post(handle.port, INIT, { authorization: 'Bearer test-token' }, '/other');
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
