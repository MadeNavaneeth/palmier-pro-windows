/**
 * Embedded MCP Server — exposes editor tools over stdio
 * for Claude Code, Cursor, and Claude Desktop.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { toolsToJsonSchema } from './tools';
import { ToolExecutor } from './executor';
import type { EditorController } from '../../shared/editor/controller';

export class PalmierMcpServer {
  private server: Server;
  private executor: ToolExecutor;
  private running = false;

  constructor(editor: EditorController) {
    this.executor = new ToolExecutor(editor);
    this.server = new Server(
      { name: 'palmier-pro-windows', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async () => ({ tools: toolsToJsonSchema() }),
    );

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request) => {
        const { name, arguments: args } = request.params;
        const result = await this.executor.execute(
          name,
          (args || {}) as Record<string, unknown>,
        );
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
          isError: !result.success,
        };
      },
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await this.server.close();
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }
}

/**
 * Generate the MCP configuration JSON that users paste into
 * Claude Code / Cursor / Claude Desktop settings.
 */
export function generateMcpConfig(appPath: string): string {
  const config = {
    mcpServers: {
      'palmier-pro': {
        command: 'node',
        args: [appPath, '--mcp'],
        env: {},
      },
    },
  };
  return JSON.stringify(config, null, 2);
}
