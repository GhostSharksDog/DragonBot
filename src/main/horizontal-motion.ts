import type { Point, Rect } from './geometry';

export const ROAMING_TICK_MS = 1000 / 60;
export type HorizontalMotion = 'idle' | 'walking' | 'running';
export interface HorizontalMotionState extends Point {
  direction: 'left' | 'right';
  motion: HorizontalMotion;
  targetX: number | null;
  nextMoveAt: number;
  lastUpdateAt: number;
}

export function createHorizontalMotion(position: Point, now: number, waitMs = 4000): HorizontalMotionState {
  return { x: position.x, y: position.y, direction: 'right', motion: 'idle', targetX: null, nextMoveAt: now + waitMs, lastUpdateAt: now };
}

export function resetHorizontalMotion(state: HorizontalMotionState, position: Point, now: number, waitMs = 2000): HorizontalMotionState {
  return { ...state, x: position.x, y: position.y, motion: 'idle', targetX: null, nextMoveAt: now + waitMs, lastUpdateAt: now };
}

export function advanceHorizontalMotion(state: HorizontalMotionState, input: { now: number; paused: boolean; area: Rect; petWidth: number; scale: number; random?: () => number }): HorizontalMotionState {
  const { now, area, petWidth, scale, paused } = input, random = input.random ?? Math.random;
  const minX = area.x, maxX = area.x + Math.max(0, area.width - petWidth);
  const next = { ...state, x: Math.min(maxX, Math.max(minX, state.x)), lastUpdateAt: Math.max(now, state.lastUpdateAt) };
  if (paused || maxX === minX) return resetHorizontalMotion(next, next, next.lastUpdateAt);
  if (next.targetX === null && now >= next.nextMoveAt) {
    let targetX = minX + random() * (maxX - minX);
    if (Math.abs(targetX - next.x) < Math.min(40 * scale, (maxX - minX) / 3)) targetX = next.x < (minX + maxX) / 2 ? maxX : minX;
    next.targetX = targetX;
    next.motion = 'running';
    next.direction = targetX < next.x ? 'left' : 'right';
  }
  if (next.targetX === null) return next;
  next.targetX = Math.min(maxX, Math.max(minX, next.targetX));
  const distance = next.targetX - next.x;
  const seconds = Math.max(0, Math.min(.1, (now - state.lastUpdateAt) / 1000));
  const step = 36 * scale * seconds;
  if (Math.abs(distance) <= step) {
    next.x = next.targetX;
    next.targetX = null;
    next.motion = 'idle';
    next.nextMoveAt = now + 2500 + random() * 6000;
  } else next.x += Math.sign(distance) * step;
  return next;
}
