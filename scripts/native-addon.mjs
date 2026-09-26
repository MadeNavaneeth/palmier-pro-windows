// Pins the native addon to one predictable filename so electron-builder's
// packaging globs always have something to match.
//
// `napi build` owns how it names its output. Depending on the CLI version and
// flags it may emit either `palmier-compositor.node` or a triple-suffixed
// `palmier-compositor.win32-x64-msvc.node`. Both are handled here: the newest
// artifact is copied to the canonical name that `package.json` packaging globs
// and the runtime loader agree on.
//
// Usage:
//   node scripts/native-addon.mjs           normalise after a napi build
//   node scripts/native-addon.mjs --check   assert the artifact exists (CI)
//
// Exits non-zero when no addon was produced, so a build can never silently
// package an app without a compositor.

import { copyFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CANONICAL = 'palmier-compositor.node';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = path.join(root, 'native');
const checkOnly = process.argv.includes('--check');

function fail(message) {
  console.error(`[native-addon] ${message}`);
  process.exit(1);
}

async function sizeOf(file) {
  return (await stat(file)).size;
}

async function newestArtifact() {
  const candidates = (await readdir(nativeDir)).filter(
    (entry) => entry.startsWith('palmier-compositor') && entry.endsWith('.node'),
  );
  if (candidates.length === 0) return null;

  const stamped = await Promise.all(
    candidates.map(async (name) => ({
      name,
      mtimeMs: (await stat(path.join(nativeDir, name))).mtimeMs,
    })),
  );
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stamped[0].name;
}

if (checkOnly) {
  const canonical = path.join(nativeDir, CANONICAL);
  try {
    console.log(
      `[native-addon] ok: native/${CANONICAL} (${await sizeOf(canonical)} bytes)`,
    );
  } catch {
    fail(
      `native/${CANONICAL} is missing. Run \`npm run build:rust\` before packaging or CI checks.`,
    );
  }
} else {
  const artifact = await newestArtifact();
  if (!artifact) {
    fail(
      `napi build produced no *.node in native/. Expected native/${CANONICAL} to exist before packaging.`,
    );
  }

  const canonical = path.join(nativeDir, CANONICAL);
  if (artifact !== CANONICAL) {
    await copyFile(path.join(nativeDir, artifact), canonical);
    console.log(`[native-addon] ${artifact} -> ${CANONICAL}`);
  }

  console.log(
    `[native-addon] ready: native/${CANONICAL} (${await sizeOf(canonical)} bytes)`,
  );
}
