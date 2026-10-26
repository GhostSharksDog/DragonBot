export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export function clampRect(rect: Rect, area: Rect): Rect {
  const width = Math.min(rect.width, area.width), height = Math.min(rect.height, area.height);
  return { x: Math.round(Math.min(Math.max(rect.x, area.x), area.x + area.width - width)), y: Math.round(Math.min(Math.max(rect.y, area.y), area.y + area.height - height)), width: Math.round(width), height: Math.round(height) };
}
export function bubbleBounds(pet: Rect, area: Rect, preferred = { width: 440, height: 680 }): Rect {
  const width = Math.min(preferred.width, area.width - 16), height = Math.min(preferred.height, area.height - 16);
  const right = pet.x + pet.width + 10;
  const x = right + width <= area.x + area.width - 8 ? right : pet.x - width - 10;
  return clampRect({ x, y: pet.y + pet.height - height, width, height }, { x: area.x + 8, y: area.y + 8, width: area.width - 16, height: area.height - 16 });
}
export function quickBubbleBounds(pet: Rect, area: Rect, preferredHeight = 180, preferredWidth = 320): Rect {
  const width = Math.min(preferredWidth, Math.max(80, area.width - 16)), height = Math.min(Math.max(88, Math.min(360, preferredHeight)), Math.max(80, area.height - 16));
  const headY = pet.y + pet.height * .28, right = pet.x + pet.width - 10;
  const x = right + width <= area.x + area.width - 8 ? right : pet.x - width + 10;
  return clampRect({ x, y: headY - height + 44, width, height }, { x: area.x + 8, y: area.y + 8, width: Math.max(80, area.width - 16), height: Math.max(80, area.height - 16) });
}
export function distanceToRect(point: Point, rect: Rect): number {
  return Math.hypot(Math.max(rect.x - point.x, 0, point.x - rect.x - rect.width), Math.max(rect.y - point.y, 0, point.y - rect.y - rect.height));
}
