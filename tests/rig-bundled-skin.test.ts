import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadSkin } from '../src/main/skin';
import { rigFiles, sampleRigPose, transformRigPoint, transitionRigPlayback, validateRigImageSize, type RigControl } from '../src/shared/rig';
import type { SpriteRegion } from '../src/shared/types';

interface PartEvidence {
  index: number; role: string; sourceRegion: SpriteRegion; componentCount: number;
  edgeTouches: string[];
  outlineValidation: { ownPixels: number; retainedOwn: number; ownCoverage: number; foreignPixelsKept: number; points: number };
}
interface SourceEvidence {
  sha256: string; sourceWidth: number; sourceHeight: number; sourceBytes: number;
  parts: PartEvidence[]; auxiliaryParts: (PartEvidence & { id: string })[]; errors: unknown[];
}
const directory = path.resolve('assets/skins/silver-dragon-rig');
const sources = { front: 'parts-front-v2.png', left: 'parts-left-v1.png', right: 'parts-right-v1.png' } as const;
async function readFixtures() {
  const [skin, rawGeometry] = await Promise.all([loadSkin(path.join(directory, 'skin.json')), fs.readFile('docs/imagegen/v040/parts-geometry.json', 'utf8')]);
  const geometry = JSON.parse(rawGeometry) as { files: Record<string, SourceEvidence> };
  assert.ok(skin.manifest.rig, 'the legacy fixture remains readable as fixed-part animation');
  return { manifest: skin.manifest, rig: skin.manifest.rig!, geometry };
}
let cached: ReturnType<typeof readFixtures> | undefined;
const fixtures = () => cached ??= readFixtures();

test('legacy rig fixture retains three independent fixed-part templates with attached joints', async () => {
  const { manifest, rig } = await fixtures();
  assert.deepEqual({ width: manifest.width, height: manifest.height, anchor: manifest.anchor }, { width: 512, height: 640, anchor: { x: 256, y: 620 } });
  assert.deepEqual(manifest.animations, {}, 'the legacy rig fixture retains its original continuous format');
  assert.deepEqual(rigFiles(rig).sort(), Object.values(sources).sort());
  assert.deepEqual(rig.timing, { walkMs: 2400, runMs: 1800, breathMs: 4800, transitionMs: 250 });
  for (const [facing, file] of Object.entries(sources)) {
    const layers = rig.views[facing as keyof typeof sources].layers;
    assert.equal(layers.length, 17);
    assert.equal(new Set(layers.map(layer => layer.id)).size, layers.length);
    for (const layer of layers) { assert.equal(layer.file, file); assert.ok((layer.scaleX ?? 1) > 0); assert.ok((layer.scaleY ?? 1) > 0); }
    for (const role of ['body', 'head', 'skirt', 'hair-back', 'hair-front', 'arm-left', 'arm-right', 'leg-left', 'leg-right', 'calf-left', 'calf-right', 'wing-left', 'wing-right', 'tail', 'eyes', 'mouth']) assert.equal(layers.filter(layer => layer.role === role).length, 1, `${facing}/${role}`);
    const byId = new Map(layers.map(layer => [layer.id, layer]));
    assert.equal(byId.get('head')!.parent, 'body');
    for (const side of ['left', 'right']) {
      assert.equal(byId.get(`leg-${side}`)!.parent, 'body');
      assert.equal(byId.get(`calf-${side}`)!.parent, `leg-${side}`);
    }
    for (const feature of ['eyes', 'mouth', 'eyebrows', 'hair-front']) assert.equal(byId.get(feature)!.parent, 'head');
  }
});

test('all fixed part pixels, concave outlines, eyes and front locks match read-only inspection', async () => {
  const { rig, geometry } = await fixtures();
  for (const [facing, file] of Object.entries(sources)) {
    const source = geometry.files[file]; assert.deepEqual(source.errors, []);
    const bytes = await fs.readFile(path.join(directory, file));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256, `${file} must remain the unmodified ImageGen output`);
    assert.equal(bytes.length, source.sourceBytes);
    const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    assert.deepEqual(size, { width: source.sourceWidth, height: source.sourceHeight });
    validateRigImageSize(rig, file, size);
    const layers = rig.views[facing as keyof typeof sources].layers;
    for (const layer of layers) {
      const evidence = layer.id === 'eyebrows' ? source.auxiliaryParts.find(part => part.id === layer.id)! : source.parts.find(part => part.role === layer.role)!;
      assert.ok(evidence, `${facing}/${layer.id} requires inspected component evidence`);
      assert.deepEqual(layer.sourceRegion, evidence.sourceRegion);
      assert.deepEqual(evidence.edgeTouches ?? [], []);
      const valid = evidence.outlineValidation;
      assert.ok(valid.ownPixels > 0); assert.equal(valid.ownCoverage, 1); assert.equal(valid.retainedOwn, valid.ownPixels); assert.equal(valid.foreignPixelsKept, 0);
      assert.equal(valid.points, layer.sourceRegion.outline!.length);
      assert.ok(valid.points >= 3 && valid.points <= 2048);
      for (const [x, y] of layer.sourceRegion.outline!) assert.ok(x >= 0 && y >= 0 && x <= layer.sourceRegion.width && y <= layer.sourceRegion.height);
    }
    assert.equal(source.parts[13].componentCount, 2, 'both eyes survive clipping');
    assert.equal(source.parts[15].componentCount, 2, 'both framing hair locks survive clipping');
    assert.ok(source.parts[14].outlineValidation.ownPixels > 0, 'the small mouth cannot disappear as noise');
  }
});

test('real templates retain one head and stable part sources throughout all activities and slow gaits', async () => {
  const { rig, manifest } = await fixtures();
  const controls: RigControl[] = ['idle', 'speaking', 'thinking', 'awaiting-input', 'awaiting-approval', 'success', 'error'].map(activity => ({ activity, motion: 'idle', direction: 'right' }) as RigControl);
  for (const direction of ['left', 'right'] as const) for (const motion of ['walking', 'running'] as const) controls.push({ activity: 'idle', direction, motion });
  for (const control of controls) for (let ms = 0; ms <= 3000; ms += 100) {
    const pose = sampleRigPose(rig, { control, startedAt: 0 }, ms);
    assert.equal(pose.layers.filter(layer => layer.id === 'head').length, 1);
    assert.equal(pose.layers.length, 17);
    const template = rig.views[pose.facing];
    for (const layer of pose.layers) {
      const original = template.layers.find(item => item.id === layer.id)!;
      assert.equal(layer.file, original.file); assert.equal(layer.sourceRegion, original.sourceRegion, 'states transform one fixed texture instead of replacing its design');
      for (const entry of layer.matrix) assert.ok(Number.isFinite(entry));
      for (const [sx, sy] of layer.sourceRegion.outline!) {
        const point = transformRigPoint(layer.matrix, sx / layer.sourceRegion.width * layer.width, sy / layer.sourceRegion.height * layer.height);
        assert.ok(point.x >= 0 && point.x <= manifest.width && point.y >= 0 && point.y <= manifest.height, `${control.activity}/${control.motion}/${layer.id} at ${ms} remains on the transparent canvas`);
      }
    }
    for (const side of ['left', 'right']) {
      const thigh = pose.layers.find(layer => layer.id === `leg-${side}`)!, calf = pose.layers.find(layer => layer.id === `calf-${side}`)!;
      const target = transformRigPoint(thigh.matrix, calf.local.x, calf.local.y), joint = transformRigPoint(calf.matrix, calf.pivot.x, calf.pivot.y);
      assert.ok(Math.abs(target.x - joint.x) < 1e-8 && Math.abs(target.y - joint.y) < 1e-8);
    }
  }
});

test('legacy rig slow-jog support feet match 36 px/s travel and preserve contact velocity', async () => {
  const { rig } = await fixtures();
  assert.deepEqual(rig.gait, { stride: 96, footLift: 24, hipDrop: 12 });
  const duration = rig.timing!.runMs!, physicalScale = (240 - 24) / 640;
  for (const direction of ['left', 'right'] as const) {
    const control: RigControl = { activity: 'idle', motion: 'running', direction }, sign = direction === 'right' ? 1 : -1;
    const point = (ms: number, side = 'left') => {
      const pose = sampleRigPose(rig, { control, startedAt: 0 }, ms), calf = pose.layers.find(layer => layer.id === `calf-${side}`)!;
      return transformRigPoint(calf.matrix, calf.pivot.x, calf.height);
    };
    const first = point(0);
    for (let ms = 0; ms <= duration / 2; ms += 15) {
      const foot = point(ms);
      assert.ok(Math.abs(foot.y - 620) < 1e-7, 'the support sole stays on the ground despite torso breathing, bob and tilt');
      const worldX = (foot.x - first.x) * physicalScale + sign * 36 * ms / 1000;
      assert.ok(Math.abs(worldX) < 1e-7, 'the planted foot cancels horizontal desktop travel instead of sliding');
    }
    const middleSwing = point(duration * .75);
    assert.ok(middleSwing.y <= 596.00001, 'the returning foot visibly lifts off the floor');
    for (const seam of [duration / 2, duration]) {
      const step = .001, before = point(seam - step), at = point(seam), after = point(seam + step);
      for (const axis of ['x', 'y'] as const) assert.ok(Math.abs((at[axis] - before[axis]) / step - (after[axis] - at[axis]) / step) < .00001, 'contact position and velocity must remain continuous');
    }
    assert.deepEqual(point(0), point(7200), 'four cycles form an exact export seam');
  }
});

test('real turns never overlay heads and exported long loops close all secondary motions', async () => {
  const { rig } = await fixtures();
  const controls: RigControl[] = [{ activity: 'idle', motion: 'idle', direction: 'right' }, { activity: 'idle', motion: 'running', direction: 'left' }, { activity: 'idle', motion: 'running', direction: 'right' }];
  for (const from of controls) for (const to of controls) {
    const playback = transitionRigPlayback(rig, { control: from, startedAt: 0 }, to, 1000);
    for (let ms = 1000; ms <= 1250; ms += 5) {
      const pose = sampleRigPose(rig, playback, ms);
      assert.equal(pose.layers.length, 17);
      assert.equal(pose.layers.filter(layer => layer.id === 'head').length, 1);
      assert.equal(new Set(pose.layers.map(layer => layer.facing)).size, 1);
    }
  }
  for (const control of controls) {
    const duration = control.motion === 'running' ? 7200 : 5400, options = { loopDurationMs: duration }, playback = { control, startedAt: 0 };
    const start = sampleRigPose(rig, playback, 0, options), end = sampleRigPose(rig, playback, duration, options);
    assert.deepEqual(end, start);
    const delta = .001, before = sampleRigPose(rig, playback, duration - delta, options), after = sampleRigPose(rig, playback, delta, options);
    for (let layer = 0; layer < start.layers.length; layer++) for (let entry = 0; entry < 6; entry++) {
      const incoming = (start.layers[layer].matrix[entry] - before.layers[layer].matrix[entry]) / delta;
      const outgoing = (after.layers[layer].matrix[entry] - start.layers[layer].matrix[entry]) / delta;
      assert.ok(Math.abs(incoming - outgoing) < .0001, `${control.direction}/${start.layers[layer].id} long-loop velocity seam`);
    }
  }
});
