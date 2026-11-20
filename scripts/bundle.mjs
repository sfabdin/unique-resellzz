// Builds the whole site into one small file, dist/worker.js: the exact file
// that runs on Cloudflare when deploying through Cloudflare's API instead of
// `wrangler deploy`. See "Deploying" in the README.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [path.join(root, 'scripts', 'embed-static.mjs'), '--minify'], { stdio: 'inherit' });
await build({
  entryPoints: [path.join(root, 'src', 'index.js')],
  outfile: path.join(root, 'dist', 'worker.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
});
// Leave the readable version in place for dev and tests.
execFileSync(process.execPath, [path.join(root, 'scripts', 'embed-static.mjs')], { stdio: 'inherit' });

const code = fs.readFileSync(path.join(root, 'dist', 'worker.js'));
console.log(`dist/worker.js  ${code.length} bytes  sha256 ${crypto.createHash('sha256').update(code).digest('hex')}`);
