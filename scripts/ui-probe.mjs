#!/usr/bin/env node
/**
 * Rendered-layout probe driver (release-gate item in UPSTREAM_PARITY.md).
 *
 * Builds once with Vite, then launches Electron against the real built
 * renderer + preload and measures layout at the two matrix sizes
 * (1600x1000, 1024x680). The assertion is the overflow report, not a
 * screenshot: no document scrollbars, no element extending past the
 * viewport, and the `--text-2xs` token resolving to 10px on a live element.
 *
 * Usage: npm run ui:probe   → exits non-zero on failure, prints a table,
 * writes scripts/ui-probe-report.json for diffing between runs.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sizes = [
  { width: 1600, height: 1000 },
  { width: 1024, height: 680 },
];

function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      shell: process.platform === 'win32',
    });
    let out = '';
    if (opts.capture) child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}`))));
    child.on('error', reject);
  });
}

async function main() {
  console.log('[ui-probe] building renderer/main/preload with vite…');
  await run('npm', ['run', '--silent', 'build:app']);

  const results = [];
  const electronBinary = require('electron');
  const child = spawn(electronBinary, [path.join(rootDir, 'scripts/ui-probe-main.cjs')], {
    cwd: rootDir,
    env: { ...process.env, UI_PROBE_SIZES: JSON.stringify(sizes) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const code = await new Promise((resolve) => child.on('exit', resolve));

  // The probe main prints exactly one line of JSON prefixed with REPORT:.
  const line = stdout.split('\n').find((l) => l.startsWith('REPORT:'));
  if (!line) {
    console.error(stdout);
    throw new Error(`ui-probe-main produced no report (exit ${code})`);
  }
  results.push(...JSON.parse(line.slice('REPORT:'.length)));

  // ─── Report ──────────────────────────────────────────────────────────────
  let failed = false;
  console.log('\n[ui-probe] rendered matrix');
  console.log('size        | scrollX | scrollY | offenders | --text-2xs | live el');
  for (const r of results) {
    const ok =
      r.overflowX <= 0 && r.overflowY <= 0 && r.offenderCount === 0
      && (!r.textProbe || r.textProbe === '10px');
    if (!ok) failed = true;
    console.log(
      `${String(`${r.width}x${r.height}`).padEnd(11)} | ${String(r.overflowX).padEnd(7)} | ${String(r.overflowY).padEnd(7)} | ${String(r.offenderCount).padEnd(9)} | ${String(r.token || '(unset)').padEnd(10)} | ${r.textProbe ?? '(none)'}`,
    );
    for (const offender of r.offenders.slice(0, 8)) {
      console.log(`             ↳ <${offender.tag} class="${offender.cls}"> right=${offender.right} bottom=${offender.bottom}`);
    }
  }

  const reportPath = path.join(rootDir, 'scripts/ui-probe-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`\n[ui-probe] report written to ${path.relative(rootDir, reportPath)}`);

  if (failed) {
    console.error('[ui-probe] FAILED — see offenders above.');
    process.exit(1);
  }
  console.log('[ui-probe] OK');
}

main().catch((error) => {
  console.error('[ui-probe]', error?.message ?? error);
  process.exit(1);
});
