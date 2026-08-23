/**
 * Project schema migrations (roadmap R0).
 *
 * Every time the project format changes incompatibly, add a migration step.
 * Steps run in order when deserializing a project whose `version` is older
 * than the current schema version. Each step receives the raw parsed JSON
 * and returns the upgraded shape; the final result must satisfy the current
 * `Project` type exactly.
 *
 * All new fields MUST be optional so projects saved before them decode
 * without a migration -- migrations exist for BREAKING changes (renames,
 * semantic shifts, structural moves), not additive ones.
 */

import { createEmptyProject } from '../types/project';

/** Bump this when adding a migration step below. */
export const CURRENT_SCHEMA_VERSION = 2;

type AnyRecord = Record<string, unknown>;

/**
 * Migration steps keyed by source version. Step N upgrades a project from
 * version N to version N+1.
 */
const MIGRATIONS: Record<number, (data: AnyRecord) => AnyRecord> = {
  /**
   * v1 → v2: titles gained `titleSizeRatio` / `titleColor`; clips gained
   * `speed`, color-grade fields, and `pan`. All optional so no data change
   * is strictly required, but we set the version marker so future reads
   * know which generation produced the file.
   */
  1: (data: AnyRecord): AnyRecord => ({
    ...data,
    version: 2,
  }),
};

/**
 * Run all applicable migrations on a parsed project JSON blob.
 *
 * Returns the highest-versioned representation. If the input is already at
 * the current version (or newer), it passes through unchanged.
 */
export function migrateProject(data: AnyRecord): AnyRecord {
  let version = typeof data.version === 'number' ? data.version : CURRENT_SCHEMA_VERSION;
  let current = data;

  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) break;
    current = step(current);
    version += 1;
  }
  return current;
}

/** Convenience: produce an empty project at the current schema version. */
export function emptyProjectAtCurrentVersion(): AnyRecord {
  return createEmptyProject() as unknown as AnyRecord;
}
