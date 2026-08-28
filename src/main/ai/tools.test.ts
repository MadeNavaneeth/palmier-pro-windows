import { describe, expect, it } from 'vitest';
import { tools, toolsToJsonSchema } from './tools';
import { buildEdgeGeqExpr } from '../../shared/editor/edge-effects';

describe('edge effect tool contract', () => {
  it('publishes refined fields through tool discovery', () => {
    const discovered = toolsToJsonSchema().find((tool) => tool.name === 'set_clip_edge_effects');
    expect(discovered?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        edgeRounding: { type: 'number' },
        edgeSoftness: { type: 'number' },
      },
    });
  });

  it('rejects an empty edge effect request', () => {
    expect(tools.setClipEdgeEffects.parameters.safeParse({ clipId: 'clip-1' }).success).toBe(false);
    expect(tools.setClipEdgeEffects.parameters.safeParse({ clipId: 'clip-1', edgeRounding: 0 }).success).toBe(true);
  });

  it('keeps tiny positive softness out of a zero denominator', () => {
    const expression = buildEdgeGeqExpr(0, Number.MIN_VALUE, 1920, 1080);
    expect(expression).not.toContain('/0.0000');
    expect(expression).toContain('e-');
  });
});
