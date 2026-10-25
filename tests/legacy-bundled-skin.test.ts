import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadSkin, validateSkinImageSize } from '../src/main/skin';
import { animationFrameCount, skinFrameLayout, type SpriteRegion } from '../src/shared/types';

interface FrameEvidence {
  index: number;
  region: SpriteRegion;
  exactHash: string;
  edgeTouches: string[];
  outlineValidation: { ownPixels: number; retainedOwn: number; ownCoverage: number; foreignPixelsKept: number; points: number };
}
interface SourceEvidence {
  sourceWidth: number;
  sourceHeight: number;
  frames: FrameEvidence[];
  errors: { kind: string; frame?: number }[];
}
interface Selection { state: string; sequence?: string; sources: { file: string; indices: number[] }[] }
interface SequenceStats { mean: number; max: number; seam: number | null }
interface SequenceEvidence { appliedOrder: number[]; before: SequenceStats; appliedMetrics: SequenceStats }
interface SourceChecksum { file: string; sha256: string; width: number; height: number; bytes: number }

const skinDirectory = path.resolve('assets/skins/silver-dragon');
const states = ['idle', 'speaking', 'thinking', 'awaiting-input', 'awaiting-approval', 'success', 'error', 'idle-back', 'walking-right', 'running-right', 'walking-left', 'running-left'];
async function readFixtures() {
  const [skin, rawGeometry, rawSelection, rawReview, rawPrompts] = await Promise.all([
    loadSkin(path.join(skinDirectory, 'skin.json')),
    fs.readFile('docs/imagegen/atlas-geometry-24.json', 'utf8'),
    fs.readFile('docs/imagegen/atlas-selection-24.json', 'utf8'),
    fs.readFile('docs/imagegen/atlas-sequence-review-24.json', 'utf8'),
    fs.readFile('docs/imagegen/prompt-set.json', 'utf8'),
  ]);
  const geometry = JSON.parse(rawGeometry) as { version: number; files: Record<string, SourceEvidence> };
  const selection = JSON.parse(rawSelection) as Selection[];
  const review = JSON.parse(rawReview) as { states: Record<string, SequenceEvidence> };
  const prompts = JSON.parse(rawPrompts) as { sourceAssets: SourceChecksum[] };
  const images = new Map(await Promise.all(prompts.sourceAssets.map(async source => {
    const bytes = await fs.readFile(path.join(skinDirectory, source.file));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${source.file} is a real PNG`);
    assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
    return [source.file, { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }] as const;
  })));
  return { manifest: skin.manifest, geometry, selection, review, prompts, images };
}
let cached: ReturnType<typeof readFixtures> | undefined;
const fixtures = () => cached ??= readFixtures();

test('bundled character has 24 independent source frames in each of its 12 animations', async () => {
  const { manifest, geometry, selection } = await fixtures();
  assert.ok(geometry.version >= 3);
  assert.deepEqual(Object.keys(manifest.animations).sort(), [...states].sort());
  const allHashes = new Set<string>();
  let count = 0;
  for (const state of states) {
    const animation = manifest.animations[state], chosen = selection.find(item => item.state === state)!;
    assert.equal(animation.fps, 24, state);
    assert.equal(animationFrameCount(animation), 24, state);
    assert.equal(animation.atlas!.regions!.length, 24, state);
    assert.equal(new Set(animation.atlas!.indices).size, 24, `${state} cannot pad its cycle with repeated indices`);
    assert.equal(animation.loop, state !== 'success');
    const selected = chosen.sources.flatMap(source => source.indices.map(index => geometry.files[source.file].frames[index])).slice(0, 24);
    assert.equal(selected.length, 24);
    const hashes = new Set(selected.map(frame => frame.exactHash));
    assert.equal(hashes.size, 24, `${state} requires genuinely different inspected source pixels`);
    for (const hash of hashes) { assert.match(hash, /^[a-f\d]{64}$/); allHashes.add(hash); }
    count += selected.length;
  }
  assert.equal(count, 288);
  assert.equal(allHashes.size, 288);
});

test('every displayed source and outline matches the reviewed selection without selected bad frames', async () => {
  const { manifest, geometry, selection, review } = await fixtures();
  for (const state of states) {
    const animation = manifest.animations[state], atlas = animation.atlas!, chosen = selection.find(item => item.state === state)!;
    const sources = chosen.sources.flatMap(source => source.indices.map(index => ({ file: source.file, index, source: geometry.files[source.file], frame: geometry.files[source.file].frames[index] }))).slice(0, 24);
    const order = review.states[state].appliedOrder;
    assert.equal(order.length, 24); assert.equal(new Set(order).size, 24); assert.equal(order[0], 0);
    for (let position = 0; position < 24; position++) {
      const selected = sources[order[position]], regionIndex = atlas.indices[position], region = atlas.regions![regionIndex];
      const sourceIndex = atlas.frameSources?.[regionIndex] ?? 0;
      assert.equal(animation.frames[sourceIndex], selected.file, `${state} frame ${position}`);
      assert.equal(skinFrameLayout(manifest, animation, position).frame, selected.file);
      assert.deepEqual(region, selected.frame.region, `${state} crop/outline must remain bound to the actual source pose`);
      assert.equal(selected.frame.edgeTouches.length, 0);
      assert.deepEqual(selected.source.errors.filter(error => error.frame === selected.index), [], `${state} must not select clipped, merged or unvalidated figures`);
      const validation = selected.frame.outlineValidation;
      assert.ok(validation.ownPixels > 0);
      assert.equal(validation.retainedOwn, validation.ownPixels);
      assert.equal(validation.ownCoverage, 1);
      assert.equal(validation.foreignPixelsKept, 0);
      assert.equal(validation.points, region.outline!.length);
      assert.ok(region.outline!.length >= 3 && region.outline!.length <= 2048);
      for (const [x, y] of region.outline!) assert.ok(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= region.width && y <= region.height);
    }
  }
});

test('original PNG checksums, physical sizes and mixed-source frame geometry agree', async () => {
  const { manifest, prompts, images } = await fixtures();
  const usedFiles = new Set(Object.values(manifest.animations).flatMap(animation => animation.frames));
  assert.equal(images.size, usedFiles.size);
  for (const source of prompts.sourceAssets) {
    const image = images.get(source.file)!;
    assert.ok(usedFiles.has(source.file));
    assert.equal(image.hash, source.sha256, `${source.file} must remain the preserved original generated PNG`);
    assert.equal(image.bytes, source.bytes);
    assert.deepEqual({ width: image.width, height: image.height }, { width: source.width, height: source.height });
  }
  let differentSizedSources = false;
  for (const animation of Object.values(manifest.animations)) {
    for (const file of animation.frames) validateSkinImageSize(manifest, animation, file, images.get(file)!);
    const sourceShapes = new Set(animation.frames.map(file => `${images.get(file)!.width}x${images.get(file)!.height}`));
    if (sourceShapes.size > 1) differentSizedSources = true;
    for (let frame = 0; frame < 24; frame++) {
      const layout = skinFrameLayout(manifest, animation, frame), image = images.get(layout.frame)!;
      assert.deepEqual(layout.source, { width: image.width, height: image.height });
      assert.ok(layout.crop.x >= 0 && layout.crop.y >= 0 && layout.crop.x + layout.crop.width <= image.width && layout.crop.y + layout.crop.height <= image.height);
      assert.ok(Math.abs(layout.destination.y + layout.destination.height - manifest.height) < 1e-8, 'all complete source figures share the logical foot baseline');
    }
  }
  assert.ok(differentSizedSources, 'the real mixed 1254-square and 1448x1086 sources must remain covered');
});

test('reviewed locomotion ordering retains its starting pose and reduces jumps while success keeps its progression', async () => {
  const { selection, review } = await fixtures();
  for (const state of ['walking-right', 'running-right', 'walking-left', 'running-left']) {
    assert.equal(selection.find(item => item.state === state)!.sequence, 'smooth-loop');
    const sequence = review.states[state];
    assert.equal(sequence.appliedOrder[0], 0);
    assert.ok(sequence.appliedMetrics.mean <= sequence.before.mean);
    assert.ok(sequence.appliedMetrics.max <= sequence.before.max);
  }
  assert.deepEqual(review.states.success.appliedOrder, Array.from({ length: 24 }, (_, index) => index));
  assert.equal(review.states.success.appliedMetrics.seam, null);
});
