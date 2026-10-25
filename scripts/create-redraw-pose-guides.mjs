import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// These are motion diagrams for ImageGen, never character artwork or runtime frames.
const SIZE = { width: 1448, height: 1086, columns: 6, rows: 4 };
const SCALE = .82;
const STANCE = .42;
const COLORS = { near: '#cf503a', far: '#397cc2', body: '#5d6a7e', eye: '#233045' };
const LIFT = [0, .1, .25, .45, .65, .85, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, .95, .85, .65, .45, .25, .1, .02, 0];
const point = (x, y) => ({ x, y });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const n = value => Number(value.toFixed(4));
const degrees = value => value * Math.PI / 180;

export function solveTwoBone(start, target, upper, lower, bend = 1) {
  const length = distance(start, target);
  assert(length > Math.abs(upper - lower) + 1e-6 && length < upper + lower - 1e-6, `Unreachable/locked IK: ${length}`);
  const ux = (target.x - start.x) / length, uy = (target.y - start.y) / length;
  const along = (upper * upper - lower * lower + length * length) / (2 * length);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));
  return { root: start, joint: point(start.x + along * ux - bend * height * uy, start.y + along * uy + bend * height * ux), end: target, upper, lower, bend };
}

function quadratic(a, b, c, t) {
  return point((1 - t) ** 2 * a.x + 2 * (1 - t) * t * b.x + t * t * c.x, (1 - t) ** 2 * a.y + 2 * (1 - t) * t * b.y + t * t * c.y);
}

export function thinkingPose(index) {
  assert(Number.isInteger(index) && index >= 0 && index < 24);
  const lift = LIFT[index], phase = index / 24;
  // A direct line would pass within ~4 px of the shoulder and fold the 23/26 IK.
  const hand = quadratic(point(62, 188), point(112, 180), point(110, 143), lift);
  const other = point(178 + .8 * Math.sin(phase * Math.PI * 2), 188 + .6 * Math.sin(phase * Math.PI * 2));
  return {
    index, lift, head: { x: 120, y: 89, rx: 60, ry: 49, angle: -4 * lift },
    eyes: index === 9 ? 'closed' : index === 8 || index === 10 ? 'half' : 'open',
    neck: point(120, 141), shoulders: [point(92, 155), point(148, 155)], hips: [point(110, 204), point(130, 204)],
    arms: [solveTwoBone(point(92, 155), hand, 23, 26, 1), solveTwoBone(point(148, 155), other, 23, 26, -1)],
    legs: [ { root: point(110, 204), joint: point(110, 231.5), end: point(110, 259) }, { root: point(130, 204), joint: point(130, 231.5), end: point(130, 259) } ],
  };
}

export function runningFoot(phase, lift = 12) {
  const p = ((phase % 1) + 1) % 1;
  if (p <= STANCE) return point(100 + 40 * p / STANCE, 259);
  const swing = (p - STANCE) / (1 - STANCE);
  return point(120 + 20 * Math.cos(Math.PI * swing), 259 - lift * Math.sin(Math.PI * swing));
}

function runningArm(root, phase, swingDegrees = 18) {
  // +/-18 degrees about the relaxed backswing axis. The other arm is half a cycle away.
  const angle = degrees(15 + swingDegrees * Math.cos(phase * Math.PI * 2));
  const joint = point(root.x + 23 * Math.sin(angle), root.y + 23 * Math.cos(angle));
  const forearm = angle - degrees(45);
  return { root, joint, end: point(joint.x + 26 * Math.sin(forearm), joint.y + 26 * Math.cos(forearm)), upper: 23, lower: 26 };
}

export function runningPose(index, { armSwing = 18, footLift = 12 } = {}) {
  const phase = index / 24;
  // Lowest at mid-stance (.21/.71), highest during the short flight (.46/.96).
  // Downward-only 0..2 px bob keeps the original 30/32 leg reach valid at touchdown.
  const bodyBob = 1 + Math.cos(4 * Math.PI * (phase - STANCE / 2));
  const hip = point(120, 201 + bodyBob);
  return {
    index, phase, bodyBob, facing: 'left', head: { x: 110, y: 89 + bodyBob, rx: 60, ry: 49, angle: 0 }, eyes: 'open', neck: point(110, 141 + bodyBob),
    shoulders: [point(110, 151 + bodyBob), point(116, 151 + bodyBob)], hips: [hip, hip],
    // Far is first, near is second so the near limb draws over the far limb.
    arms: [runningArm(point(110, 151 + bodyBob), phase + .5, armSwing), runningArm(point(116, 151 + bodyBob), phase, armSwing)],
    legs: [solveTwoBone(hip, runningFoot(phase + .5, footLift), 30, 32, 1), solveTwoBone(hip, runningFoot(phase, footLift), 30, 32, 1)],
  };
}

export function strongRunningPose(index) { return runningPose(index, { armSwing: 30, footLift: 16 }); }

function line(a, b, color = COLORS.body, width = 2.5, extra = '') {
  return `<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" ${extra}/>`;
}
function circle(p, color, radius = 2.3) { return `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${radius}" fill="white" stroke="${color}" stroke-width="1.5"/>`; }
function limb(bone, color, hand = false) {
  return line(bone.root, bone.joint, color, 3.1) + line(bone.joint, bone.end, color, 3.1) + circle(bone.root, color) + circle(bone.joint, color) + circle(bone.end, color, hand ? 3.4 : 2.4);
}
function foot(p, color) {
  return `<path d="M${n(p.x)},${n(p.y)} l-6,6 h12" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
}
function strongLimb(bone, color, hand = false) {
  const width = hand ? 8 : 9;
  const shape = `<path d="M${n(bone.root.x)},${n(bone.root.y)} L${n(bone.joint.x)},${n(bone.joint.y)} L${n(bone.end.x)},${n(bone.end.y)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const joints = [bone.root, bone.joint].map(p => `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${width / 2}" fill="${color}" stroke="#30445a" stroke-width=".7"/>`).join('');
  const palm = hand ? `<rect x="${n(bone.end.x - 5.5)}" y="${n(bone.end.y - 4.5)}" width="11" height="9" rx="2.8" fill="${color}" stroke="#30445a" stroke-width=".9"/>` : '';
  return shape + joints + palm;
}
function strongFoot(p, color) {
  return `<path d="M${n(p.x - 2)},${n(p.y - 1)} L${n(p.x + 5)},${n(p.y - 1)} L${n(p.x + 7)},${n(p.y + 6)} L${n(p.x - 10)},${n(p.y + 6)} L${n(p.x - 10)},${n(p.y + 3)} Z" fill="${color}" stroke="#30445a" stroke-width=".9" stroke-linejoin="round"/>`;
}
function head(pose) {
  const { x, y, rx, ry, angle } = pose.head;
  const left = pose.facing === 'left';
  const eyeY = y + 18;
  const eye = cx => pose.eyes === 'closed'
    ? `<path d="M${cx - 7},${eyeY} Q${cx},${eyeY + 2} ${cx + 7},${eyeY}" fill="none" stroke="${COLORS.eye}" stroke-width="2.4"/>`
    : `<ellipse cx="${cx}" cy="${eyeY}" rx="6" ry="${pose.eyes === 'half' ? 1.8 : 4.6}" fill="${COLORS.eye}"/>`;
  const nose = left ? `<path d="M${x - rx + 2},${y + 10} l-10,8 l11,3" fill="white" stroke="${COLORS.body}" stroke-width="2.4" stroke-linejoin="round"/>` : '';
  return `<g transform="rotate(${n(angle)} ${x} ${y})"><ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="white" stroke="${COLORS.body}" stroke-width="2.4"/>${nose}${line(point(x - (left ? 54 : 44), eyeY), point(x + (left ? 12 : 44), eyeY), '#a4afc0', 1, 'stroke-dasharray="3 3"')}${eye(x - (left ? 39 : 22))}${eye(x + (left ? -11 : 22))}${line(point(x - (left ? 25 : 0), y + 36), point(x - (left ? 25 : 0), y + 43), '#bdc6d2', 1)}</g>`;
}

function skeleton(pose, thinking, strong = false) {
  const [leftShoulder, rightShoulder] = pose.shoulders, [leftHip, rightHip] = pose.hips;
  const shoulderCenter = point((leftShoulder.x + rightShoulder.x) / 2, (leftShoulder.y + rightShoulder.y) / 2);
  const hipCenter = point((leftHip.x + rightHip.x) / 2, (leftHip.y + rightHip.y) / 2);
  const far = thinking ? 1 : 0, near = thinking ? 0 : 1;
  if (strong) return line(point(42, 265), point(198, 265), '#c5cedb', 1.2)
    + strongLimb(pose.legs[far], COLORS.far) + strongFoot(pose.legs[far].end, COLORS.far)
    + strongLimb(pose.arms[far], COLORS.far, true)
    + line(pose.neck, shoulderCenter, '#b5bec9', 7) + line(leftShoulder, rightShoulder, '#b5bec9', 7)
    + line(shoulderCenter, hipCenter, '#b5bec9', 8) + line(leftHip, rightHip, '#b5bec9', 7)
    + strongLimb(pose.legs[near], COLORS.near) + strongFoot(pose.legs[near].end, COLORS.near)
    + strongLimb(pose.arms[near], COLORS.near, true) + head(pose);
  return line(point(42, 265), point(198, 265), '#c5cedb', 1.2)
    + limb(pose.legs[far], COLORS.far) + foot(pose.legs[far].end, COLORS.far)
    + limb(pose.arms[far], COLORS.far, true)
    + line(pose.neck, shoulderCenter) + line(leftShoulder, rightShoulder)
    + line(shoulderCenter, hipCenter, COLORS.body, 3) + line(leftHip, rightHip)
    + limb(pose.legs[near], COLORS.near) + foot(pose.legs[near].end, COLORS.near)
    + limb(pose.arms[near], COLORS.near, true) + head(pose);
}

export function guideSvg(kind, { strong = false } = {}) {
  assert(['thinking', 'running-left'].includes(kind));
  assert(!strong || kind === 'running-left');
  const poses = Array.from({ length: 24 }, (_, index) => kind === 'thinking' ? thinkingPose(index) : strong ? strongRunningPose(index) : runningPose(index));
  const cells = poses.map((pose, index) => {
    const column = index % SIZE.columns, row = Math.floor(index / SIZE.columns);
    const x = Math.floor(column * SIZE.width / SIZE.columns), y = Math.floor(row * SIZE.height / SIZE.rows);
    const width = Math.floor((column + 1) * SIZE.width / SIZE.columns) - x, height = Math.floor((row + 1) * SIZE.height / SIZE.rows) - y;
    return `<g transform="translate(${x} ${y})"><rect width="${width}" height="${height}" fill="white" stroke="#d5dce6" stroke-width="1"/><text x="9" y="19" font-family="Arial,sans-serif" font-size="14" fill="#69788d">${index + 1}</text><g transform="translate(${width / 2} ${height / 2}) scale(${SCALE}) translate(-120 -135.75)">${skeleton(pose, kind === 'thinking', strong)}</g></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE.width}" height="${SIZE.height}" viewBox="0 0 ${SIZE.width} ${SIZE.height}">${cells}</svg>`;
}

export function verifyGuides() {
  const thinking = Array.from({ length: 24 }, (_, index) => thinkingPose(index));
  const running = Array.from({ length: 24 }, (_, index) => runningPose(index));
  const boneError = bone => Math.max(Math.abs(distance(bone.root, bone.joint) - bone.upper), Math.abs(distance(bone.joint, bone.end) - bone.lower));
  const error = Math.max(...thinking.flatMap(pose => pose.arms.map(boneError)), ...running.flatMap(pose => [...pose.arms, ...pose.legs].map(boneError)));
  assert(error < 1e-8, 'All IK segments retain their exact lengths.');
  assert.deepEqual(thinking[0].arms[0].end, point(62, 188));
  assert.deepEqual(thinking[6].arms[0].end, point(110, 143));
  assert.deepEqual(thinking[23].arms[0].end, point(62, 188));
  assert.deepEqual(thinking.slice(8, 11).map(pose => pose.eyes), ['half', 'closed', 'half']);
  for (let index = 1; index <= 6; index++) assert(thinking[index].arms[0].end.y < thinking[index - 1].arms[0].end.y, 'Every rising frame actually raises the hand.');
  for (const pose of running) {
    assert.deepEqual({ ...pose.head, y: 89 }, { ...running[0].head, y: 89 }, 'Head does not resize or tilt during the stride.');
    assert(Math.abs(pose.head.y - 89 - pose.bodyBob) < 1e-8 && pose.bodyBob >= 0 && pose.bodyBob <= 2, 'Whole torso and head share at most 2 px of bob.');
    for (const leg of pose.legs) assert(leg.joint.x < leg.root.x + ((leg.end.x - leg.root.x) * (leg.joint.y - leg.root.y) / (leg.end.y - leg.root.y)), 'Knees stay on the same forward IK branch.');
    assert(Math.abs(pose.legs[0].end.x - runningFoot(pose.phase + .5).x) < 1e-8);
    assert(Math.abs(pose.legs[1].end.x - runningFoot(pose.phase).x) < 1e-8);
  }
  const maximumStep = (poses, bones, part, loop) => Math.max(...poses.slice(0, loop ? poses.length : -1).flatMap((pose, index) => bones.map(bone => distance(pose[bone[0]][bone[1]][part], poses[(index + 1) % poses.length][bone[0]][bone[1]][part]))));
  const minimumHandReach = Math.min(...thinking.map(pose => distance(pose.arms[0].root, pose.arms[0].end)));
  const report = {
    purpose: 'Motion-only ImageGen reference; none of these colors, skeletons, numbers or grid lines belong in final character frames.',
    size: SIZE, diagramScale: SCALE, colors: { near: COLORS.near, far: COLORS.far },
    thinking: { lift: LIFT, handPath: { start: point(62, 188), control: point(112, 180), end: point(110, 143) }, minimumHandReach, maximumHandStep: maximumStep(thinking, [['arms', 0]], 'end', false), maximumElbowStep: maximumStep(thinking, [['arms', 0]], 'joint', false), headTiltDegrees: 4, blinkFramesOneBased: [9, 10, 11], poses: thinking },
    running: { upperLeg: 30, lowerLeg: 32, ankleBaseline: 259, soleBaseline: 265, stride: 40, lift: 12, phaseOffset: .5, stanceFraction: STANCE, flightWindows: [[.42, .5], [.92, 1]], framesWithBothFeetAirborne: running.filter(pose => pose.legs.every(leg => leg.end.y < 259 - 1e-6)).map(pose => pose.index + 1), bobRange: [0, 2], maximumFootStep: maximumStep(running, [['legs', 0], ['legs', 1]], 'end', true), maximumKneeStep: maximumStep(running, [['legs', 0], ['legs', 1]], 'joint', true), firstLastFootStep: distance(running[23].legs[1].end, running[0].legs[1].end), poses: running },
    maximumBoneLengthError: error,
  };
  assert(report.thinking.maximumElbowStep < 20, 'No elbow branch flip between adjacent frames.');
  assert(report.running.maximumKneeStep < 12, 'No knee branch flip, including the loop seam.');
  assert(report.running.maximumFootStep < 7);
  assert(report.running.firstLastFootStep < 4);
  assert.deepEqual(report.running.framesWithBothFeetAirborne, [12, 24], 'Two short flight windows are actually represented in the 24 frames.');
  for (const phase of [0, STANCE, .5, STANCE + .5, 1]) {
    const epsilon = 1e-8;
    assert(distance(runningFoot(phase - epsilon), runningFoot(phase + epsilon)) < 1e-4, 'Foot contact and toe-off positions are continuous.');
  }
  return report;
}

export async function createGuides(outputDirectory = '.local/redraw-pose-guides', kinds = ['thinking', 'running-left']) {
  assert(kinds.length && kinds.every(kind => ['thinking', 'running-left'].includes(kind)));
  const output = path.resolve(outputDirectory); await mkdir(output, { recursive: true });
  const report = verifyGuides();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: SIZE.width, height: SIZE.height }, deviceScaleFactor: 1 });
    for (const kind of kinds) {
      const svg = guideSvg(kind); await writeFile(path.join(output, `${kind}.svg`), svg);
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${SIZE.width}px;height:${SIZE.height}px;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`);
      await page.screenshot({ path: path.join(output, `${kind}.png`) });
    }
  } finally { await browser.close(); }
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, thinkingHandStep: report.thinking.maximumHandStep, thinkingElbowStep: report.thinking.maximumElbowStep, runningFootStep: report.running.maximumFootStep, runningKneeStep: report.running.maximumKneeStep, loopFootStep: report.running.firstLastFootStep, boneError: report.maximumBoneLengthError }));
}

export async function createStrongGuide(outputDirectory = '.local/redraw-pose-guides') {
  const output = path.resolve(outputDirectory); await mkdir(output, { recursive: true });
  const poses = Array.from({ length: 24 }, (_, index) => strongRunningPose(index));
  const dense = Array.from({ length: 2401 }, (_, index) => strongRunningPose(index / 100));
  let maximumBoneLengthError = 0;
  for (const pose of dense) for (const bone of [...pose.arms, ...pose.legs]) maximumBoneLengthError = Math.max(maximumBoneLengthError, Math.abs(distance(bone.root, bone.joint) - bone.upper), Math.abs(distance(bone.joint, bone.end) - bone.lower));
  assert(maximumBoneLengthError < 1e-8);
  for (const pose of dense) for (const leg of pose.legs) {
    const cross = (leg.end.x - leg.root.x) * (leg.joint.y - leg.root.y) - (leg.end.y - leg.root.y) * (leg.joint.x - leg.root.x);
    assert(cross > 0, 'Strong guide knees stay on the forward branch.');
  }
  assert(poses[0].arms[1].end.x > poses[0].hips[1].x && poses[0].arms[0].end.x < poses[0].hips[0].x, 'First contact has clearly opposite front/back hands.');
  assert(poses[12].arms[1].end.x < poses[12].hips[1].x && poses[12].arms[0].end.x > poses[12].hips[0].x, 'Half-stride swaps the front/back hands.');
  assert(poses.every(pose => pose.arms.every(arm => arm.end.y > 180)), 'Palms never remain tucked at the chest.');
  const maximumStep = (bones, part) => Math.max(...poses.flatMap((pose, index) => bones.map(bone => distance(pose[bone[0]][bone[1]][part], poses[(index + 1) % 24][bone[0]][bone[1]][part]))));
  const report = { purpose: 'Stronger motion-only reference. Final character frames must omit all skeleton colors, palm/shoe blocks, numbers, grid lines and gray body.', size: SIZE, diagramScale: SCALE, near: COLORS.near, far: COLORS.far, limbWidths: { arms: 8, legs: 9 }, armSwingDegrees: 30, footLift: 16, stride: 40, stanceFraction: STANCE, phaseOffset: .5, flightWindows: [[.42, .5], [.92, 1]], bobRange: [0, 2], denseSamples: dense.length, maximumBoneLengthError, maximumHandStep: maximumStep([['arms', 0], ['arms', 1]], 'end'), maximumKneeStep: maximumStep([['legs', 0], ['legs', 1]], 'joint'), maximumFootStep: maximumStep([['legs', 0], ['legs', 1]], 'end'), firstLastFootStep: distance(poses[23].legs[1].end, poses[0].legs[1].end), framesWithBothFeetAirborne: poses.filter(pose => pose.legs.every(leg => leg.end.y < 259 - 1e-6)).map(pose => pose.index + 1), poses };
  assert.deepEqual(report.framesWithBothFeetAirborne, [12, 24]);
  assert(report.maximumHandStep < 9 && report.maximumKneeStep < 10 && report.maximumFootStep < 7, 'Strong guide has no limb jumps.');
  const svg = guideSvg('running-left', { strong: true });
  await writeFile(path.join(output, 'running-left-strong.svg'), svg);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: SIZE.width, height: SIZE.height }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html,body{margin:0;overflow:hidden}svg{display:block}</style>${svg}`);
    await page.screenshot({ path: path.join(output, 'running-left-strong.png') });
  } finally { await browser.close(); }
  await writeFile(path.join(output, 'verification-strong.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, ...Object.fromEntries(Object.entries(report).filter(([key]) => !['poses', 'purpose'].includes(key))) }));
}

export async function createFourKeyGuide(outputDirectory = '.local/redraw-pose-guides') {
  const output = path.resolve(outputDirectory); await mkdir(output, { recursive: true });
  const selected = [0, 6, 12, 18].map(strongRunningPose);
  const [a, b, c, d] = selected;
  assert(a.legs[1].end.x < a.legs[0].end.x && c.legs[0].end.x < c.legs[1].end.x, 'A/C visibly exchange the front supporting leg.');
  assert(a.legs[1].end.y === 259 && c.legs[0].end.y === 259);
  assert(b.legs[0].joint.y < b.legs[1].joint.y && d.legs[1].joint.y < d.legs[0].joint.y, 'B/D visibly exchange the raised knee.');
  const labels = ['A  近腿前支撑 · 远腿在后', 'B  近腿后推 · 远膝前抬', 'C  远腿前支撑 · 近腿在后', 'D  远腿后推 · 近膝前抬'];
  const tile = 512, scale = SCALE * tile / (SIZE.height / SIZE.rows);
  const cells = selected.map((pose, index) => `<g transform="translate(${index % 2 * tile} ${Math.floor(index / 2) * tile})"><rect width="${tile}" height="${tile}" fill="white" stroke="#cad4e1"/><text x="20" y="33" font-family="Microsoft YaHei,Arial,sans-serif" font-size="21" fill="#344155">${labels[index]}</text><text x="20" y="58" font-family="Arial,sans-serif" font-size="14" fill="#718196">STRONG SOURCE ${pose.index + 1}</text><g transform="translate(${tile / 2} ${tile / 2}) scale(${scale}) translate(-120 -135.75)">${skeleton(pose, false, true)}</g><text x="26" y="489" font-family="Microsoft YaHei,Arial,sans-serif" font-size="18" fill="${COLORS.near}">红色 = 近侧肢体</text><text x="277" y="489" font-family="Microsoft YaHei,Arial,sans-serif" font-size="18" fill="${COLORS.far}">蓝色 = 远侧肢体</text></g>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${cells}</svg>`;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const filename = path.join(output, 'running-left-key4.png');
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}svg{display:block}</style>${svg}`);
    await page.screenshot({ path: filename });
  } finally { await browser.close(); }
  console.log(JSON.stringify({ filename, size: '1024x1024', sourceFramesOneBased: selected.map(pose => pose.index + 1), note: 'New motion-only PNG. Original guide SVG/PNGs and all character pixels are unchanged.' }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--key4')) await createFourKeyGuide();
  else if (process.argv.includes('--strong')) await createStrongGuide();
  else await createGuides(undefined, process.argv.includes('--only-running-left') ? ['running-left'] : undefined);
}
