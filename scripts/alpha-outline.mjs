// Pure mask geometry only; source raster pixels are never written.
export function traceAlphaOutline({ region, figureIndex, sourceWidth: width, labels, owner }) {
  const w = region.width, h = region.height, mask = new Uint8Array(w * h);
  // Dilate only this figure by two pixels. Neighboring source pixels are
  // excluded explicitly so a concave tail/wing cut never admits a neighbor.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (owner.get(labels[(region.y + y) * width + region.x + x]) !== figureIndex) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (dx * dx + dy * dy > 4 || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const other = owner.get(labels[(region.y + ny) * width + region.x + nx]);
      if (other === undefined || other === figureIndex) mask[ny * w + nx] = 1;
    }
  }
  const stride = w + 1, edges = new Map();
  const add = (x0, y0, x1, y1) => { const key = y0 * stride + x0; edges.set(key, [...(edges.get(key) ?? []), y1 * stride + x1]); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
    if (y === 0 || !mask[(y - 1) * w + x]) add(x, y, x + 1, y);
    if (x === w - 1 || !mask[y * w + x + 1]) add(x + 1, y, x + 1, y + 1);
    if (y === h - 1 || !mask[(y + 1) * w + x]) add(x + 1, y + 1, x, y + 1);
    if (x === 0 || !mask[y * w + x - 1]) add(x, y + 1, x, y);
  }
  const point = key => [key % stride, Math.floor(key / stride)];
  const direction = (a, b) => { const [x0, y0] = point(a), [x1, y1] = point(b); return x1 > x0 ? 0 : y1 > y0 ? 1 : x1 < x0 ? 2 : 3; };
  const loops = [];
  while (edges.size) {
    const first = edges.keys().next().value, loop = [point(first)]; let current = first, previousDirection = null, guard = 0;
    do {
      const candidates = edges.get(current);
      if (!candidates?.length || guard++ > w * h * 8) break;
      let picked = 0;
      if (candidates.length > 1 && previousDirection !== null) {
        const rank = candidate => { const turn = (direction(current, candidate) - previousDirection + 4) % 4; return turn === 1 ? 0 : turn === 0 ? 1 : turn === 3 ? 2 : 3; };
        picked = candidates.reduce((best, candidate, i) => rank(candidate) < rank(candidates[best]) ? i : best, 0);
      }
      const next = candidates.splice(picked, 1)[0]; if (!candidates.length) edges.delete(current);
      previousDirection = direction(current, next); current = next;
      if (current !== first) loop.push(point(current));
    } while (current !== first);
    if (current === first && loop.length >= 3) {
      const area = loop.reduce((sum, p, i) => { const q = loop[(i + 1) % loop.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
      if (Math.abs(area) >= 8) loops.push({ points: loop, area });
    }
  }
  loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  const distanceSquared = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
    return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
  };
  function simplifyChain(points, tolerance) {
    if (points.length <= 2) return points;
    let farthest = tolerance * tolerance, index = -1;
    for (let i = 1; i < points.length - 1; i++) { const distance = distanceSquared(points[i], points[0], points.at(-1)); if (distance > farthest) { farthest = distance; index = i; } }
    if (index < 0) return [points[0], points.at(-1)];
    return [...simplifyChain(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplifyChain(points.slice(index), tolerance)];
  }
  function simplifyLoop(points, tolerance) {
    let split = 1, distance = -1;
    for (let i = 1; i < points.length; i++) { const next = (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2; if (next > distance) { distance = next; split = i; } }
    return [...simplifyChain(points.slice(0, split + 1), tolerance).slice(0, -1), ...simplifyChain([...points.slice(split), points[0]], tolerance).slice(0, -1)];
  }
  function combine(tolerance) {
    const simplified = loops.map(loop => simplifyLoop(loop.points, tolerance)).filter(loop => loop.length >= 3);
    if (!simplified.length) return [];
    // Zero-width doubled bridges join separate contours without a convex
    // hull. evenodd fill preserves all concave gaps, holes and accessories.
    const outline = [...simplified[0], simplified[0][0]], home = simplified[0][0];
    for (const loop of simplified.slice(1)) outline.push(loop[0], ...loop.slice(1), loop[0], home);
    return outline;
  }
  function validate(outline) {
    const raster = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const scanY = y + .5, crossings = [];
      for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
        const a = outline[j], b = outline[i];
        if ((a[1] > scanY) !== (b[1] > scanY)) crossings.push(a[0] + (scanY - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const left = Math.max(0, Math.ceil(crossings[i] - .5)), right = Math.min(w, Math.ceil(crossings[i + 1] - .5));
        raster.fill(1, y * w + left, y * w + right);
      }
    }
    let ownPixels = 0, retainedOwn = 0, foreignPixels = 0, foreignPixelsKept = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const figure = owner.get(labels[(region.y + y) * width + region.x + x]);
      if (figure === figureIndex) { ownPixels++; if (raster[y * w + x]) retainedOwn++; }
      else if (figure !== undefined) { foreignPixels++; if (raster[y * w + x]) foreignPixelsKept++; }
    }
    return { ownPixels, retainedOwn, foreignPixels, foreignPixelsKept, ownCoverage: ownPixels ? retainedOwn / ownPixels : 0, raster };
  }
  let best = null;
  for (const tolerance of [1.6, 1.2, .9, .65, .3, 0]) {
    const outline = combine(tolerance), { raster, ...validation } = validate(outline);
    if (validation.foreignPixelsKept === 0 && validation.ownCoverage >= .999) {
      best = { outline, mask: raster, validation: { ...validation, points: outline.length, tolerance, contours: loops.length } };
      break;
    }
  }
  if (best) return best;
  const outline = combine(0), { raster, ...validation } = validate(outline);
  return { outline, mask: raster, validation: { ...validation, points: outline.length, tolerance: 0, contours: loops.length } };
}
