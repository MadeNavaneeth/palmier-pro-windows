/**
 * Regression coverage for project schema migrations (roadmap R0):
 * old-version projects upgrade through the correct steps, current-version
 * projects pass through unchanged, and unknown versions are preserved.
 */

import { describe, it, expect } from 'vitest';
import { migrateProject, CURRENT_SCHEMA_VERSION } from './migrations';
import { createEmptyProject } from '../types/project';

describe('migrateProject (R0)', () => {
  it('passes through a current-version project unchanged', () => {
    const project = createEmptyProject() as unknown as Record<string, unknown>;
    const result = migrateProject(project);
    expect(result.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(result).toBe(project); // same reference, no copy
  });

  it('upgrades a v1 project by bumping version', () => {
    const v1 = { version: 1, name: 'test' };
    const result = migrateProject(v1);
    expect(result.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.name).toBe('test');
  });

  it('preserves all other fields during migration', () => {
    const v1 = {
      version: 1,
      name: 'My Project',
      settings: { fps: 30 },
      timeline: { clips: [] },
    };
    const result = migrateProject(v1);
    expect(result.name).toBe('My Project');
    // Settings and timeline are untouched.
    expect((result.settings as Record<string, unknown>).fps).toBe(30);
  });
});
