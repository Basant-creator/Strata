import { build } from 'esbuild';
import fs from 'node:fs';

fs.rmSync('release', { recursive: true, force: true });

await build({
  entryPoints: ['src/cli/index.ts'],
  outfile: 'release/strata.js',
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  // Dependencies stay ordinary npm dependencies; only Strata's own code is bundled.
  packages: 'external',
  define: { 'process.env.STRATA_BUNDLED': '"1"' },
});
