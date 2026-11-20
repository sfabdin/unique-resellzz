// Packs the files in static/ (styles, browser scripts, icon) into
// src/static.generated.js so the Worker can serve them itself.
// Runs automatically before dev, test and deploy. Edit the files in static/,
// never the generated file.
//
//   node scripts/embed-static.mjs            readable output (dev, tests, wrangler deploy)
//   node scripts/embed-static.mjs --minify   smaller output (used by scripts/bundle.mjs)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'static');
const minify = process.argv.includes('--minify');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

const files = {};
for (const name of fs.readdirSync(dir).sort()) {
  const ext = path.extname(name);
  if (!TYPES[ext]) continue;
  let body = fs.readFileSync(path.join(dir, name), 'utf8');
  if (minify && ext !== '.svg') {
    const { transform } = await import('esbuild');
    body = (await transform(body, { loader: ext.slice(1), minify: true })).code;
  }
  // The hash goes in each file's URL (?v=...), so browsers can cache forever
  // and still pick up a change the moment it is deployed.
  files[name] = { type: TYPES[ext], hash: crypto.createHash('sha256').update(body).digest('hex').slice(0, 10), body };
}

const out =
  '// Generated from static/ by scripts/embed-static.mjs. Do not edit: change the files in static/ instead.\n' +
  `export const STATIC = ${JSON.stringify(files, null, 1)};\n`;
const target = path.join(root, 'src', 'static.generated.js');
if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== out) fs.writeFileSync(target, out);
