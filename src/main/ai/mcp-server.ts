/**
 * MCP server construction shared by every transport.
 *
 * The handler set is transport-agnostic: list the tools and run each call
 * through the same `ToolExecutor` the in-app agent and MCP HTTP endpoint
 * use, so there is exactly one validation/undo path.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { toolsToJsonSchema } from './tools';
import { ToolExecutor, type ToolExecutorDeps } from './executor';
import type { EditorController } from '../../shared/editor/controller';

export function createMcpServer(
  editor: EditorController,
  deps: ToolExecutorDeps = {},
): Server {
  const executor = new ToolExecutor(editor, deps);
  const server = new Server(
    { name: 'palmier-pro-windows', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async () => ({ tools: toolsToJsonSchema() }),
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => {
      const { name, arguments: args } = request.params;
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
