export interface BubblePoint { x: number; y: number }
export interface QuickBubbleShape {
  ellipse: { cx: number; cy: number; rx: number; ry: number };
  tail: [BubblePoint, BubblePoint, BubblePoint];
  content: { x: number; y: number; width: number; height: number };
  path: string;
}

/** One outline shared by the SVG, native mouse passthrough and outside-click monitor. */
export function createQuickBubbleShape(width: number, height: number, head: BubblePoint): QuickBubbleShape {
  const cx = width / 2, cy = height / 2;
  const rx = Math.max(1, cx - Math.min(20, width * .12)), ry = Math.max(1, cy - Math.min(9, height * .08));
  const tip = { x: head.x < cx ? 3 : width - 3, y: Math.min(height - 5, Math.max(5, head.y)) };
  const angle = Math.atan2((tip.y - cy) / ry, (tip.x - cx) / rx);
  const point = (a: number) => ({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  const first = point(angle - .12), last = point(angle + .12);
  const fmt = (n: number) => Number(n.toFixed(4));
  const path = `M ${fmt(last.x)} ${fmt(last.y)} A ${fmt(rx)} ${fmt(ry)} 0 1 1 ${fmt(first.x)} ${fmt(first.y)} L ${fmt(tip.x)} ${fmt(tip.y)} Z`;
  return { ellipse: { cx, cy, rx, ry }, tail: [first, tip, last], content: { x: cx - rx * .7, y: cy - ry * .7, width: rx * 1.4, height: ry * 1.4 }, path };
}

export function quickBubbleHit(shape: QuickBubbleShape, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const { cx, cy, rx, ry } = shape.ellipse;
  if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) return true;
  const [a, b, c] = shape.tail;
  const cross = (u: BubblePoint, v: BubblePoint) => (x - v.x) * (u.y - v.y) - (u.x - v.x) * (y - v.y);
  const d1 = cross(a, b), d2 = cross(b, c), d3 = cross(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
