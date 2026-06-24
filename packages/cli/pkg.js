import { readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';

import { rollup } from 'rollup';
import { exec } from '@yao-pkg/pkg';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

const bundle = await rollup({
  input: 'dist/cli.js',
  plugins: [
    nodeResolve({
      exportConditions: ['node'],
    }),
    commonjs(),
    json(),
  ],
});

await bundle.write({
  dir: 'bundle',
  format: 'cjs',
});

await bundle.close();

const pkgJson = JSON.parse(readFileSync('package.json', 'utf8'));
delete pkgJson.type;
// The published package runs from the package root, so its `bin` points at
// `dist/cli.js`. pkg compiles the Rollup output that lands at `bundle/cli.js`,
// so rewrite `bin` to that entry (and drop `main`) for the standalone build.
const binName = typeof pkgJson.bin === 'string' ? 'neon' : Object.keys(pkgJson.bin)[0];
pkgJson.bin = { [binName]: 'cli.js' };
delete pkgJson.main;

pkgJson.pkg.assets.forEach((asset) => {
  cpSync(join('dist', asset), join('bundle', asset));
});

writeFileSync('bundle/package.json', JSON.stringify(pkgJson, null, 2));

await exec([
  'bundle',
  '--out-path',
  'bundle',
  '--compress',
  'brotli',
  '--options',
  'no-warnings',
]);
