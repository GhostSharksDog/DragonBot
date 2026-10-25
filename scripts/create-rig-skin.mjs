import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Build layout metadata only: the preserved ImageGen PNG files are never changed.
const args = process.argv.slice(2);
const options = { geometry: 'docs/imagegen/v040/parts-geometry.json', output: 'assets/skins/silver-dragon-rig/skin.json' };
for (let i = 0; i < args.length; i++) {
  if (['--geometry', '--output'].includes(args[i])) options[args[i].slice(2)] = args[++i];
  else throw new Error(`Unknown option ${args[i]}`);
}
const geometry = JSON.parse(await fs.readFile(options.geometry, 'utf8'));
const files = { front: 'parts-front-v2.png', left: 'parts-left-v1.png', right: 'parts-right-v1.png' };
const views = {};
for (const [facing, file] of Object.entries(files)) {
  const source = geometry.files[file];
  if (!source || source.errors.length) throw new Error(`Unreviewed or invalid part source: ${file}`);
  const bytes = await fs.readFile(path.join(path.dirname(options.output), file));
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`Source changed after alpha inspection: ${file}`);
  const layer = (index, width, height, x, y, pivotX, pivotY, z, parent, extra = {}) => ({
    id: source.parts[index].role, role: source.parts[index].role, file,
    sourceRegion: source.parts[index].sourceRegion,
    width, height, x, y, pivot: { x: pivotX, y: pivotY }, z,
    ...(parent ? { parent } : {}), ...extra,
  });
  const profile = facing !== 'front', left = facing === 'left';
  const layers = [
    layer(2, 118, 143, 256, 470, 59, 143, 20),
    layer(0, profile ? 257 : 260, 420, 59, 0, profile ? (left ? 118 : 139) : 130, 250, 1, 'body'),
    layer(10, 130, 90, 5, 40, 120, 45, profile && !left ? 4 : 2, 'body'),
    layer(11, 130, 90, 113, 40, 10, 45, profile && left ? 4 : 2, 'body'),
    layer(12, 170, 160, profile ? (left ? 92 : 26) : 97, 135, profile ? (left ? 45 : 140) : 55, 35, 3, 'body'),
    layer(6, 30, 64, profile ? (left ? 62 : 49) : 43, 143, 15, 5, 6, 'body'),
    layer(7, 30, 64, profile ? (left ? 49 : 62) : 75, 143, 15, 5, 8, 'body'),
    layer(8, 42, 100, 15, 58, 21, 3, 7, 'leg-left'),
    layer(9, 42, 100, 15, 58, 21, 3, 9, 'leg-right'),
    layer(3, profile ? 165 : 190, 150, 59, 138, profile ? 82.5 : 95, 0, 23, 'body'),
    layer(4, 90, 126, profile ? (left ? 49 : 13) : 8, 18, 76, 8, profile && left ? 16 : 27, 'body'),
    layer(5, 90, 126, profile ? (left ? 105 : 62) : 110, 18, 14, 8, profile && !left ? 16 : 28, 'body'),
    layer(1, 270, 300, 59, -2, 135, 263, 30, 'body'),
    layer(15, profile ? 150 : 210, 190, profile ? (left ? 185 : 80) : 135, 222, profile ? 75 : 105, 0, 31, 'head'),
    layer(13, profile ? 102 : 150, profile ? 36 : 39, profile ? (left ? 91 : 174) : 135, 208, profile ? 51 : 75, 19.5, 33, 'head'),
    layer(14, profile ? 12 : 14, 9, profile ? (left ? 84 : 190) : 135, 241, profile ? 6 : 7, 4.5, 34, 'head'),
  ];
  const eyebrows = source.auxiliaryParts.find(part => part.id === 'eyebrows');
  if (eyebrows) layers.push({ id: 'eyebrows', role: 'static', parent: 'head', file, sourceRegion: eyebrows.sourceRegion,
    width: profile ? 98 : 125, height: 6, x: profile ? (left ? 91 : 174) : 135, y: 184,
    pivot: { x: profile ? 49 : 62.5, y: 3 }, z: 32 });
  views[facing] = { layers };
}
const manifest = {
  name: '银白龙娘 · 连续动画', width: 512, height: 640, anchor: { x: 256, y: 620 }, animations: {},
  rig: { version: 1, timing: { walkMs: 2400, runMs: 1800, breathMs: 4800, transitionMs: 250 }, gait: { stride: 96, footLift: 24, hipDrop: 12 }, views },
};
await fs.mkdir(path.dirname(options.output), { recursive: true });
await fs.writeFile(options.output, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Created ${options.output}: three independent templates, ${Object.values(views).map(view => view.layers.length).join('/')} fixed layers.`);
