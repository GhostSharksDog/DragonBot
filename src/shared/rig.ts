import { pointInSpriteOutline, type Activity, type SpriteRegion } from './types';

export type RigFacing = 'front' | 'left' | 'right';
export type RigRole = 'static' | 'body' | 'skirt' | 'head' | 'hair-front' | 'hair-back' | 'arm-left' | 'arm-right' | 'forearm-left' | 'forearm-right' | 'leg-left' | 'leg-right' | 'calf-left' | 'calf-right' | 'foot-left' | 'foot-right' | 'wing-left' | 'wing-right' | 'tail' | 'eyes' | 'mouth';
export const RIG_ROLES: readonly RigRole[] = ['static', 'body', 'skirt', 'head', 'hair-front', 'hair-back', 'arm-left', 'arm-right', 'forearm-left', 'forearm-right', 'leg-left', 'leg-right', 'calf-left', 'calf-right', 'foot-left', 'foot-right', 'wing-left', 'wing-right', 'tail', 'eyes', 'mouth'];
export interface RigLayer {
  id: string;
  parent?: string;
  role: RigRole;
  file: string;
  sourceRegion: SpriteRegion;
  width: number;
  height: number;
  /** Position of this layer's pivot in the parent's untransformed local pixels. */
  x: number;
  y: number;
  pivot: { x: number; y: number };
  z: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  opacity?: number;
}
export interface RigDefinition {
  version: 1;
  views: Record<RigFacing, { layers: RigLayer[] }>;
  timing?: { walkMs?: number; runMs?: number; breathMs?: number; transitionMs?: number };
  /** Optional planted-foot two-bone gait, in logical canvas pixels. */
  gait?: { stride: number; footLift: number; hipDrop: number };
}
export interface RigControl { activity: Activity; motion: 'idle' | 'walking' | 'running'; direction: 'left' | 'right' }
export type RigMatrix = [number, number, number, number, number, number];
export interface RigLocalTransform { x: number; y: number; rotation: number; scaleX: number; scaleY: number; opacity: number }
export interface RigPoseLayer {
  id: string;
  facing: RigFacing;
  parent?: string;
  file: string;
  sourceRegion: SpriteRegion;
  width: number;
  height: number;
  pivot: { x: number; y: number };
  z: number;
  local: RigLocalTransform;
  matrix: RigMatrix;
  opacity: number;
}
export interface RigPose { facing: RigFacing; layers: RigPoseLayer[] }
export interface RigPlayback { control: RigControl; startedAt: number; fromPose?: RigPose }
export interface RigPoseSamplingOptions { loopDurationMs?: number }
export type RigAlphaSampler = (file: string, sourceX: number, sourceY: number) => number;

const TAU = Math.PI * 2;
const identity = (): RigMatrix => [1, 0, 0, 1, 0, 0];
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const lerp = (from: number, to: number, weight: number) => from + (to - from) * weight;
export function multiplyRigMatrices(a: RigMatrix, b: RigMatrix): RigMatrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
export function invertRigMatrix(matrix: RigMatrix): RigMatrix | null {
  const [a, b, c, d, e, f] = matrix, determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null;
  return [d / determinant, -b / determinant, -c / determinant, a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant];
}
export function transformRigPoint(matrix: RigMatrix, x: number, y: number) { return { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] }; }
function localMatrix(local: RigLocalTransform, pivot: { x: number; y: number }): RigMatrix {
  const radians = local.rotation * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  const a = cosine * local.scaleX, b = sine * local.scaleX, c = -sine * local.scaleY, d = cosine * local.scaleY;
  return [a, b, c, d, local.x - a * pivot.x - c * pivot.y, local.y - b * pivot.x - d * pivot.y];
}
function blendLocal(from: RigLocalTransform, to: RigLocalTransform, weight: number): RigLocalTransform {
  const rotationDelta = (((to.rotation - from.rotation + 180) % 360) + 360) % 360 - 180;
  return { x: lerp(from.x, to.x, weight), y: lerp(from.y, to.y, weight), rotation: from.rotation + rotationDelta * weight, scaleX: lerp(from.scaleX, to.scaleX, weight), scaleY: lerp(from.scaleY, to.scaleY, weight), opacity: lerp(from.opacity, to.opacity, weight) };
}
function effectiveMotion(control: RigControl) {
  if (control.activity === 'walking' || control.activity === 'running') return control.activity;
  return control.activity === 'idle' ? control.motion : 'idle';
}
function facingFor(control: RigControl): RigFacing { return effectiveMotion(control) === 'idle' ? 'front' : control.direction; }
function poseLocal(layer: RigLayer, control: RigControl, elapsed: number, timing: RigDefinition['timing'], depth: number, loopDurationMs?: number): RigLocalTransform {
  const local = { x: layer.x, y: layer.y, rotation: layer.rotation ?? 0, scaleX: layer.scaleX ?? 1, scaleY: layer.scaleY ?? 1, opacity: layer.opacity ?? 1 };
  const motion = effectiveMotion(control), moving = motion !== 'idle', run = motion === 'running';
  const period = (natural: number) => loopDurationMs ? loopDurationMs / Math.max(1, Math.round(loopDurationMs / natural)) : natural;
  const gait = TAU * elapsed / period(run ? timing?.runMs ?? 1800 : timing?.walkMs ?? 2400), breath = TAU * elapsed / period(timing?.breathMs ?? 4800);
  const stride = Math.sin(gait), softBreath = Math.sin(breath), side = layer.role.endsWith('-left') ? 1 : -1;
  const celebration = Math.sin(Math.PI * clamp(elapsed / (loopDurationMs ?? 2200))) ** 2;
  switch (layer.role) {
    case 'body':
      local.scaleY *= 1 + .0025 * softBreath;
      local.y -= moving ? (run ? 1.8 : 1) * (1 - Math.cos(gait * 2)) / 2 : .65 * softBreath;
      local.rotation += moving ? (control.direction === 'right' ? 1 : -1) * (run ? 1.3 : .4) : 0;
      break;
    case 'skirt':
      local.rotation += .35 * Math.sin(breath - .3) + (moving ? .65 * Math.sin(gait - .35) : 0);
      break;
    case 'head':
      local.rotation += .65 * Math.sin(breath + .25);
      if (control.activity === 'thinking') local.rotation += 3.5;
      if (control.activity === 'awaiting-input') local.rotation -= 2;
      if (control.activity === 'error') local.rotation += 2.5;
      if (moving) local.rotation += -.7 * Math.sin(gait * 2);
      break;
    case 'hair-front': case 'hair-back':
      local.rotation += (layer.role === 'hair-back' ? 1.3 : .65) * Math.sin(breath - .4 - depth * .15) + (moving ? .8 * Math.sin(gait - .6) : 0);
      break;
    case 'arm-left': case 'arm-right':
      local.rotation += moving ? -side * (run ? 7 : 4.5) * stride : side * .6 * softBreath;
      if (control.activity === 'success') local.rotation -= side * 15 * celebration;
      if (control.activity === 'awaiting-input' || control.activity === 'awaiting-approval') local.rotation -= side * 3;
      break;
    case 'forearm-left': case 'forearm-right':
      local.rotation += moving ? side * (run ? 4 : 2) * Math.sin(gait - .3) : 0;
      if (control.activity === 'thinking' && side === -1) local.rotation -= 10;
      break;
    case 'leg-left': case 'leg-right':
      local.rotation += moving ? side * (run ? 13 : 8) * stride : 0;
      break;
    case 'calf-left': case 'calf-right': {
      const travel = control.direction === 'right' ? 1 : -1;
      local.rotation += moving ? travel * (run ? 20 : 10) * Math.max(0, travel * side * stride) ** 2 : 0;
      break;
    }
    case 'foot-left': case 'foot-right':
      local.rotation += moving ? -side * (run ? 5 : 3) * Math.sin(gait - .25) : 0;
      break;
    case 'wing-left': case 'wing-right':
      local.rotation += side * (1.3 * Math.sin(breath - .3) + (moving ? 1.3 * Math.sin(gait - .7) : 0));
      if (control.activity === 'success') local.rotation -= side * 4 * celebration;
      break;
    case 'tail':
      local.rotation += 1.9 * Math.sin(breath - depth * .35) + (moving ? 1.5 * Math.sin(gait - depth * .4) : 0);
      break;
    case 'eyes': {
      const blinkPeriod = period(5400);
      const blinkPhase = loopDurationMs ? (elapsed % blinkPeriod - blinkPeriod * .55) / Math.min(105, blinkPeriod * .1) : ((elapsed + 1700) % 5400 - 2700) / 105;
      const closed = Math.abs(blinkPhase) < 1 ? Math.cos(blinkPhase * Math.PI / 2) ** 2 : 0;
      local.scaleY *= 1 - .93 * closed;
      break;
    }
    case 'mouth':
      local.scaleY *= control.activity === 'speaking' ? .3 + .7 * (.5 + .5 * Math.sin(TAU * elapsed / period(680))) : .35;
      break;
  }
  return local;
}
function resolveLayers(layers: RigPoseLayer[]): RigPoseLayer[] {
  const byId = new Map(layers.map(layer => [layer.id, layer])), resolved = new Set<string>(), resolving = new Set<string>();
  function resolve(layer: RigPoseLayer): void {
    if (resolved.has(layer.id)) return;
    if (resolving.has(layer.id)) throw new Error('角色骨骼层级存在循环。');
    resolving.add(layer.id);
    const parent = layer.parent ? byId.get(layer.parent) : undefined;
    if (layer.parent && !parent) throw new Error(`角色骨骼父层 ${layer.parent} 不存在。`);
    if (parent) resolve(parent);
    layer.matrix = multiplyRigMatrices(parent?.matrix ?? identity(), localMatrix(layer.local, layer.pivot));
    layer.opacity = clamp((parent?.opacity ?? 1) * layer.local.opacity);
    resolving.delete(layer.id); resolved.add(layer.id);
  }
  for (const layer of layers) resolve(layer);
  return layers.sort((a, b) => a.z - b.z);
}
function applyPlantedGait(rig: RigDefinition, definition: RigDefinition['views'][RigFacing], layers: RigPoseLayer[], control: RigControl, elapsed: number, loopDurationMs?: number): void {
  const motion = effectiveMotion(control);
  if (!rig.gait || motion === 'idle') return;
  const naturalPeriod = motion === 'running' ? rig.timing?.runMs ?? 1800 : rig.timing?.walkMs ?? 2400;
  const period = loopDurationMs ? loopDurationMs / Math.max(1, Math.round(loopDurationMs / naturalPeriod)) : naturalPeriod;
  const travel = control.direction === 'right' ? 1 : -1;
  const resting = resolveLayers(layers.map(layer => {
    const base = definition.layers.find(item => item.id === layer.id)!;
    return { ...layer, local: { x: base.x, y: base.y, rotation: base.rotation ?? 0, scaleX: base.scaleX ?? 1, scaleY: base.scaleY ?? 1, opacity: base.opacity ?? 1 }, matrix: identity() };
  }));
  resolveLayers(layers);
  for (const side of ['left', 'right'] as const) {
    const thigh = layers.find(layer => definition.layers.find(base => base.id === layer.id)?.role === `leg-${side}`);
    const calf = layers.find(layer => definition.layers.find(base => base.id === layer.id)?.role === `calf-${side}` && layer.parent === thigh?.id);
    if (!thigh || !calf || !thigh.parent) continue;
    const parent = layers.find(layer => layer.id === thigh.parent)!, inverseParent = invertRigMatrix(parent.matrix);
    if (!inverseParent) continue;
    const baseThigh = definition.layers.find(layer => layer.id === thigh.id)!, baseCalf = definition.layers.find(layer => layer.id === calf.id)!;
    const jointX = baseCalf.x - thigh.pivot.x, jointY = baseCalf.y - thigh.pivot.y;
    const upperLength = Math.hypot(jointX, jointY), lowerLength = calf.height - calf.pivot.y;
    if (upperLength < 1 || lowerLength < 1) continue;
    const phase = (elapsed / period + (side === 'right' ? .5 : 0)) % 1;
    let offsetX: number, lift = 0;
    if (phase < .5) offsetX = rig.gait.stride * (.5 - phase * 2);
    else {
      const t = (phase - .5) * 2;
      // Hermite swing matches the planted foot's backwards velocity at both
      // contact boundaries. Its slight overshoot avoids a visible speed snap.
      offsetX = rig.gait.stride * (-.5 - t + 6 * t * t - 4 * t * t * t);
      lift = rig.gait.footLift * Math.sin(Math.PI * t) ** 2;
    }
    const restCalf = resting.find(layer => layer.id === calf.id)!;
    const ground = transformRigPoint(restCalf.matrix, calf.pivot.x, calf.height);
    const endpoint = transformRigPoint(inverseParent, ground.x + travel * offsetX, ground.y - lift);
    thigh.local.y = baseThigh.y + rig.gait.hipDrop;
    const dx = endpoint.x - thigh.local.x, dy = endpoint.y - thigh.local.y;
    const cosine = clamp((dx * dx + dy * dy - upperLength ** 2 - lowerLength ** 2) / (2 * upperLength * lowerLength), -.999999, .999999);
    const knee = travel * Math.acos(cosine), jointAngle = Math.atan2(-jointX, jointY);
    thigh.local.rotation = (Math.atan2(-dx, dy) - Math.atan2(lowerLength * Math.sin(knee), upperLength + lowerLength * Math.cos(knee)) - jointAngle) * 180 / Math.PI;
    calf.local.rotation = (knee + jointAngle) * 180 / Math.PI;
  }
}
export function sampleRigPose(rig: RigDefinition, playback: RigPlayback, nowMs: number, options: RigPoseSamplingOptions = {}): RigPose {
  const loopDurationMs = options.loopDurationMs;
  if (loopDurationMs !== undefined && (!Number.isFinite(loopDurationMs) || loopDurationMs <= 0)) throw new Error('导出循环时长必须为正毫秒数。');
  const age = Math.max(0, nowMs - playback.startedAt), elapsed = loopDurationMs ? age % loopDurationMs : age, facing = facingFor(playback.control), definition = rig.views[facing];
  const depth = (layer: RigLayer): number => { let level = 0, current = layer, seen = new Set<string>(); while (current.parent && !seen.has(current.parent)) { seen.add(current.parent); const parent = definition.layers.find(candidate => candidate.id === current.parent); if (!parent) break; level++; current = parent; } return level; };
  const layers: RigPoseLayer[] = definition.layers.map(layer => ({ id: layer.id, parent: layer.parent, facing, file: layer.file, sourceRegion: layer.sourceRegion, width: layer.width, height: layer.height, pivot: layer.pivot, z: layer.z, local: poseLocal(layer, playback.control, elapsed, rig.timing, depth(layer), loopDurationMs), matrix: identity(), opacity: layer.opacity ?? 1 }));
  applyPlantedGait(rig, definition, layers, playback.control, elapsed, loopDurationMs);
  const transitionMs = rig.timing?.transitionMs ?? 250, progress = transitionMs > 0 ? clamp(elapsed / transitionMs) : 1, weight = progress * progress * (3 - 2 * progress);
  const from = loopDurationMs ? undefined : playback.fromPose;
  if (from && weight < 1 && from.layers.every(layer => layer.facing === facing)) {
    for (const layer of layers) {
      const previous = from.layers.find(candidate => candidate.id === layer.id);
      if (previous) layer.local = blendLocal(previous.local, layer.local, weight);
    }
    return { facing, layers: resolveLayers(layers) };
  }
  const target = resolveLayers(layers);
  if (!from || weight >= 1) return { facing, layers: target };
  // A turn settles one complete template, changes facing at its smallest size,
  // then eases into the new gait. Never overlay two heads or sets of limbs.
  const showingOld = progress < .5, visibleFacing = showingOld ? from.facing : facing;
  const visibleDefinition = rig.views[visibleFacing];
  const phase = showingOld ? progress * 2 : (progress - .5) * 2;
  const eased = phase * phase * (3 - 2 * phase);
  const shrink = showingOld ? lerp(1, .9, eased) : lerp(.9, 1, eased);
  const visible = (showingOld ? from.layers : target).map(layer => {
    const base = visibleDefinition.layers.find(candidate => candidate.id === layer.id)!;
    const resting: RigLocalTransform = { x: base.x, y: base.y, rotation: base.rotation ?? 0, scaleX: base.scaleX ?? 1, scaleY: base.scaleY ?? 1, opacity: base.opacity ?? 1 };
    const local = showingOld ? blendLocal(layer.local, resting, eased) : blendLocal(resting, layer.local, eased);
    if (!layer.parent) { local.scaleX *= shrink; local.scaleY *= shrink; }
    return { ...layer, local, matrix: identity() };
  });
  return { facing: visibleFacing, layers: resolveLayers(visible) };
}
export function transitionRigPlayback(rig: RigDefinition, previous: RigPlayback | undefined, control: RigControl, nowMs: number): RigPlayback {
  if (previous && previous.control.activity === control.activity && previous.control.motion === control.motion && previous.control.direction === control.direction) return previous;
  return { control: { ...control }, startedAt: nowMs, ...(previous ? { fromPose: sampleRigPose(rig, previous, nowMs) } : {}) };
}
export function rigHitTest(pose: RigPose, x: number, y: number, sampleAlpha: RigAlphaSampler, threshold = 24): boolean {
  let opacity = 0;
  for (let i = pose.layers.length - 1; i >= 0; i--) {
    const layer = pose.layers[i], inverse = invertRigMatrix(layer.matrix);
    if (!inverse || layer.opacity <= 0) continue;
    const local = transformRigPoint(inverse, x, y);
    if (local.x < 0 || local.y < 0 || local.x >= layer.width || local.y >= layer.height) continue;
    const sourceX = local.x / layer.width * layer.sourceRegion.width, sourceY = local.y / layer.height * layer.sourceRegion.height;
    if (!pointInSpriteOutline(layer.sourceRegion, sourceX, sourceY)) continue;
    const alpha = clamp(sampleAlpha(layer.file, layer.sourceRegion.x + sourceX, layer.sourceRegion.y + sourceY) / 255) * layer.opacity;
    opacity += (1 - opacity) * alpha;
    if (opacity * 255 > threshold) return true;
  }
  return false;
}
export function rigFiles(rig: RigDefinition): string[] { return [...new Set(Object.values(rig.views).flatMap(view => view.layers.map(layer => layer.file)))]; }
export function validateRigImageSize(rig: RigDefinition, file: string, size: { width: number; height: number }): void {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1 || size.width > 8192 || size.height > 8192) throw new Error(`角色部件图片 ${file} 的尺寸无效。`);
  for (const view of Object.values(rig.views)) for (const layer of view.layers) if (layer.file === file && (layer.sourceRegion.x + layer.sourceRegion.width > size.width || layer.sourceRegion.y + layer.sourceRegion.height > size.height)) throw new Error(`角色部件 ${layer.id} 的裁切区域超出图片 ${file}。`);
}
