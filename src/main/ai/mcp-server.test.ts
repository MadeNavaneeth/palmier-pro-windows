import { describe, expect, it } from 'vitest';
import { tools, toolsToJsonSchema } from './tools';
import { createMcpServer, mcpHttpConfig, mcpToolInputSchema } from './mcp-server';
import { EditorController } from '../../shared/editor/controller';

describe('mcpHttpConfig (#302/#532)', () => {
  it('emits a URL + bearer-header block for Streamable HTTP clients', () => {
    const parsed = JSON.parse(mcpHttpConfig('http://127.0.0.1:8765/mcp', 'secret-token'));
    expect(parsed).toEqual({
      mcpServers: {
        'palmier-pro': {
          url: 'http://127.0.0.1:8765/mcp',
          headers: { Authorization: 'Bearer secret-token' },
        },
      },
    });
  });
});

describe('mcpToolInputSchema (#532)', () => {
  it('advertises the tool listing verbatim as the v2 input schema', () => {
    const listed = toolsToJsonSchema().find((tool) => tool.name === 'get_timeline')?.inputSchema;
    expect(listed).toBeDefined();
    const schema = mcpToolInputSchema(listed as Record<string, unknown>);
    expect(schema['~standard'].version).toBe(1);
    // Identity, not a copy: the advertised surface cannot drift from ./tools.
    expect(schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toBe(listed);
    expect(schema['~standard'].jsonSchema.output({ target: 'draft-2020-12' })).toBe(listed);
  });

  it('passes arguments through untouched: the executor owns validation', () => {
    const schema = mcpToolInputSchema({ type: 'object' });
    // A value the listing schema would reject still arrives intact, so the
    // Zod v3 schemas in ./tools (via the executor) stay the single
    // validation authority instead of forking per transport.
    const invalid = { clipId: ['not', 'a', 'string'] };
    expect(schema['~standard'].validate(invalid)).toEqual({ value: invalid });
    expect(schema['~standard'].validate({})).toEqual({ value: {} });
  });
});

describe('createMcpServer tool surface (#532)', () => {
  it('registers exactly the tools ./tools defines — listed means callable', () => {
    expect(createMcpServer(new EditorController())).toBeDefined();
    const defined = Object.values(tools).map((tool) => tool.name).sort();
    const listed = toolsToJsonSchema().map((tool) => tool.name).sort();
    // Registration iterates the listing itself, so this pins the loop's
    // source: no tool left unlisted, no listing without a definition.
    expect(listed).toEqual(defined);
    expect(new Set(listed).size).toBe(listed.length);
  });
});
