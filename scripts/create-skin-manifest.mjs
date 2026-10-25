import fs from 'node:fs/promises';
const geometry = JSON.parse(await fs.readFile('docs/imagegen/atlas-geometry.json', 'utf8'));
function animation(file, indices, fps, loop = true) {
  const { sourceWidth, sourceHeight, regions } = geometry[file];
  return { frames: [file], fps, loop, atlas: { columns: 4, rows: 4, sourceWidth, sourceHeight, regions, indices } };
}
const front = 'atlas-front-v2.png', expressions = 'atlas-expressions-v2.png', motion = 'atlas-motion-v2.png';
const manifest = {
  name: '银白龙娘', width: 512, height: 512, anchor: { x: 256, y: 512 },
  animations: {
    idle: animation(front, [...Array(18).fill(0), 1, 2, 1, 3, ...Array(8).fill(0)], 6),
    speaking: animation(front, [4, 5, 6, 5, 7, 4], 7),
    thinking: animation(front, [8, 8, 9, 9, 10, 11, 8, 8], 3),
    'awaiting-input': animation(front, [12, 12, 13, 14, 15, 12, 12, 12], 3),
    'awaiting-approval': animation(expressions, [0, 0, 1, 0, 2, 2, 3, 0], 3),
    success: animation(expressions, [4, 5, 6, 7], 4, false),
    error: animation(expressions, [8, 8, 9, 10, 11, 8], 3),
    'idle-back': animation(expressions, [12, 13, 14, 15], 3),
    'walking-right': animation(motion, [0, 1, 2, 3], 6),
    'running-right': animation(motion, [4, 5, 6, 7], 8),
    'walking-left': animation(motion, [8, 9, 10, 11], 6),
    'running-left': animation(motion, [12, 13, 14, 15], 8),
  },
};
await fs.writeFile('assets/skins/silver-dragon/skin.json', JSON.stringify(manifest, null, 2));
console.log('Default silver dragon skin: 48 source poses, 12 animation states.');
