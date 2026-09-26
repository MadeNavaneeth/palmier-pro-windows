import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isReadOnlyTool, tools, toolsToJsonSchema } from './tools';
import { buildEdgeGeqExpr } from '../../shared/editor/edge-effects';

type JsonSchema = Record<string, unknown>;

function toolSchema(name: string): JsonSchema {
  const discovered = toolsToJsonSchema().find((tool) => tool.name === name);
  if (!discovered) throw new Error(`Missing discovered tool: ${name}`);
  return discovered.inputSchema;
}

function objectProperties(schema: JsonSchema): Record<string, JsonSchema> {
  return schema.properties as Record<string, JsonSchema>;
}

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

describe('opacity keyframe tool contract', () => {
  it('publishes the nested point schema and remains a mutating tool', () => {
    const discovered = toolsToJsonSchema().find((tool) => tool.name === 'set_clip_opacity_keyframes');
    expect(discovered?.description).toContain('absolute timeline-frame');
    expect(discovered?.inputSchema).toMatchObject({
      type: 'object',
      required: ['clipId', 'points'],
      properties: {
        clipId: { type: 'string' },
        points: {
          type: 'array',
          items: {
            type: 'object',
            required: ['frame', 'value'],
            properties: {
              frame: { type: 'number' },
              value: { type: 'number' },
              easing: { type: 'string', enum: ['linear', 'easeIn', 'easeOut', 'easeInOut'], optional: true },
            },
          },
        },
      },
    });
    expect(isReadOnlyTool('set_clip_opacity_keyframes')).toBe(false);
  });

  it('validates the clear form and rejects malformed points at the schema boundary', () => {
    const parameters = tools.setClipOpacityKeyframes.parameters;
    expect(parameters.safeParse({ clipId: 'clip-1', points: [] }).success).toBe(true);
    expect(parameters.safeParse({ clipId: 'clip-1', points: [{ frame: 0, value: 0 }, { frame: 30, value: 1 }] }).success).toBe(true);
    expect(parameters.safeParse({ clipId: 'clip-1', points: [{ frame: 0, value: 2 }, { frame: 30, value: 1 }] }).success).toBe(false);
    expect(parameters.safeParse({ clipId: 'clip-1', points: [{ frame: 0, value: Number.NaN }, { frame: 30, value: 1 }] }).success).toBe(false);
    expect(parameters.safeParse({ clipId: 'clip-1', points: 'not-an-array' }).success).toBe(false);
  });
});

describe('generation tool contract', () => {
  it('publishes the optional reference image and keeps it optional', () => {
    const generation = objectProperties(toolSchema('generate_media'));
    expect(generation.referenceImagePath).toMatchObject({ type: 'string', optional: true });
    expect(generation.referenceImagePath.description).toContain('refused for video and audio');
    expect(toolSchema('generate_media').required).toEqual(['type', 'prompt']);

    const parameters = tools.generateMedia.parameters;
    expect(parameters.safeParse({ type: 'image', prompt: 'a harbour' }).success).toBe(true);
    expect(parameters.safeParse({
      type: 'image', prompt: 'a harbour', referenceImagePath: 'C:/refs/still.png',
    }).success).toBe(true);
    expect(parameters.safeParse({
      type: 'image', prompt: 'a harbour', referenceImagePath: '',
    }).success).toBe(false);
  });
});

describe('tool discovery schema conversion', () => {
  it('publishes nested color wheels as objects with numeric components', () => {
    const grade = objectProperties(toolSchema('set_clip_color_grade'));
    const wheels = grade.wheels;

    expect(wheels.type).toBe('object');
    expect(wheels.description).toContain('Color wheels');
    const wheelProperties = objectProperties(wheels);
    for (const zoneName of ['lift', 'gamma', 'gain']) {
      const zone = wheelProperties[zoneName];
      expect(zone.type).toBe('object');
      const zoneProperties = objectProperties(zone);
      for (const component of ['x', 'y', 'm']) {
        expect(zoneProperties[component]).toMatchObject({ type: 'number' });
      }
    }
  });

  it('publishes nested hue curves, vignette, grain, and glow schemas', () => {
    const grade = objectProperties(toolSchema('set_clip_color_grade'));

    const hueCurves = objectProperties(grade.hueCurves);
    for (const channelName of ['hueVsHue', 'hueVsSat', 'hueVsLum']) {
      expect(hueCurves[channelName]).toMatchObject({
        type: 'array',
        items: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
        },
      });
    }

    expect(grade.vignette).toMatchObject({
      type: 'object',
      properties: {
        amount: { type: 'number' },
        midpoint: { type: 'number' },
        roundness: { type: 'number' },
        feather: { type: 'number' },
      },
    });
    expect(grade.grain).toMatchObject({
      type: 'object',
      properties: { amount: { type: 'number' }, size: { type: 'number' } },
    });
    expect(grade.glow).toMatchObject({
      type: 'object',
      properties: {
        intensity: { type: 'number' },
        radius: { type: 'number' },
        threshold: { type: 'number' },
        warmth: { type: 'number' },
      },
    });
  });

  it('derives required fields through nested optional and default wrappers', () => {
    const gradeSchema = toolSchema('set_clip_color_grade');
    const grade = objectProperties(gradeSchema);
    const wheels = grade.wheels;
    const wheelProperties = objectProperties(wheels);

    expect(wheels.required).toBeUndefined();
    expect(wheelProperties.lift.required).toBeUndefined();
    expect(wheelProperties.gamma.required).toBeUndefined();
    expect(wheelProperties.gain.required).toBeUndefined();
    expect(objectProperties(wheelProperties.lift).x.optional).toBe(true);

    const hueChannel = objectProperties(grade.hueCurves).hueVsHue;
    expect((hueChannel.items as JsonSchema).required).toEqual(['x', 'y']);
    expect(gradeSchema.required).toEqual(['clipId']);

    const exportProject = objectProperties(toolSchema('export_project'));
    expect(exportProject.format.type).toBe('string');
    expect(exportProject.format.optional).toBeUndefined();
    expect(exportProject.quality.type).toBe('string');
    expect(exportProject.quality.optional).toBeUndefined();
    expect(toolSchema('export_project').required).toEqual(['outputPath']);
  });

  it('bounds deep and cyclic plugin schemas without breaking discovery', () => {
    const cyclicShape: Record<string, z.ZodTypeAny> = {};
    const cyclic = z.object(cyclicShape);
    cyclicShape.self = cyclic;

    let deep: z.ZodTypeAny = z.string();
    for (let index = 0; index < 20; index += 1) {
      deep = z.object({ value: deep });
    }

    const mutableTool = tools.getMedia as unknown as { parameters: z.ZodTypeAny };
    const original = mutableTool.parameters;
    try {
      mutableTool.parameters = z.object({
        deep,
        unsupported: z.map(z.string(), z.string()),
        cyclic,
      });

      expect(() => toolsToJsonSchema()).not.toThrow();
      const properties = objectProperties(toolSchema('get_media'));
      expect(properties.unsupported).toMatchObject({ type: 'string' });
      expect(properties.cyclic).toMatchObject({
        type: 'object',
        properties: { self: { type: 'string' } },
      });

      let deepNode: unknown = properties.deep;
      for (let index = 0; index < 25; index += 1) {
        if (typeof deepNode !== 'object' || deepNode === null) break;
        const node = deepNode as JsonSchema;
        if (node.type === 'string') break;
        deepNode = node.properties && (node.properties as Record<string, unknown>).value;
      }
      expect(deepNode).toMatchObject({ type: 'string' });
    } finally {
      mutableTool.parameters = original;
    }
  });
});

describe('export_project description claims', () => {
  const description = tools.exportProject.description;

  it('no longer promises parity the tool does not deliver', () => {
    // The exporter IS shared with the delivery panel — grade, effects, and
    // eligibility really are identical. The lie was the word "identical"
    // covering a list that silently included baked shape/title layers.
    expect(description).not.toMatch(/identical/i);
    expect(description).not.toMatch(/eligibility rules/i);
  });

  it('names the two layer types it cannot render, and where the loss is reported', () => {
    expect(description).toMatch(/SHAPE clips are left out/i);
    expect(description).toMatch(/ADVANCED TITLES/);
    expect(description).toMatch(/inverted/);
    expect(description).toMatch(/variable-font axes/);
    expect(description).toMatch(/warnings/);
    expect(description).toMatch(/delivery panel/);
  });

  it('keeps the claims that are true: shared pipeline and the HDR profile', () => {
    expect(description).toMatch(/same exporter the delivery panel uses/);
    expect(description).toMatch(/hdr "hlg" or "pq"/);
  });
});
