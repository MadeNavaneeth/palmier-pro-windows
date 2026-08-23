import fs from 'node:fs';
const raw = fs.readFileSync(process.env.TEMP + '\\ap.log', 'utf8').replace(/\x1B\[[0-9;]*m/g, '');
const i = raw.indexOf('AssertionError');
console.log(raw.slice(i, i + 900));
