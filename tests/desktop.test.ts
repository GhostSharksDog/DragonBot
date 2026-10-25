import test from 'node:test';
import assert from 'node:assert/strict';
import { bubbleBounds, quickBubbleBounds, clampRect, distanceToRect } from '../src/main/geometry';
import { validateSettings } from '../src/main/settings';
import { advanceHorizontalMotion, createHorizontalMotion, resetHorizontalMotion } from '../src/main/horizontal-motion';
test('display removal and small workareas clamp pet and bubble into view', () => {
  const area = { x: -1280, y: 0, width: 1280, height: 720 };
  const pet = clampRect({ x: 1900, y: 1100, width: 200, height: 240 }, area);
  assert.deepEqual(pet, { x: -200, y: 480, width: 200, height: 240 });
  const bubble = bubbleBounds(pet, area);
  assert.ok(bubble.x >= area.x && bubble.x + bubble.width <= 0);
  assert.ok(bubble.y >= 0 && bubble.y + bubble.height <= 720);
  assert.equal(distanceToRect({ x: -100, y: 500 }, pet), 0);
});
test('settings reject invalid scales, credentials and non-http website grants', () => {
  const s = validateSettings({ scale: Infinity, grant: { folders: ['relative'], origins: ['https://example.com/path', 'file:///C:/', 'https://user:secret@example.com'] } });
  assert.equal(s.scale, 1);
  assert.deepEqual(s.grant, { folders: [], origins: ['https://example.com'] });
  assert.equal(validateSettings({ scale: 9 }).scale, 1.7);
});

test('gentle jogging preserves the dropped y and 36 pixels per second across scales and refresh rates', () => {
  const area = { x: 0, y: 0, width: 2000, height: 1000 };
  for (const scale of [.6, 1, 1.7]) {
    for (const hz of [30, 60]) {
      const input = { area, petWidth: 200, scale, paused: false, random: () => 1 };
      let state = advanceHorizontalMotion(createHorizontalMotion({ x: 100, y: 317 }, 0, 0), { ...input, now: 0 });
      assert.equal(state.direction, 'right'); assert.equal(state.motion, 'running');
      for (let frame = 1; frame <= hz; frame++) {
        state = advanceHorizontalMotion(state, { ...input, now: frame * 1000 / hz });
        assert.equal(state.y, 317);
      }
      assert.ok(Math.abs(state.x - (100 + 36 * scale)) < .000001, `${hz} Hz at ${scale} scale retains subpixel travel`);
    }
  }
});

test('running left stays horizontal, reaches the exact boundary and stops without overshooting', () => {
  const area = { x: -1000, y: -600, width: 1600, height: 1000 };
  const input = { area, petWidth: 200, scale: 1, paused: false, random: () => 0 };
  let state = advanceHorizontalMotion(createHorizontalMotion({ x: -900, y: -217 }, 0, 0), { ...input, now: 0 });
  assert.equal(state.direction, 'left'); assert.equal(state.motion, 'running');
  for (let frame = 1; frame <= 180; frame++) {
    state = advanceHorizontalMotion(state, { ...input, now: frame * 1000 / 60 });
    assert.equal(state.y, -217); assert.ok(state.x >= -1000);
  }
  assert.equal(state.x, -1000); assert.equal(state.targetX, null); assert.equal(state.motion, 'idle');
});

test('attention pauses clear movement and drag establishes a new fixed horizontal baseline', () => {
  const input = { area: { x: 0, y: 0, width: 2000, height: 1200 }, petWidth: 200, scale: 1, paused: false, random: () => 1 };
  let state = advanceHorizontalMotion(createHorizontalMotion({ x: 100, y: 600 }, 0, 0), { ...input, now: 0 });
  state = advanceHorizontalMotion(state, { ...input, now: 16 });
  const stoppedX = state.x;
  state = advanceHorizontalMotion(state, { ...input, now: 32, paused: true });
  assert.equal(state.motion, 'idle'); assert.equal(state.targetX, null); assert.equal(state.x, stoppedX);
  state = advanceHorizontalMotion(state, { ...input, now: 2000, paused: true });
  assert.equal(state.x, stoppedX); assert.equal(state.y, 600);
  state = resetHorizontalMotion(state, { x: 470, y: 291 }, 2100, 0);
  state = advanceHorizontalMotion(state, { ...input, now: 2100 });
  for (let frame = 1; frame <= 60; frame++) {
    state = advanceHorizontalMotion(state, { ...input, now: 2100 + frame * 1000 / 60 });
    assert.equal(state.y, 291);
  }
  assert.ok(Math.abs(state.x - 506) < .000001);
});

test('clock stalls are bounded and a pet as wide as the workarea cannot roam', () => {
  const input = { area: { x: 20, y: 0, width: 1200, height: 900 }, petWidth: 200, scale: 1, paused: false, random: () => 1 };
  let state = advanceHorizontalMotion(createHorizontalMotion({ x: 100, y: 193 }, 0, 0), { ...input, now: 0 });
  state = advanceHorizontalMotion(state, { ...input, now: 10000 });
  assert.ok(Math.abs(state.x - 103.6) < .000001); assert.equal(state.y, 193);
  const before = state.x;
  state = advanceHorizontalMotion(state, { ...input, now: 9000 });
  assert.equal(state.x, before); assert.equal(state.lastUpdateAt, 10000);
  state = advanceHorizontalMotion(state, { ...input, now: 10010, petWidth: 1200 });
  assert.equal(state.x, 20); assert.equal(state.y, 193); assert.equal(state.motion, 'idle');
});

test('quick bubbles follow the head, switch sides at screen edges and cap their height', () => {
  const area = { x: -1280, y: -100, width: 1280, height: 720 };
  const left = quickBubbleBounds({ x: -1270, y: 200, width: 200, height: 240 }, area);
  assert.equal(left.width, 320); assert.equal(left.height, 180); assert.equal(left.x, -1080);
  const right = quickBubbleBounds({ x: -210, y: 350, width: 200, height: 240 }, area, 999);
  assert.equal(right.height, 360); assert.equal(right.x, -520);
  for (const rectangle of [left, right, quickBubbleBounds({ x: -300, y: -100, width: 200, height: 240 }, area, 360)]) {
    assert(rectangle.x >= area.x + 8 && rectangle.x + rectangle.width <= area.x + area.width - 8);
    assert(rectangle.y >= area.y + 8 && rectangle.y + rectangle.height <= area.y + area.height - 8);
  }
  const small = quickBubbleBounds({ x: 100, y: 100, width: 200, height: 240 }, { x: 0, y: 0, width: 240, height: 260 }, 360);
  assert.equal(small.width, 224); assert.equal(small.height, 244);
  assert(small.x >= 8 && small.x + small.width <= 232 && small.y >= 8 && small.y + small.height <= 252);
});
