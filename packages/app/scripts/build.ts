/**
 * Build script: bundle the app into a single JS file for pkg.
 */

import { buildSync } from 'esbuild';
import { mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

mkdirSync(DIST, { recursive: true });

// Bundle TypeScript into a single CJS file (pkg requires CJS)
console.log('Bundling app...');
buildSync({
  entryPoints: [join(ROOT, 'src/main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: join(DIST, 'main.js'),
  external: [
    'hnswlib-node',       // only used in relay server (not in app)
    'onnxruntime-node',   // will fall back to onnxruntime-web (WASM)
  ],
  banner: {
    js: '// Resonance Desktop App — bundled with esbuild\n',
  },
  logLevel: 'warning',
});

// Copy UI files to dist/ui (these get embedded as pkg assets)
console.log('Copying UI files...');
mkdirSync(join(DIST, 'ui'), { recursive: true });
cpSync(join(ROOT, 'src/ui'), join(DIST, 'ui'), { recursive: true });

console.log('Build complete.');
console.log(`  Bundle: dist/main.js`);
console.log(`  UI:     dist/ui/`);
console.log('');
console.log('To create binaries: npx pkg dist/main.js --config pkg.json');
