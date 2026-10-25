import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadSkin, validateSkinImageSize } from '../src/main/skin';
import { animationCellAt, animationFrameAt, animationFrameCount, skinFrameLayout, pointInSpriteOutline, skinRegionClipPath, type SkinAnimation, type SkinManifest, type SpriteRegion } from '../src/shared/types';
test('skin loader accepts local sprites and rejects external, traversal and missing idle inputs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dragon-skin-'));
  try {
    await fs.writeFile(path.join(dir, 'idle.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    const input = { name: '素材测试', width: 16, height: 16, anchor: { x: 8, y: 16 }, animations: { idle: { fps: 8, frames: ['idle.png'] } } };
    const file = path.join(dir, 'skin.json');
    await fs.writeFile(file, JSON.stringify(input)); assert.equal((await loadSkin(file)).manifest.name, '素材测试');
    for (const frame of ['../outside.png', 'https://example.com/x.png', 'C:\\private.png', '%2e%2e/outside.png']) {
      await fs.writeFile(file, JSON.stringify({ ...input, animations: { idle: { fps: 8, frames: [frame] } } }));
      await assert.rejects(loadSkin(file));
    }
    await fs.writeFile(file, JSON.stringify({ ...input, animations: {} })); await assert.rejects(loadSkin(file));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('atlas animation selects explicit cells, loops and holds a completed one-shot', () => {
  const animation: SkinAnimation = { frames: ['states.png'], fps: 4, atlas: { columns: 4, rows: 4, indices: [4, 5, 6, 5] } };
  assert.equal(animationFrameCount(animation), 4);
  assert.equal(animationFrameAt(animation, 1250, 1000), 1);
  assert.equal(animationFrameAt(animation, 2250, 1000), 1);
  assert.deepEqual(animationCellAt(animation, 2), { frame: 'states.png', column: 2, row: 1 });
  assert.deepEqual(animationCellAt(animation, 3), { frame: 'states.png', column: 1, row: 1 });
  assert.equal(animationFrameAt({ ...animation, loop: false }, 5000, 1000), 3);
  assert.equal(animationFrameAt(animation, 800, 1000), 0);
  const legacy: SkinAnimation = { frames: ['a.png', 'b.png'], fps: 2 };
  assert.deepEqual(animationCellAt(legacy, 1), { frame: 'b.png', column: 0, row: 0 });
});

test('irregular atlas regions preserve aspect, bottom alignment and crop offsets', () => {
  const animation: SkinAnimation = { frames: ['motion.png'], fps: 8, atlas: { columns: 2, rows: 2, sourceWidth: 300, sourceHeight: 320, regions: [{ x: 0, y: 0, width: 100, height: 120 }, { x: 100, y: 0, width: 200, height: 120 }, { x: 0, y: 120, width: 100, height: 200 }, { x: 100, y: 120, width: 200, height: 200 }], indices: [2, 1] } };
  const layout = skinFrameLayout({ width: 100, height: 100 }, animation, 0);
  assert.deepEqual(layout.source, { width: 300, height: 320 });
  assert.deepEqual(layout.crop, { x: 0, y: 120, width: 100, height: 200 });
  assert.deepEqual(layout.destination, { x: 25, y: 0, width: 50, height: 100 });
  assert.deepEqual(layout.image, { left: -0, top: -60, width: 150, height: 160 });
  assert.deepEqual(skinFrameLayout({ width: 100, height: 100 }, animation, 1).destination, { x: 0, y: 40, width: 100, height: 60 });
  assert.deepEqual(skinFrameLayout({ width: 100, height: 100 }, { fps: 1, frames: ['plain.png'] }, 0).destination, { x: 0, y: 0, width: 100, height: 100 });
});

test('24fps sequences can select complete poses across multiple source atlases', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dragon-multi-atlas-'));
  try {
    for (const file of ['a.png', 'b.png']) await fs.writeFile(path.join(dir, file), 'fixture');
    const regions = Array.from({ length: 24 }, (_, i) => ({ x: i % 6 * 20, y: Math.floor(i / 6) * 30, width: 20, height: 30 }));
    const animation: SkinAnimation = { fps: 24, frames: ['a.png', 'b.png'], atlas: { columns: 6, rows: 4, sourceWidth: 120, sourceHeight: 120, regions, frameSources: Array.from({ length: 24 }, (_, i) => i < 18 ? 0 : 1), indices: Array.from({ length: 24 }, (_, i) => i) } };
    const input = { name: '多图集', width: 64, height: 64, anchor: { x: 32, y: 64 }, animations: { idle: animation } };
    const file = path.join(dir, 'skin.json'); await fs.writeFile(file, JSON.stringify(input));
    assert.equal(animationFrameCount((await loadSkin(file)).manifest.animations.idle), 24);
    assert.equal(skinFrameLayout(input, animation, 17).frame, 'a.png');
    assert.equal(skinFrameLayout(input, animation, 18).frame, 'b.png');
    assert.equal(animationFrameAt(animation, 1000 / 24 * 23 + .001), 23);
    assert.equal(animationFrameAt(animation, 1000), 0);
    assert.equal(skinFrameLayout(input, animation, 18).destination.y + skinFrameLayout(input, animation, 18).destination.height, 64);
    for (const frameSources of [[0], Array(24).fill(-1), Array(24).fill(2), Array(24).fill(.5)]) {
      await fs.writeFile(file, JSON.stringify({ ...input, animations: { idle: { ...animation, atlas: { ...animation.atlas, frameSources } } } }));
      await assert.rejects(loadSkin(file), /图片编号/);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('different source sizes and concave sprite outlines share renderer and hit-test geometry', () => {
  const region: SpriteRegion = { x: 100, y: 100, width: 100, height: 200, outline: [[0, 0], [100, 0], [100, 70], [40, 70], [40, 200], [0, 200]] };
  assert.equal(pointInSpriteOutline(region, 20, 150), true);
  assert.equal(pointInSpriteOutline(region, 80, 150), false);
  assert.equal(pointInSpriteOutline(region, 40, 150), true);
  assert.equal(pointInSpriteOutline({ ...region, outline: undefined }, 80, 150), true);
  assert.match(skinRegionClipPath(region)!, /^polygon\(evenodd,/);
  const animation: SkinAnimation = { frames: ['a.png', 'b.png'], fps: 24, atlas: { columns: 2, rows: 1, indices: [0, 1], frameSources: [0, 1], sourceWidth: 200, sourceHeight: 200, sourceSizes: [{ width: 200, height: 200 }, { width: 400, height: 300 }], regions: [{ x: 0, y: 0, width: 100, height: 200 }, region] } };
  assert.deepEqual(skinFrameLayout({ width: 100, height: 200 }, animation, 1).source, { width: 400, height: 300 });
  assert.equal(skinFrameLayout({ width: 100, height: 200 }, animation, 1).frame, 'b.png');
  const manifest = { name: 'test', width: 100, height: 200, anchor: { x: 50, y: 200 }, animations: { idle: animation } };
  validateSkinImageSize(manifest, animation, 'b.png', { width: 400, height: 300 });
  assert.throws(() => validateSkinImageSize(manifest, animation, 'b.png', { width: 200, height: 200 }));
});

test('atlas loader validates grid, explicit frame sequence and mirroring', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dragon-atlas-'));
  try {
    await fs.writeFile(path.join(dir, 'atlas.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    const animation: SkinAnimation = { fps: 8, frames: ['atlas.png'], atlas: { columns: 4, rows: 4, indices: [0, 1, 2, 3] }, flipX: true };
    const input: SkinManifest = { name: '图集测试', width: 256, height: 256, anchor: { x: 128, y: 244 }, animations: { idle: animation } };
    const file = path.join(dir, 'skin.json');
    await fs.writeFile(file, JSON.stringify(input));
    assert.equal((await loadSkin(file)).manifest.animations.idle.flipX, true);
    validateSkinImageSize(input, animation, 'atlas.png', { width: 1024, height: 1024 });
    validateSkinImageSize(input, animation, 'atlas.png', { width: 1254, height: 1254 });
    validateSkinImageSize(input, animation, 'atlas.png', { width: 1254, height: 1265 });
    assert.throws(() => validateSkinImageSize(input, animation, 'atlas.png', { width: 1254, height: 1300 }));
    assert.throws(() => validateSkinImageSize(input, animation, 'atlas.png', { width: 8193, height: 8193 }));
    assert.throws(() => validateSkinImageSize(input, { frames: ['legacy.png'], fps: 8 }, 'legacy.png', { width: 1024, height: 1024 }));
    const invalid = [
      { ...animation, atlas: null },
      { ...animation, atlas: { ...animation.atlas, columns: 0 } },
      { ...animation, atlas: { ...animation.atlas, columns: 2.5 } },
      { ...animation, atlas: { ...animation.atlas, rows: 17 } },
      { ...animation, atlas: { ...animation.atlas, indices: [] } },
      { ...animation, atlas: { ...animation.atlas, indices: [16] } },
      { ...animation, atlas: { ...animation.atlas, indices: [-1] } },
      { ...animation, atlas: { ...animation.atlas, indices: [0.5] } },
      { ...animation, atlas: { ...animation.atlas, indices: Array(121).fill(0) } },
      { ...animation, frames: ['atlas.png', 'atlas.png'] },
      { ...animation, flipX: 'yes' },
    ];
    for (const value of invalid) {
      await fs.writeFile(file, JSON.stringify({ ...input, animations: { idle: value } }));
      await assert.rejects(loadSkin(file));
    }
    await fs.writeFile(file, JSON.stringify({ ...input, width: 2048, animations: { idle: { ...animation, atlas: { columns: 5, rows: 4, indices: [0] } } } }));
    await assert.rejects(loadSkin(file), /8192/);
    const regions = Array.from({ length: 16 }, (_, index) => ({ x: index % 4 * 300, y: Math.floor(index / 4) * 300, width: 300, height: 300 }));
    const custom = { ...animation, atlas: { ...animation.atlas!, sourceWidth: 1254, sourceHeight: 1254, regions } };
    await fs.writeFile(file, JSON.stringify({ ...input, animations: { idle: custom } }));
    assert.equal((await loadSkin(file)).manifest.animations.idle.atlas?.regions?.length, 16);
    validateSkinImageSize(input, custom, 'atlas.png', { width: 1254, height: 1254 });
    assert.throws(() => validateSkinImageSize(input, custom, 'atlas.png', { width: 1255, height: 1254 }));
    for (const atlas of [
      { ...custom.atlas, sourceWidth: undefined },
      { ...custom.atlas, sourceHeight: 8193 },
      { ...custom.atlas, regions: regions.slice(1) },
      { ...custom.atlas, regions: [{ ...regions[0], x: -1 }, ...regions.slice(1)] },
      { ...custom.atlas, regions: [{ ...regions[0], width: 0 }, ...regions.slice(1)] },
      { ...custom.atlas, regions: [{ ...regions[0], width: 1255 }, ...regions.slice(1)] },
      { ...custom.atlas, regions: [{ ...regions[0], y: null }, ...regions.slice(1)] },
    ]) {
      await fs.writeFile(file, JSON.stringify({ ...input, animations: { idle: { ...custom, atlas } } }));
      await assert.rejects(loadSkin(file));
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
