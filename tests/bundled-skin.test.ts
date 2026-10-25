import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { loadSkin, validateSkinImageSize } from '../src/main/skin';
import { animationFrameCount, skinFrameLayout } from '../src/shared/types';

const directory = path.resolve('assets/skins/silver-dragon-frames');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function rgbaPng(bytes: Buffer) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.equal(bytes[24], 8); assert.equal(bytes[25], 6); assert.equal(bytes[28], 0);
  const chunks: Buffer[] = []; for (let offset = 8; offset < bytes.length;) { const size = bytes.readUInt32BE(offset); if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + size)); offset += size + 12; }
  const data = inflateSync(Buffer.concat(chunks)), rgba = Buffer.alloc(width * height * 4), stride = width * 4;
  assert.equal(data.length, height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0, up = y ? rgba[(y - 1) * stride + x] : 0, upperLeft = y && x >= 4 ? rgba[(y - 1) * stride + x - 4] : 0;
      const p = left + up - upperLeft, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upperLeft);
      const prediction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : a <= b && a <= c ? left : b <= c ? up : upperLeft;
      rgba[y * stride + x] = (data[y * (stride + 1) + 1 + x] + prediction) & 255;
    }
  }
  return { width, height, rgba };
}
async function fixtures() {
  const [skin, text] = await Promise.all([loadSkin(path.join(directory, 'skin.json')), fs.readFile(path.join(directory, 'provenance.json'), 'utf8')]);
  return { manifest: skin.manifest, provenance: JSON.parse(text) };
}

test('default skin uses two complete-character 24-frame atlases at 12 fps', async () => {
  const { manifest, provenance } = await fixtures();
  assert.equal(manifest.name, '银白龙娘 · 逐帧'); assert.equal(manifest.rig, undefined);
  assert.deepEqual({ width: manifest.width, height: manifest.height, anchor: manifest.anchor }, { width: 272, height: 272, anchor: { x: 136, y: 264 } });
  assert.deepEqual(Object.keys(manifest.animations).sort(), ['idle', 'thinking']);
  for (const state of ['idle', 'thinking']) {
    const animation = manifest.animations[state]; assert.equal(animation.fps, 12); assert.equal(animation.loop, true); assert.equal(animationFrameCount(animation), 24);
    assert.deepEqual(animation.frames, [`${state}-atlas.png`]); assert.deepEqual(animation.atlas, { columns: 6, rows: 4, indices: Array.from({ length: 24 }, (_, index) => index) });
    const bytes = await fs.readFile(path.join(directory, animation.frames[0])), size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    assert.deepEqual(size, { width: 1632, height: 1088 }); validateSkinImageSize(manifest, animation, animation.frames[0], size);
    assert.equal(sha(bytes), provenance.animations[state].atlas.sha256); assert.equal(provenance.animations[state].durationMs, 2000);
  }
});

test('both atlases preserve every selected PNG pixel and genuine alpha', async () => {
  const { manifest, provenance } = await fixtures(); assert.equal(provenance.frames.length, 48);
  for (const state of ['idle', 'thinking']) {
    const atlas = rgbaPng(await fs.readFile(path.join(directory, `${state}-atlas.png`))), animation = manifest.animations[state];
    const selected = provenance.frames.filter((frame: { file: string }) => frame.file.startsWith(state + '/')); assert.equal(selected.length, 24);
    for (let index = 0; index < 24; index++) {
      const evidence = selected[index], bytes = await fs.readFile(path.join(directory, evidence.file)), frame = rgbaPng(bytes);
      assert.equal(sha(bytes), evidence.sha256); assert.deepEqual({ width: frame.width, height: frame.height }, { width: 272, height: 272 });
      const layout = skinFrameLayout(manifest, animation, index); assert.deepEqual(layout.crop, { x: index % 6 * 272, y: Math.floor(index / 6) * 272, width: 272, height: 272 });
      let zero = 0, visible = 0;
      for (let offset = 3; offset < frame.rgba.length; offset += 4) { if (frame.rgba[offset] === 0) zero++; if (frame.rgba[offset] >= 128) visible++; }
      assert.ok(zero > 0 && visible > 1000, `${evidence.file} needs transparent background and a complete visible character`); assert.equal(zero, evidence.alpha.zero);
      for (let y = 0; y < 272; y++) {
        const source = ((Math.floor(index / 6) * 272 + y) * atlas.width + index % 6 * 272) * 4;
        assert.equal(Buffer.compare(frame.rgba.subarray(y * 272 * 4, (y + 1) * 272 * 4), atlas.rgba.subarray(source, source + 272 * 4)), 0, `${evidence.file} row ${y} must survive atlas packing exactly`);
      }
    }
  }
});

test('thinking keeps the approved release bytes and idle has one shared whole-character scale', async () => {
  const { provenance } = await fixtures();
  assert.equal(provenance.animations.thinking.uniqueSourceImages, 20, 'four approved holds are retained rather than claimed as new drawings');
  assert.equal(provenance.animations.idle.uniqueSourceImages, 24);
  for (const state of ['idle', 'thinking']) for (const evidence of provenance.frames.filter((frame: { file: string }) => frame.file.startsWith(state + '/'))) {
    const source = provenance.sources[evidence.source]; assert.equal(sha(await fs.readFile(path.resolve(source.file))), source.sha256);
    if (state === 'thinking') {
      assert.equal(evidence.exactSourceCopy, true); assert.equal(evidence.sha256, source.sha256); assert.match(source.file, /^release\/animation-redraw-v1\/thinking\/frame-\d+\.png$/);
    } else {
      assert.match(source.file, /idle-extracted-v1\.png$/); assert.equal(evidence.transform.scale, .96);
      assert.ok(Number.isInteger(evidence.transform.x) && Number.isInteger(evidence.transform.y));
      assert.ok(evidence.transform.sourceRect.width > 0 && evidence.transform.sourceRect.height > 0);
    }
  }
  assert.equal(sha(await fs.readFile(provenance.appearanceReference)), provenance.appearanceReferenceSha256);
});
