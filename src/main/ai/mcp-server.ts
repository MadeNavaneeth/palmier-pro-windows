/**
 * MCP server construction shared by every transport.
 *
 * The handler set is transport-agnostic: list the tools and run each call
 * through the same `ToolExecutor` the in-app agent and MCP HTTP endpoint
 * use, so there is exactly one validation/undo path.
 *
 * Protocol note (upstream #532): the endpoint serves 2026-07-28 via
 * `createMcpHandler` (see `./mcp-http`), whose `registerTool` takes a
 * Standard Schema. The tool schemas in `./tools` stay Zod v3 — the in-app
 * agent and the executor validate against them directly — so each tool is
 * registered here behind a thin pass-through adapter: the adapter advertises
 * the tool's existing JSON Schema listing verbatim and hands incoming
 * arguments to the executor untouched, which performs the real Zod v3
 * validation. Upgrading the whole repo to Zod v4 for this boundary alone
 * would fork the contract (v4 registration schemas drifting from the v3
 * schemas the agent uses); the adapter keeps one validation authority.
 */

import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { toolsToJsonSchema } from './tools';
import { ToolExecutor, type ToolExecutorDeps } from './executor';
import type { EditorController } from '../../shared/editor/controller';

type McpToolArgs = Record<string, unknown>;

/**
 * Wrap an already-computed JSON Schema listing as a v2 input schema.
 *
 * Validation passes values through untouched (the `ToolExecutor` owns
 * validation with the Zod v3 schemas); `tools/list` serves the listing
 * object as-is, so the advertised surface cannot drift from `./tools`.
 */
export function mcpToolInputSchema(
  listed: Record<string, unknown>,
): StandardSchemaWithJSON<McpToolArgs, McpToolArgs> {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'palmier-pro-windows',
      validate: (value: unknown) => ({ value: value as McpToolArgs }),
      jsonSchema: {
        input: () => listed,
        output: () => listed,
      },
    },
  };
}

export function createMcpServer(
  editor: EditorController,
  deps: ToolExecutorDeps = {},
): McpServer {
  const executor = new ToolExecutor(editor, deps);
  const server = new McpServer(
    { name: 'palmier-pro-windows', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // Register from the listing itself so the served surface and the advertised
  // surface are the same array by construction — a tool cannot be listed
  // without being callable, or callable without being listed.
  for (const entry of toolsToJsonSchema()) {
    const name = entry.name;
    server.registerTool(
      name,
      {
        description: entry.description,
        inputSchema: mcpToolInputSchema(entry.inputSchema),
      },
      async (args) => {
        const result = await executor.execute(
          name,
          (args || {}) as Record<string, unknown>,
        );

        // inspect_frame (#565) attaches its PNG so vision-capable clients see
        // the frame directly instead of only receiving a path.
        const data = result.data as { imageBase64?: string } | undefined;
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
        if (data?.imageBase64) {
          content.push({ type: 'image', data: data.imageBase64, mimeType: 'image/png' });
          const { imageBase64: _stripped, ...withoutImage } = data;
          void _stripped;
          result.data = withoutImage as typeof result.data;
        }
        content.push({
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        });
        return { content, isError: !result.success };
      },
    );
  }

  return server;
}

/**
 * MCP client configuration for the loopback HTTP endpoint.
 *
 * `url` + `headers` is the shape Cursor, Claude Code `.mcp.json`, and other
 * Streamable-HTTP-capable clients accept; the token is a bearer credential
 * scoped to 127.0.0.1.
 */
export function mcpHttpConfig(url: string, token: string): string {
  const config = {
    mcpServers: {
      'palmier-pro': {
        url,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}
