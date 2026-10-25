import type { RoundedRect } from './bubble-shape';
export { pointInRoundedRect } from './bubble-shape';

/** Fixed-size control stays usable at every character scale and inside its window. */
export function petChatLauncherRect(width: number, height: number): RoundedRect {
  return { x: Math.max(0, width - 34), y: Math.max(6, Math.min(height - 30, Math.round(height * .25))), width: 30, height: 26, radius: 8 };
}
