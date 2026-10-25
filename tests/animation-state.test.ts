import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveAnimationKey, roamingAnimationMotion } from '../src/shared/animation-state';
import type { SkinManifest } from '../src/shared/types';

const pose = { frames: ['pose.png'], fps: 12 };
const stationary: SkinManifest = { name: '静态动作', width: 272, height: 272, anchor: { x: 136, y: 264 }, animations: { idle: pose, thinking: pose } };

test('unsupported task states share the real idle key so token updates do not restart its clock', () => {
  assert.equal(effectiveAnimationKey(stationary, 'thinking', 'idle', 'right'), 'thinking');
  for (const state of ['idle', 'speaking', 'awaiting-input', 'awaiting-approval', 'success', 'error'] as const) {
    assert.equal(effectiveAnimationKey(stationary, state, 'idle', 'right'), 'idle');
  }
  assert.equal(effectiveAnimationKey(stationary, 'idle', 'running', 'left'), 'idle');
});

test('roaming requires complete movement in both directions while imported walking skins remain usable', () => {
  assert.equal(roamingAnimationMotion(null), null);
  assert.equal(roamingAnimationMotion(stationary), null);
  const oneSide = { ...stationary, animations: { ...stationary.animations, 'running-left': pose } };
  assert.equal(roamingAnimationMotion(oneSide), null);
  const walking = { ...stationary, animations: { ...stationary.animations, 'walking-left': pose, 'walking-right': pose } };
  assert.equal(roamingAnimationMotion(walking), 'walking');
  assert.equal(effectiveAnimationKey(walking, 'idle', 'walking', 'left'), 'walking-left');
  const running = { ...walking, animations: { ...walking.animations, 'running-left': pose, 'running-right': pose } };
  assert.equal(roamingAnimationMotion(running), 'running');
  assert.equal(effectiveAnimationKey(running, 'idle', 'running', 'right'), 'running-right');
});
