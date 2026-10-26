export interface BubblePoint { x: number; y: number }
export interface RoundedRect { x: number; y: number; width: number; height: number; radius: number }
export interface QuickBubbleShape {
  offset?: BubblePoint;
  body: RoundedRect;
  tail: [BubblePoint, BubblePoint, BubblePoint];
  content: { x: number; y: number; width: number; height: number };
  path: string;
}

export function pointInRoundedRect(rect: RoundedRect, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < rect.x || y < rect.y || x > rect.x + rect.width || y > rect.y + rect.height) return false;
  const radius = Math.max(0, Math.min(rect.radius, rect.width / 2, rect.height / 2));
  const cx = Math.max(rect.x + radius, Math.min(x, rect.x + rect.width - radius));
  const cy = Math.max(rect.y + radius, Math.min(y, rect.y + rect.height - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** One outline for drawing, native mouse passthrough and outside-click dismissal. */
export function createQuickBubbleShape(width: number, height: number, head: BubblePoint): QuickBubbleShape {
  const x = 14, y = 6, right = width - 14, bottom = height - 8;
  const radius = Math.min(18, (right - x) / 4, (bottom - y) / 4);
  const leftTail = head.x < width / 2;
  const center = Math.max(y + radius + 8, Math.min(head.y, bottom - radius - 8));
  const edge = leftTail ? x : right;
  const tip = { x: leftTail ? 3 : width - 3, y: center + 5 };
  const tail: QuickBubbleShape['tail'] = [{ x: edge, y: center - 7 }, tip, { x: edge, y: center + 7 }];
  const path = `M ${x + radius} ${y} H ${right - radius} A ${radius} ${radius} 0 0 1 ${right} ${y + radius} `
    + (leftTail ? '' : `V ${center - 7} L ${tip.x} ${tip.y} L ${right} ${center + 7} `)
    + `V ${bottom - radius} A ${radius} ${radius} 0 0 1 ${right - radius} ${bottom} H ${x + radius} A ${radius} ${radius} 0 0 1 ${x} ${bottom - radius} `
    + (leftTail ? `V ${center + 7} L ${tip.x} ${tip.y} L ${x} ${center - 7} ` : '')
    + `V ${y + radius} A ${radius} ${radius} 0 0 1 ${x + radius} ${y} Z`;
  return { body: { x, y, width: right - x, height: bottom - y, radius }, tail, content: { x: x + 16, y: y + 12, width: right - x - 32, height: bottom - y - 24 }, path };
}

export function quickBubbleHit(shape: QuickBubbleShape, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (pointInRoundedRect(shape.body, x, y)) return true;
  const [a, b, c] = shape.tail;
  const cross = (u: BubblePoint, v: BubblePoint) => (x - v.x) * (u.y - v.y) - (u.x - v.x) * (y - v.y);
  const d1 = cross(a, b), d2 = cross(b, c), d3 = cross(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
