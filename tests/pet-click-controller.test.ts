import test from 'node:test';
import assert from 'node:assert/strict';
import { PetClickController } from '../src/renderer/pet-click-controller';

function fixture() {
  let time = 0, next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>(), events: unknown[] = [];
  const controller = new PetClickController({ now: () => time, schedule: (callback, delay) => { timers.set(++next, { at: time + delay, callback }); return next; }, clear: timer => { timers.delete(timer as number); }, single: () => events.push('single'), double: () => events.push('quota'), drag: (x, y) => events.push(['drag', x, y]) });
  const advance = (delta: number) => { time += delta; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); } };
  const click = () => { controller.down({ x: 10, y: 20 }); controller.up({ x: 10, y: 20 }); };
  return { controller, events, advance, click };
}
test('single waits 300ms, a second click at 299ms opens quota once, and a third is consumed', () => {
  const first = fixture(); first.click(); first.advance(299); assert.deepEqual(first.events, []); first.advance(1); assert.deepEqual(first.events, ['single']);
  const pair = fixture(); pair.click(); pair.advance(299); pair.click(); pair.advance(1); pair.click(); pair.advance(600); assert.deepEqual(pair.events, ['quota']);
  const separate = fixture(); separate.click(); separate.advance(301); separate.click(); separate.advance(300); assert.deepEqual(separate.events, ['single', 'single']);
});
test('second press pauses the first timer and turns into a drag without either click action', () => {
  const { controller, events, advance, click } = fixture();
  click(); advance(200); controller.down({ x: 11, y: 20 }); advance(300);
  assert.deepEqual(events, []);
  controller.move({ x: 14, y: 20 }); assert.deepEqual(events, []);
  controller.move({ x: 17, y: 20 }); controller.up({ x: 19, y: 22 }); advance(500);
  assert.deepEqual(events, [['drag', 6, 0], ['drag', 2, 2]]);
});
test('cancel, right-menu cancellation and lost capture discard queued clicks; drag preserves threshold travel', () => {
  const { controller, events, advance, click } = fixture();
  click(); controller.cancel(); advance(500); assert.deepEqual(events, []);
  controller.down({ x: 0, y: 0 }); assert.equal(controller.pressed, true); controller.cancel(); controller.up({ x: 0, y: 0 }); advance(500); assert.deepEqual(events, []);
  controller.down({ x: 0, y: 0 }); controller.move({ x: 3, y: 0 }); controller.move({ x: 5, y: 0 }); controller.up({ x: 8, y: 0 }); advance(500);
  assert.deepEqual(events, [['drag', 5, 0], ['drag', 3, 0]]);
});
