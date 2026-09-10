import { describe, expect, it } from 'vitest';
import { mcpHttpConfig } from './mcp-server';

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
