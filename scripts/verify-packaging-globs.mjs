// Asserts the electron-builder packaging config actually covers the native
// addon that the build produces.
//
// The failure this guards against is silent: if `files` or an `extraResources`
// filter matches nothing, electron-builder still produces a full installer,
// just one whose compositor silently falls back to "GPU compositing disabled".
// That is only caught by checking the patterns, not by checking the exit code.
//
// Usage: node scripts/verify-packaging-globs.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ADDON = 'native/palmier-compositor.node';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const build = pkg.build ?? {};

/** Patterns are matched relative to `base`; `!` entries are exclusions. */
function covers(patterns, base, subject) {
  if (!Array.isArray(patterns)) return false;
  return patterns
    .filter((pattern) => typeof pattern === 'string' && !pattern.startsWith('!'))
    .some(
      (pattern) =>
        path.matchesGlob(subject, pattern) ||
        path.matchesGlob(subject, path.posix.join(base, pattern)),
    );
}

const failures = [];

if (!covers(build.files, '', ADDON)) {
  failures.push(`build.files does not cover ${ADDON}`);
}

for (const resource of build.extraResources ?? []) {
  const from = String(resource.from ?? '').replace(/\/+$/, '');
  if (!covers(resource.filter, from, path.posix.basename(ADDON))) {
    failures.push(`build.extraResources[from=${from}] filter does not cover ${ADDON}`);
  }
}

if (failures.length > 0) {
  console.error('[verify-packaging-globs] packaging would ship without the native addon:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`[verify-packaging-globs] ok: ${ADDON} is covered by build.files and build.extraResources`);
