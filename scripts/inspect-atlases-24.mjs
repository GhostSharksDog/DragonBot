import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

// Read original pixels only: no image is written, sliced, or re-encoded.
// Optional cuts: {files:{"file.png":{state:"idle",gridColumns:6,gridRows:4,
// regions:[{x,y,width,height},...]}}}. Without explicit regions, detect complete
// figures over the entire source rather than cutting at implied grid lines.
const args = process.argv.slice(2), options = { directory: 'assets/skins/silver-dragon', output: 'docs/imagegen/atlas-geometry-24.json', files: [], strict: false };
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--strict') options.strict = true;
  else if (['--directory', '--output', '--cuts', '--chrome'].includes(arg)) options[arg.slice(2)] = args[++i];
  else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
  else options.files.push(arg);
}
const directory = path.resolve(options.directory), cuts = options.cuts ? JSON.parse(await fs.readFile(options.cuts, 'utf8')) : {};
const filenames = options.files.length ? options.files : (await fs.readdir(directory)).filter(file => /-24-v\d+\.png$/i.test(file));
if (!filenames.length) throw new Error('No 24-frame atlases found.');
const defaultGrids = { 'awaiting-input': [6, 3], 'awaiting-approval': [4, 5], error: [4, 5], success: [4, 6], 'idle-back': [5, 5], extras: [6, 3], supplement: [2, 2] };
const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Read-only atlas inspection</title>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(), browser = await chromium.launch({ executablePath: options.chrome ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const report = { version: 3, generatedAt: new Date().toISOString(), files: {} };
try {
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
  for (const filename of filenames) {
    const bytes = await fs.readFile(path.join(directory, filename)), config = cuts.files?.[filename] ?? cuts[filename] ?? {};
    const state = config.state ?? filename.replace(/-24-v\d+\.png$/i, ''), grid = defaultGrids[state] ?? [6, 4];
    const result = await page.evaluate(async ({ url, config, grid }) => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height), width = canvas.width, height = canvas.height;
      const columns = config.gridColumns ?? grid[0], rows = config.gridRows ?? grid[1];
      if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns * rows > 120) throw new Error('Invalid gridColumns/gridRows.');
      const labels = new Int32Array(width * height), groups = [];
      for (let pixel = 0; pixel < labels.length; pixel++) {
        if (labels[pixel] || data[pixel * 4 + 3] < 96) continue;
        const id = groups.length + 1, queue = [pixel]; labels[pixel] = id;
        let head = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
        while (head < queue.length) {
          const next = queue[head++], x = next % width, y = Math.floor(next / width);
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const neighbor = ny * width + nx;
            if (labels[neighbor] || data[neighbor * 4 + 3] < 96) continue;
            labels[neighbor] = id; queue.push(neighbor);
          }
        }
        groups.push({ id, pixels: queue.length, bounds: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } });
      }
      groups.sort((a, b) => b.pixels - a.pixels);
      const minBodyPixels = config.minBodyPixels ?? Math.max(600, (groups[0]?.pixels ?? 0) * .12);
      let bodies = groups.filter(group => group.pixels >= minBodyPixels);
      const explicit = config.regions;
      if (explicit) {
        if (!Array.isArray(explicit) || !explicit.length) throw new Error('regions must contain source rectangles.');
        bodies = explicit.map((region, index) => {
          if (![region.x, region.y, region.width, region.height].every(Number.isInteger) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 || region.x + region.width > width || region.y + region.height > height) throw new Error(`Invalid explicit region ${index}`);
          const matches = groups.filter(group => { const b = group.bounds; return b.x + b.width / 2 >= region.x && b.x + b.width / 2 < region.x + region.width && b.y + b.height / 2 >= region.y && b.y + b.height / 2 < region.y + region.height; });
          return { id: matches[0]?.id ?? -index - 1, pixels: matches.reduce((sum, group) => sum + group.pixels, 0), bounds: region, explicit: true };
        });
      }
      const sortedY = [...bodies].sort((a, b) => (a.bounds.y + a.bounds.height / 2) - (b.bounds.y + b.bounds.height / 2));
      const bodyHeights = bodies.map(body => body.bounds.height).sort((a, b) => a - b), medianHeight = bodyHeights[Math.floor(bodyHeights.length / 2)] ?? 1, clusters = [];
      for (const body of sortedY) {
        const cy = body.bounds.y + body.bounds.height / 2, cluster = clusters.find(item => Math.abs(item.cy - cy) < medianHeight * .45);
        if (cluster) { cluster.bodies.push(body); cluster.cy = cluster.bodies.reduce((sum, b) => sum + b.bounds.y + b.bounds.height / 2, 0) / cluster.bodies.length; }
        else clusters.push({ cy, bodies: [body] });
      }
      clusters.sort((a, b) => a.cy - b.cy); bodies = clusters.flatMap(cluster => cluster.bodies.sort((a, b) => a.bounds.x - b.bounds.x));
      const errors = [], warnings = [], frames = [], signatures = [], bodyIds = new Set(bodies.map(body => body.id));
      if (bodies.length !== columns * rows) errors.push({ kind: 'figure-count-mismatch', expected: columns * rows, measured: bodies.length, detail: 'Merged/touching figures or incorrect grid require source review; no artificial grid splits were used.' });
      const owner = new Map(bodies.map((body, index) => [body.id, index]));
      const groupDistance = (a, b) => Math.hypot(Math.max(a.x - b.x - b.width, b.x - a.x - a.width, 0), Math.max(a.y - b.y - b.height, b.y - a.y - a.height, 0));
      for (const group of groups) {
        if (bodyIds.has(group.id) || group.pixels < 8) continue;
        const candidates = bodies.map((body, index) => ({ index, distance: groupDistance(group.bounds, body.bounds) })).sort((a, b) => a.distance - b.distance);
        if (candidates[0] && candidates[0].distance <= Math.min(16, medianHeight * .06)) owner.set(group.id, candidates[0].index);
      }
      const mergeBounds = boxes => ({ x: Math.min(...boxes.map(b => b.x)), y: Math.min(...boxes.map(b => b.y)), width: Math.max(...boxes.map(b => b.x + b.width)) - Math.min(...boxes.map(b => b.x)), height: Math.max(...boxes.map(b => b.y + b.height)) - Math.min(...boxes.map(b => b.y)) });
      function traceFigureOutline(region, figureIndex) {
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
      for (let index = 0; index < bodies.length; index++) {
        const body = bodies[index], attachments = groups.filter(group => owner.get(group.id) === index), content = explicit ? body.bounds : mergeBounds(attachments.map(group => group.bounds));
        if (!explicit && body.bounds.height > medianHeight * 1.5) errors.push({ kind: 'merged-figures', frame: index, detail: 'One connected component spans more than one figure height; redraw or explicitly separate after visual review.' });
        const edgeTouches = ['left', 'top', 'right', 'bottom'].filter(side => side === 'left' ? content.x === 0 : side === 'top' ? content.y === 0 : side === 'right' ? content.x + content.width === width : content.y + content.height === height);
        if (edgeTouches.length) errors.push({ kind: 'content-on-image-edge', frame: index, edges: edgeTouches });
        const x0 = Math.max(0, content.x - 3), y0 = Math.max(0, content.y - 3), x1 = Math.min(width, content.x + content.width + 3), y1 = Math.min(height, content.y + content.height + 3);
        const crop = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        const traced = traceFigureOutline(crop, index); crop.outline = traced.outline;
        if (traced.validation.foreignPixelsKept > 0 || traced.validation.ownCoverage < .999 || traced.outline.length < 3) errors.push({ kind: 'outline-validation-failed', frame: index, ...traced.validation });
        if (traced.outline.length > 512) warnings.push({ kind: 'complex-outline', frame: index, points: traced.outline.length });
        const cropMarginAlpha = { left: 0, top: 0, right: 0, bottom: 0 };
        for (let y = y0; y < y1; y++) { if (data[(y * width + x0) * 4 + 3] >= 16) cropMarginAlpha.left++; if (data[(y * width + x1 - 1) * 4 + 3] >= 16) cropMarginAlpha.right++; }
        for (let x = x0; x < x1; x++) { if (data[(y0 * width + x) * 4 + 3] >= 16) cropMarginAlpha.top++; if (data[((y1 - 1) * width + x) * 4 + 3] >= 16) cropMarginAlpha.bottom++; }
        if (Object.values(cropMarginAlpha).some(count => count > 0)) warnings.push({ kind: 'no-transparent-crop-margin', frame: index, pixels: cropMarginAlpha });
        let foreignPixels = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const id = labels[y * width + x]; if (id && owner.has(id) && owner.get(id) !== index) foreignPixels++; }
        if (foreignPixels > 0) {
          if (traced.validation.foreignPixelsKept === 0) warnings.push({ kind: 'requires-outline', frame: index, pixels: foreignPixels, validatedExcluded: true });
          else errors.push({ kind: 'neighbor-in-crop', frame: index, pixels: foreignPixels, keptByOutline: traced.validation.foreignPixelsKept });
        }
        if (explicit) {
          const cut = attachments.filter(group => group.bounds.x < content.x || group.bounds.y < content.y || group.bounds.x + group.bounds.width > content.x + content.width || group.bounds.y + group.bounds.height > content.y + content.height);
          if (cut.length) errors.push({ kind: 'explicit-region-truncates-figure', frame: index, groups: cut.map(group => group.id) });
        }
        const packed = new Uint8Array(8 + content.width * content.height * 4), header = new DataView(packed.buffer); header.setUint32(0, content.width); header.setUint32(4, content.height);
        for (let y = 0; y < content.height; y++) for (let x = 0; x < content.width; x++) {
          const source = ((content.y + y) * width + content.x + x) * 4, target = 8 + (y * content.width + x) * 4, inOutline = traced.mask[(content.y + y - crop.y) * crop.width + content.x + x - crop.x], a = inOutline ? data[source + 3] : 0;
          packed[target] = a ? data[source] : 0; packed[target + 1] = a ? data[source + 1] : 0; packed[target + 2] = a ? data[source + 2] : 0; packed[target + 3] = a;
        }
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', packed)), value => value.toString(16).padStart(2, '0')).join(''), samples = new Uint8Array(24 * 32 * 4);
        for (let y = 0; y < 32; y++) for (let x = 0; x < 24; x++) {
          const sx = content.x + Math.min(content.width - 1, Math.floor((x + .5) / 24 * content.width)), sy = content.y + Math.min(content.height - 1, Math.floor((y + .5) / 32 * content.height));
          const source = (sy * width + sx) * 4, target = (y * 24 + x) * 4, inOutline = traced.mask[(sy - crop.y) * crop.width + sx - crop.x], a = inOutline ? data[source + 3] / 255 : 0;
          samples[target] = Math.round(data[source] * a); samples[target + 1] = Math.round(data[source + 1] * a); samples[target + 2] = Math.round(data[source + 2] * a); samples[target + 3] = Math.round(a * 255);
        }
        signatures.push(samples); frames.push({ index, row: clusters.findIndex(cluster => cluster.bodies.includes(body)), contentBounds: content, region: crop, edgeTouches, cropMarginAlpha, foreignPixels, outlineValidation: traced.validation, pixels: body.pixels, exactHash: digest, comparisonSample: btoa(String.fromCharCode(...samples)) });
      }
      const exactMap = new Map(); for (const frame of frames) exactMap.set(frame.exactHash, [...(exactMap.get(frame.exactHash) ?? []), frame.index]);
      const exactGroups = [...exactMap.values()].filter(indices => indices.length > 1), perceptualPairs = [];
      for (let a = 0; a < frames.length; a++) for (let b = a + 1; b < frames.length; b++) {
        if (frames[a].exactHash === frames[b].exactHash) continue;
        let sum = 0, alphaSum = 0;
        for (let i = 0; i < signatures[a].length; i++) { const delta = Math.abs(signatures[a][i] - signatures[b][i]) / 255; sum += delta; if (i % 4 === 3) alphaSum += delta; }
        const difference = sum / signatures[a].length, silhouetteDifference = alphaSum / (24 * 32);
        if (difference <= .02 && silhouetteDifference <= .035) perceptualPairs.push({ frames: [a, b], difference, silhouetteDifference });
      }
      if (exactGroups.length) warnings.push({ kind: 'exact-duplicate-source-frames', groups: exactGroups });
      if (perceptualPairs.length) warnings.push({ kind: 'near-duplicate-review-required', pairs: perceptualPairs.length });
      const ignoredGroups = groups.filter(group => !owner.has(group.id));
      const noiseOnImageEdge = ignoredGroups.filter(group => group.bounds.x === 0 || group.bounds.y === 0 || group.bounds.x + group.bounds.width === width || group.bounds.y + group.bounds.height === height).reduce((sum, group) => sum + group.pixels, 0);
      if (noiseOnImageEdge) warnings.push({ kind: 'detached-noise-on-image-edge', pixels: noiseOnImageEdge });
      const sourcePerimeterAlphaPixels = { left: 0, top: 0, right: 0, bottom: 0 };
      for (let y = 0; y < height; y++) { if (data[y * width * 4 + 3] >= 16) sourcePerimeterAlphaPixels.left++; if (data[(y * width + width - 1) * 4 + 3] >= 16) sourcePerimeterAlphaPixels.right++; }
      for (let x = 0; x < width; x++) { if (data[x * 4 + 3] >= 16) sourcePerimeterAlphaPixels.top++; if (data[((height - 1) * width + x) * 4 + 3] >= 16) sourcePerimeterAlphaPixels.bottom++; }
      if (Object.values(sourcePerimeterAlphaPixels).some(count => count > 0)) warnings.push({ kind: 'alpha-on-image-edge-review', pixels: sourcePerimeterAlphaPixels });
      let transparent = 0; for (let i = 3; i < data.length; i += 4) if (data[i] === 0) transparent++;
      return { sourceWidth: width, sourceHeight: height, columns, rows, measuredRows: clusters.map(cluster => cluster.bodies.length), measuredFigures: bodies.length, transparentFraction: transparent / (width * height), sourcePerimeterAlphaPixels, regions: frames.map(frame => frame.region), frames, normalization: 'Each complete figure is aspect-preserved to the logical cell with a common bottom anchor; source-pixel heights may differ.', duplicates: { exactGroups, perceptualPairs, exactUniqueCount: exactMap.size }, ignoredNoise: { components: ignoredGroups.length, pixels: ignoredGroups.reduce((sum, group) => sum + group.pixels, 0) }, warnings, errors };
    }, { url: 'data:image/png;base64,' + bytes.toString('base64'), config, grid });
    report.files[filename] = { state, ...result };
    console.log(`${filename}: ${result.sourceWidth}x${result.sourceHeight}, figures=${result.measuredFigures}, rows=${result.measuredRows.join('/')}, unique=${result.duplicates.exactUniqueCount}, border=${result.errors.filter(error => error.kind === 'content-on-image-edge').length}, neighbor=${result.errors.filter(error => error.kind === 'neighbor-in-crop').length}, near=${result.duplicates.perceptualPairs.length}`);
  }
  await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true }); await fs.writeFile(options.output, JSON.stringify(report, null, 2));
  if (options.strict && Object.values(report.files).some(file => file.errors.length)) process.exitCode = 1;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
