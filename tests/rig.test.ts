import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSkin, validateRigDefinition } from '../src/main/skin';
import { invertRigMatrix, rigHitTest, sampleRigPose, transformRigPoint, transitionRigPlayback, validateRigImageSize, type RigControl, type RigDefinition, type RigLayer, type RigPlayback, type RigRole } from '../src/shared/rig';
import { drawRigPose } from '../src/shared/render-rig';

function layer(id: string, role: RigRole = 'static', patch: Partial<RigLayer> = {}): RigLayer {
  return { id, role, file: 'parts.png', sourceRegion: { x: 0, y: 0, width: 1, height: 1 }, x: 0, y: 0, width: 20, height: 30, pivot: { x: 0, y: 0 }, z: 0, ...patch };
}
function rigWith(layers: RigLayer[]): RigDefinition {
  return { version: 1, views: { front: { layers: structuredClone(layers) }, left: { layers: structuredClone(layers) }, right: { layers: structuredClone(layers) } }, timing: { runMs: 1800, walkMs: 2400, breathMs: 4800, transitionMs: 250 } };
}
const idle: RigControl = { activity: 'idle', motion: 'idle', direction: 'right' };
const run: RigControl = { activity: 'idle', motion: 'running', direction: 'right' };
const near = (value: number, expected: number) => assert.ok(Math.abs(value - expected) < 1e-8, `${value} should equal ${expected}`);

test('hierarchical pivots stay attached with child-before-parent definitions and invertible transforms', () => {
  const rig = rigWith([
    layer('child', 'static', { parent: 'parent', x: 30, y: 40, pivot: { x: 5, y: 6 }, z: 1 }),
    layer('parent', 'static', { x: 40, y: 50, pivot: { x: 10, y: 20 }, rotation: 90, width: 100, height: 100 }),
  ]);
  const unchanged = structuredClone(rig), pose = sampleRigPose(rig, { control: idle, startedAt: 0 }, 650);
  const parent = pose.layers.find(item => item.id === 'parent')!, child = pose.layers.find(item => item.id === 'child')!;
  const rootJoint = transformRigPoint(parent.matrix, 10, 20), childJoint = transformRigPoint(child.matrix, 5, 6);
  near(rootJoint.x, 40); near(rootJoint.y, 50); near(childJoint.x, 20); near(childJoint.y, 70);
  const global = transformRigPoint(child.matrix, 17, 23), back = transformRigPoint(invertRigMatrix(child.matrix)!, global.x, global.y);
  near(back.x, 17); near(back.y, 23);
  assert.deepEqual(rig, unchanged, 'sampling must not rewrite template positions or texture regions');
});

test('slow gait is continuous at 60 Hz, knees follow hips and breathing repeats every 4.8 seconds', () => {
  const rig = rigWith([
    layer('body'),
    layer('thigh', 'leg-left', { parent: 'body', x: 10, y: 20, height: 30, pivot: { x: 10, y: 0 } }),
    layer('calf', 'calf-left', { parent: 'thigh', x: 10, y: 28, pivot: { x: 10, y: 0 }, z: 1 }),
  ]);
  const playback = { control: run, startedAt: 0 };
  let previous = sampleRigPose(rig, playback, 0).layers.find(item => item.id === 'thigh')!.local.rotation;
  for (let frame = 1; frame <= 108; frame++) {
    const pose = sampleRigPose(rig, playback, frame * 1000 / 60), thigh = pose.layers.find(item => item.id === 'thigh')!, calf = pose.layers.find(item => item.id === 'calf')!;
    assert.ok(Math.abs(thigh.local.rotation - previous) < 1, 'the limb should move continuously instead of changing to a new drawn pose');
    const hipEnd = transformRigPoint(thigh.matrix, 10, 28), knee = transformRigPoint(calf.matrix, 10, 0);
    near(hipEnd.x, knee.x); near(hipEnd.y, knee.y); previous = thigh.local.rotation;
  }
  near(previous, 0);
  near(sampleRigPose(rig, playback, 450).layers.find(item => item.id === 'thigh')!.local.rotation, 13);
  assert.ok(sampleRigPose(rig, playback, 450).layers.find(item => item.id === 'calf')!.local.rotation > 0);
  const breathing = rigWith([layer('torso', 'body')]);
  const at = (ms: number) => sampleRigPose(breathing, { control: idle, startedAt: 0 }, ms).layers[0].local.scaleY;
  near(at(0), at(4800)); assert.ok(at(1200) > at(0));
});

test('250 ms transitions and interruption preserve the exact current bone pose', () => {
  const rig = rigWith([layer('body'), layer('head', 'head', { parent: 'body', z: 1 }), layer('mouth', 'mouth', { parent: 'head', z: 2 })]);
  const first: RigPlayback = { control: idle, startedAt: 0 };
  const before = sampleRigPose(rig, first, 1000);
  const speech = transitionRigPlayback(rig, first, { ...idle, activity: 'speaking' }, 1000);
  assert.deepEqual(sampleRigPose(rig, speech, 1000).layers.map(item => item.matrix), before.layers.map(item => item.matrix));
  const halfway = sampleRigPose(rig, speech, 1125), interrupted = transitionRigPlayback(rig, speech, { ...idle, activity: 'thinking' }, 1125);
  assert.deepEqual(sampleRigPose(rig, interrupted, 1125).layers.map(item => item.matrix), halfway.layers.map(item => item.matrix));
  const completed = sampleRigPose(rig, speech, 1250), direct = sampleRigPose(rig, { control: speech.control, startedAt: 1000 }, 1250);
  assert.deepEqual(completed.layers.map(item => item.matrix), direct.layers.map(item => item.matrix));
  assert.equal(transitionRigPlayback(rig, speech, speech.control, 2000), speech, 'unchanged assistant snapshots must not restart the animation clock');
});

test('turns finish on their independent template without mirroring costume textures', () => {
  const rig = rigWith([layer('body')]);
  rig.views.front.layers[0].file = 'front.png'; rig.views.left.layers[0].file = 'left.png'; rig.views.right.layers[0].file = 'right.png';
  const initial = { control: idle, startedAt: 0 }, next = transitionRigPlayback(rig, initial, { ...run, direction: 'left' }, 1000);
  assert.deepEqual(sampleRigPose(rig, next, 1000).layers.map(item => item.file), ['front.png']);
  assert.deepEqual(sampleRigPose(rig, next, 1124).layers.map(item => item.file), ['front.png']);
  assert.deepEqual(sampleRigPose(rig, next, 1125).layers.map(item => item.file), ['left.png']);
  assert.deepEqual(sampleRigPose(rig, next, 1250).layers.map(item => item.file), ['left.png']);
  for (let ms = 1000; ms <= 1250; ms++) {
    const pose = sampleRigPose(rig, next, ms);
    assert.equal(pose.layers.length, 1, 'a turn cannot overlay two complete characters');
    assert.equal(new Set(pose.layers.map(item => item.facing)).size, 1);
    assert.ok(pose.layers[0].opacity > .99, 'turns keep one opaque character visible');
  }
});

test('interpolation takes the short angular path even for multi-turn template rotations', () => {
  const rig = rigWith([layer('body', 'static', { rotation: -1000 })]);
  const fromRig = rigWith([layer('body', 'static', { rotation: 1000 })]);
  const fromPose = sampleRigPose(fromRig, { control: idle, startedAt: 0 }, 0);
  const middle = sampleRigPose(rig, { control: idle, startedAt: 0, fromPose }, 125);
  near(middle.layers[0].local.rotation, 1080);
});

test('export loop sampling closes every secondary motion with continuous seam velocity', () => {
  const rig = rigWith(['body', 'head', 'skirt', 'hair-front', 'hair-back', 'arm-left', 'arm-right', 'leg-left', 'leg-right', 'calf-left', 'calf-right', 'wing-left', 'wing-right', 'tail', 'eyes', 'mouth'].map((role, index) => layer(role, role as RigRole, { z: index })));
  const duration = 1800, options = { loopDurationMs: duration };
  for (const control of [run, idle, { ...idle, activity: 'speaking' as const }]) {
    const playback = { control, startedAt: 0 };
    const start = sampleRigPose(rig, playback, 0, options), end = sampleRigPose(rig, playback, duration, options);
    assert.deepEqual(end.layers.map(item => item.matrix), start.layers.map(item => item.matrix));
    const delta = .001, before = sampleRigPose(rig, playback, duration - delta, options), after = sampleRigPose(rig, playback, delta, options);
    for (let layerIndex = 0; layerIndex < start.layers.length; layerIndex++) for (let entry = 0; entry < 6; entry++) {
      const incoming = (start.layers[layerIndex].matrix[entry] - before.layers[layerIndex].matrix[entry]) / delta;
      const outgoing = (after.layers[layerIndex].matrix[entry] - start.layers[layerIndex].matrix[entry]) / delta;
      assert.ok(Math.abs(incoming - outgoing) < .00001, `${control.motion}/${start.layers[layerIndex].id} seam velocity must stay continuous`);
    }
  }
  const playback = { control: idle, startedAt: 0 };
  assert.notDeepEqual(sampleRigPose(rig, playback, 1800).layers[0].matrix, sampleRigPose(rig, playback, 0).layers[0].matrix, 'runtime breathing keeps its natural 4.8-second phase');
  assert.throws(() => sampleRigPose(rig, playback, 100, { loopDurationMs: 0 }));
});

test('hit testing uses the same inverse bone transform, source crop and concave outline', () => {
  const rig = rigWith([layer('piece', 'static', { x: 100, y: 200, width: 40, height: 20, pivot: { x: 20, y: 10 }, rotation: 90, sourceRegion: { x: 10, y: 20, width: 20, height: 10 } })]);
  const pose = sampleRigPose(rig, { control: idle, startedAt: 0 }, 0), piece = pose.layers[0];
  const visible = transformRigPoint(piece.matrix, 30, 5), transparent = transformRigPoint(piece.matrix, 5, 5);
  let sampled: [number, number] | undefined;
  const sample = (_file: string, x: number, y: number) => { sampled = [x, y]; return x >= 20 ? 255 : 0; };
  assert.equal(rigHitTest(pose, visible.x, visible.y, sample), true); near(sampled![0], 25); near(sampled![1], 22.5);
  assert.equal(rigHitTest(pose, transparent.x, transparent.y, sample), false);
  const clipped = rigWith([layer('shape', 'static', { width: 100, height: 200, sourceRegion: { x: 0, y: 0, width: 100, height: 200, outline: [[0, 0], [100, 0], [100, 70], [40, 70], [40, 200], [0, 200]] } })]);
  const clippedPose = sampleRigPose(clipped, { control: idle, startedAt: 0 }, 0);
  assert.equal(rigHitTest(clippedPose, 20, 150, () => 255), true);
  assert.equal(rigHitTest(clippedPose, 80, 150, () => { throw new Error('excluded silhouette must not sample a neighbor'); }), false);
  const faint = sampleRigPose(rigWith([layer('back', 'static', { opacity: .07 }), layer('front', 'static', { opacity: .07, z: 1 })]), { control: idle, startedAt: 0 }, 0);
  assert.equal(rigHitTest(faint, 10, 10, () => 255), true, 'overlapping translucent layers composite for click-through');
  assert.equal(rigHitTest({ ...faint, layers: faint.layers.slice(0, 1) }, 10, 10, () => 255), false);
});

test('shared canvas drawing applies pose matrices and runtime-only source cropping', () => {
  const rig = rigWith([layer('piece', 'static', { x: 10, y: 20, sourceRegion: { x: 3, y: 4, width: 5, height: 6 } })]);
  const pose = sampleRigPose(rig, { control: idle, startedAt: 0 }, 0), calls: { name: string; args: unknown[] }[] = [];
  const context = { globalAlpha: 1, save: () => {}, restore: () => {}, translate: (...args: unknown[]) => calls.push({ name: 'translate', args }), scale: (...args: unknown[]) => calls.push({ name: 'scale', args }), transform: (...args: unknown[]) => calls.push({ name: 'transform', args }), drawImage: (...args: unknown[]) => calls.push({ name: 'drawImage', args }) } as unknown as CanvasRenderingContext2D;
  const texture = {} as CanvasImageSource;
  drawRigPose(context, pose, new Map([['parts.png', texture]]), { scale: 2, x: 7, y: 8 });
  assert.deepEqual(calls.find(call => call.name === 'transform')!.args, pose.layers[0].matrix);
  assert.deepEqual(calls.find(call => call.name === 'drawImage')!.args, [texture, 3, 4, 5, 6, 0, 0, 20, 30]);
});

test('rig loader accepts fixed local PNG parts and rejects invalid hierarchy, bounds and paths', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dragon-rig-'));
  try {
    await fs.writeFile(path.join(directory, 'parts.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    const rig = rigWith([layer('body'), layer('head', 'head', { parent: 'body', z: 1 })]);
    const input = { name: '连续动画测试', width: 64, height: 64, anchor: { x: 32, y: 64 }, animations: {}, rig };
    const file = path.join(directory, 'skin.json');
    await fs.writeFile(file, JSON.stringify(input)); assert.equal((await loadSkin(file)).manifest.name, input.name);
    const invalid: RigDefinition[] = [];
    let changed = structuredClone(rig); changed.views.front.layers[0].parent = 'head'; invalid.push(changed);
    changed = structuredClone(rig); changed.views.front.layers[1].parent = 'missing'; invalid.push(changed);
    changed = structuredClone(rig); changed.views.front.layers[1].id = 'body'; invalid.push(changed);
    changed = structuredClone(rig); changed.views.front.layers[0].sourceRegion.width = 2; invalid.push(changed);
    changed = structuredClone(rig); changed.views.front.layers[0].scaleX = 0; invalid.push(changed);
    changed = structuredClone(rig); changed.views.front.layers[0].file = '../parts.png'; invalid.push(changed);
    changed = structuredClone(rig); changed.views.front.layers[0].file = 'https://example.com/p.png'; invalid.push(changed);
    changed = structuredClone(rig); changed.views.front.layers[0].file = 'animation.gif'; invalid.push(changed);
    changed = structuredClone(rig); changed.views.front.layers[0].file = '%2e%2e/parts.png'; invalid.push(changed);
    changed = structuredClone(rig); changed.timing!.runMs = 0; invalid.push(changed);
    changed = structuredClone(rig); changed.gait = { stride: Number.NaN, footLift: 24, hipDrop: 12 }; invalid.push(changed);
    changed = structuredClone(rig); changed.gait = { stride: 96, footLift: -1, hipDrop: 12 }; invalid.push(changed);
    changed = structuredClone(rig); changed.gait = { stride: 96, footLift: 24, hipDrop: 100 }; invalid.push(changed);
    for (const value of invalid) { await fs.writeFile(file, JSON.stringify({ ...input, rig: value })); await assert.rejects(loadSkin(file)); }
    assert.throws(() => validateRigDefinition({ version: 1, views: {} }));
    assert.throws(() => validateRigImageSize(rig, 'parts.png', { width: 0, height: 1 }));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
