import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

mkdirSync(dist, { recursive: true });

const buildOptions = {
  entryPoints: {
    background: path.join(root, 'src/background/background.js'),
    popup: path.join(root, 'src/popup/popup.js'),
    blocked: path.join(root, 'src/blocked/blocked.js'),
  },
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'chrome110',
  sourcemap: true,
  logLevel: 'info',
};

function copyStatics() {
  cpSync(path.join(root, 'manifest.json'), path.join(dist, 'manifest.json'));
  cpSync(path.join(root, 'src/popup/popup.html'), path.join(dist, 'popup.html'));
  cpSync(path.join(root, 'src/popup/popup.css'), path.join(dist, 'popup.css'));
  cpSync(path.join(root, 'src/blocked/blocked.html'), path.join(dist, 'blocked.html'));
  if (existsSync(path.join(root, 'icons'))) {
    cpSync(path.join(root, 'icons'), path.join(dist, 'icons'), { recursive: true });
  }
  console.log('[build] estáticos copiados a dist/');
}

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  copyStatics();
  console.log('[build] watching...');
} else {
  await esbuild.build(buildOptions);
  copyStatics();
  console.log('[build] listo — carga dist/ como extensión sin empaquetar en chrome://extensions');
}
