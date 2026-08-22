import fs from 'node:fs';
const raw = fs.readFileSync(process.argv[2], 'utf8').replace(/\x1B\[[0-9;]*m/g, '');
let last = '';
for (const line of raw.split('\n')) {
  const fileMatch = line.match(/palmier-pro-windows[\\/](.+?)\s*$/);
  if (fileMatch) { last = fileMatch[1]; continue; }
  if (line.includes('warning')) console.log(`${last} :: ${line.trim().slice(0, 90)}`);
}
