/**
 * Loopback HTTP MCP endpoint (upstream #302 / #532's remote-client story).
 *
 * External MCP clients cannot receive stdio from an Electron main process on
 * Windows — the OS closes the spawned process's stdin immediately (verified
 * with a probe) — so the server instead listens on 127.0.0.1 and clients
 * connect over the standard Streamable HTTP transport.
 *
 * Security contract (the disposition recorded for upstream #122):
 * - bound to loopback only; a request whose peer is not loopback is refused
 *   even if it somehow arrives;
 * - every request must carry `Authorization: Bearer <token>`, compared in
 *   constant time;
 * - stateless JSON responses: no session ids, one fresh MCP server per
 *   request, so a client restart cannot leave a stuck session behind.
 *
 * The module is Electron-free so the transport can be unit-tested against a
 * real HTTP server with a plain EditorController.
 */

import http from 'http';
import { timingSafeEqual } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp-server';
import type { ToolExecutorDeps } from './executor';
import type { EditorController } from '../../shared/editor/controller';

export interface McpHttpOptions {
  controller: EditorController;
  token: string;
  /** 0 asks the OS for an ephemeral port (used by tests). */
  port: number;
  deps?: ToolExecutorDeps;
}

export interface McpHttpHandle {
  /** The actual bound port (the requested one, or the ephemeral fallback). */
  readonly port: number;
  close(): Promise<void>;
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

/** Constant-time bearer comparison; length mismatch is still a rejection. */
function authorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`, 'utf8');
  if (typeof header !== 'string') return false;
  const actual = Buffer.from(header, 'utf8');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    // 4 MB is far beyond any tool call this server accepts; refuse rather
    // than buffer an unbounded stream from a misbehaving client.
    if (size > 4 * 1024 * 1024) throw new Error('Request body too large.');
    chunks.push(buf);
  }
  if (size === 0) throw new Error('Empty request body.');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createMcpHttpServer(options: McpHttpOptions): Promise<McpHttpHandle> {
  const server = http.createServer((req, res) => {
    void (async () => {
      if (!isLoopback(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: 'Loopback clients only.' });
        return;
      }
      if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) {
        sendJson(res, 405, { error: 'Use POST /mcp.' });
        return;
      }
      if (!authorized(req.headers.authorization, options.token)) {
        sendJson(res, 401, { error: 'Missing or invalid bearer token.' });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid request body.' });
        return;
      }

      // Stateless mode: a fresh server+transport per request. The SDK's
      // stateless pattern forbids a session id generator, so nothing needs
      // cleanup between calls.
      const mcpServer = createMcpServer(options.controller, options.deps ?? {});
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close().catch(() => {});
        void mcpServer.close().catch(() => {});
      });
      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : 'MCP request failed.' });
        }
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      server.removeListener('error', reject);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            // Drop keep-alive sockets first: otherwise close() waits on
            // connections that a harness may still be holding open, and the
            // process teardown races libuv.
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
