/**
 * Loopback HTTP MCP endpoint (upstream #302 / #532's remote-client story).
 *
 * External MCP clients cannot receive stdio from an Electron main process on
 * Windows — the OS closes the spawned process's stdin immediately (verified
 * with a probe) — so the server instead listens on 127.0.0.1 and clients
 * connect over Streamable HTTP.
 *
 * Security contract (the disposition recorded for upstream #122):
 * - bound to loopback only; a request whose peer is not loopback is refused
 *   even if it somehow arrives;
 * - every request must carry `Authorization: Bearer <token>`, compared in
 *   constant time;
 * - stateless JSON responses: no session ids, one fresh MCP server per
 *   request, so a client restart cannot leave a stuck session behind.
 *
 * Protocol (upstream #532): served by `createMcpHandler` from
 * `@modelcontextprotocol/server` v2, which speaks 2026-07-28 per request
 * (no `initialize` handshake — per-request version envelope plus
 * `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` headers, advertised via
 * `server/discover`) and keeps serving 2025-era clients statelessly from the
 * same factory. The handler performs no token verification itself, so the
 * bearer check below stays in front of it.
 *
 * Session routing (upstream #137, Slice 2): one listener per process, but the
 * editor each request's tools act on is resolved per request. An optional
 * `X-Palmier-Session: <id>` header targets that session exactly (an unknown
 * id is refused with 404 before the body is read — falling back would run
 * edits against the wrong workspace); no header resolves the active session.
 * Without `resolveController` (windowless `--mcp-server` mode) the header is
 * inert and every request uses the fixed `controller`.
 *
 * The module is Electron-free so the transport can be unit-tested against a
 * real HTTP server with a plain EditorController.
 */

import http from 'http';
import { timingSafeEqual } from 'crypto';
import { createMcpHandler, type McpHttpHandler, type McpRequestContext } from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import { createMcpServer } from './mcp-server';
import type { ToolExecutorDeps } from './executor';
import type { EditorController } from '../../shared/editor/controller';

/** Optional per-request session target (#137). Absent means the active session. */
const SESSION_HEADER = 'x-palmier-session';

export interface McpHttpOptions {
  /**
   * Fixed binding for every request when no `resolveController` is given
   * (windowless mode), and the last resort when no session resolves.
   */
  controller: EditorController;
  /**
   * Per-request session binding (#137 Slice 2). `null` means "no explicit
   * target — resolve the active session"; a non-null id must resolve exactly
   * that session or the request is refused. Absent (windowless `--mcp-server`)
   * keeps the fixed `controller` for every request.
   */
  resolveController?: (sessionId: string | null) => EditorController | null;
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

/** The explicit session target of one request; null means the active session. */
function requestedSessionId(raw: string | null | undefined): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
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
  // One handler for the listener's lifetime: the factory builds a fresh MCP
  // server per request (the stateless contract), so the handler itself holds
  // no per-request state between exchanges. The factory receives the original
  // Request, so each request's session target is read from its own headers —
  // concurrent requests cannot race a shared binding (#137 Slice 2).
  const mcpHandler: McpHttpHandler = createMcpHandler((ctx: McpRequestContext) => {
    const sessionId = requestedSessionId(ctx.requestInfo?.headers.get(SESSION_HEADER));
    const controller = options.resolveController?.(sessionId) ?? options.controller;
    return createMcpServer(controller, options.deps ?? {});
  });
  const nodeHandler: NodeMcpRequestHandler = toNodeHandler(mcpHandler);

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
      // Refuse an unknown explicit session id before the body is read: a
      // silent fallback would run the caller's edits against the wrong
      // workspace (#137 Slice 2). Absent header is not checked here — the
      // factory falls back to the active session, then to `controller`.
      const rawSession = req.headers[SESSION_HEADER];
      const explicitSession = requestedSessionId(Array.isArray(rawSession) ? rawSession[0] : rawSession);
      if (
        options.resolveController
        && explicitSession !== null
        && !options.resolveController(explicitSession)
      ) {
        sendJson(res, 404, { error: 'Unknown session.' });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid request body.' });
        return;
      }

      try {
        // The body is already consumed above, so hand the parsed value over
        // rather than letting the adapter re-read a drained stream.
        await nodeHandler(req, res, body);
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
            server.close(() => {
              // Abort in-flight exchanges and release their per-request
              // instances; the stateless legacy serving holds nothing else.
              void mcpHandler.close().finally(() => done());
            });
          }),
      });
    });
  });
}
