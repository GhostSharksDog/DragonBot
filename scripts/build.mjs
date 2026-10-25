import { build } from 'esbuild';
import { build as buildRenderer } from 'vite';
import { cp, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { buildNative } from './build-native.mjs';
await buildNative();
await mkdir('dist/main', { recursive: true });
await build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external', sourcemap: true });
await build({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });
await build({ entryPoints: ['scripts/backend-probe.ts'], outfile: 'dist/main/backend-probe.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external' });
await buildRenderer({ base: './', build: { outDir: 'dist/renderer', emptyOutDir: true } });
// Ship selected art only; preserve every production draft in the source workspace.
for (const directory of await readdir('assets/skins', { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const source = path.join('assets/skins', directory.name), destination = path.resolve('dist/assets/skins', directory.name);
  const manifest = JSON.parse(await readFile(path.join(source, 'skin.json'), 'utf8'));
  const selected = new Set(['skin.json', ...Object.values(manifest.animations ?? {}).flatMap(animation => animation.frames), ...Object.values(manifest.rig?.views ?? {}).flatMap(view => view.layers.map(layer => layer.file))]);
  await mkdir(destination, { recursive: true });
  for (const existing of await readdir(destination, { withFileTypes: true })) {
    if (existing.isFile() && !selected.has(existing.name) && /\.(png|webp|json)$/i.test(existing.name)) await unlink(path.join(destination, existing.name));
  }
  for (const file of selected) { const target = path.join(destination, file); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(source, file), target, { force: true }); }
}
