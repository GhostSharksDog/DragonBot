import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Read-only source analysis. New review pictures may be rendered, but the input
// PNG is never cleaned, moved, rewritten, or used as an output destination.
const options = { columns: 6, rows: 4, alpha: 32, nearThreshold: .025, ffmpeg: 'E:/Apps/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe', chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe' };
const files = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const option = args[index];
  if (['--columns', '--rows', '--alpha', '--near-threshold', '--ffmpeg', '--chrome'].includes(option)) {
    const value = args[++index]; if (!value) throw new Error(`Missing value for ${option}`);
    const name = option === '--near-threshold' ? 'nearThreshold' : option.slice(2);
    options[name] = ['columns', 'rows', 'alpha', 'nearThreshold'].includes(name) ? Number(value) : value;
  } else if (option.startsWith('--')) throw new Error(`Unknown option ${option}`);
  else files.push(path.resolve(option));
}
if (!files.length) throw new Error('Usage: node scripts/inspect-redraw-atlases.mjs <original.png> [...] [--columns 6 --rows 4]. All review outputs stay under .local/redraw-qa/.');
if (![options.columns, options.rows].every(value => Number.isInteger(value) && value > 0 && value <= 24) || !Number.isInteger(options.alpha) || options.alpha < 1 || options.alpha > 255 || !Number.isFinite(options.nearThreshold) || options.nearThreshold < 0 || options.nearThreshold > 1) throw new Error('Invalid grid, alpha threshold, or near-duplicate threshold.');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(project, '.local', 'redraw-qa'); await fs.mkdir(outputRoot, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixed = value => Math.round(value * 1e6) / 1e6;
function runDecoder(file, expectedBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.ffmpeg, ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, error = '';
    child.stdout.on('data', bytes => { size += bytes.length; if (size > expectedBytes) child.kill(); else chunks.push(bytes); });
    child.stderr.on('data', bytes => { error += bytes.toString(); });
    child.once('error', reject);
    child.once('close', code => code === 0 && size === expectedBytes ? resolve(Buffer.concat(chunks)) : reject(new Error(`PNG decoding failed (${code}, ${size}/${expectedBytes} bytes): ${error.slice(0, 1000)}`)));
  });
}
function bbox(x0, y0, x1, y1) { return x1 >= x0 && y1 >= y0 ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null; }
function touching(box, width, height) { return box ? [['left', box.x === 0], ['top', box.y === 0], ['right', box.x + box.width === width], ['bottom', box.y + box.height === height]].filter(([, yes]) => yes).map(([edge]) => edge) : []; }
function sampleFeature(rgba, imageWidth, region, width, height) {
  const feature = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = region.x + Math.min(region.width - 1, Math.floor((x + .5) * region.width / width));
    const sy = region.y + Math.min(region.height - 1, Math.floor((y + .5) * region.height / height));
    const source = (sy * imageWidth + sx) * 4, dest = (y * width + x) * 4, alpha = rgba[source + 3] / 255;
    for (let channel = 0; channel < 3; channel++) feature[dest + channel] = Math.round(rgba[source + channel] * alpha);
    feature[dest + 3] = rgba[source + 3];
  }
  return feature;
}
function difference(a, b) {
  let rgb = 0, alpha = 0, changed = 0;
  for (let offset = 0; offset < a.length; offset += 4) {
    let pixelDifference = 0;
    for (let channel = 0; channel < 3; channel++) { const delta = Math.abs(a[offset + channel] - b[offset + channel]); rgb += delta; pixelDifference = Math.max(pixelDifference, delta); }
    const alphaDelta = Math.abs(a[offset + 3] - b[offset + 3]); alpha += alphaDelta;
    if (Math.max(pixelDifference, alphaDelta) > 12) changed++;
  }
  const pixels = a.length / 4;
  return { premultipliedRgbMAD: fixed(rgb / pixels / 3 / 255), alphaMAD: fixed(alpha / pixels / 255), changedPixelFraction: fixed(changed / pixels) };
}
function inspectFrame(rgba, imageWidth, region, index) {
  const { width, height } = region, labels = new Int32Array(width * height), components = [];
  let any = [width, height, -1, -1], solid = [width, height, -1, -1], nonzero = 0, occupied = 0, alphaWeight = 0, sumX = 0, sumY = 0;
  const skinSamples = { face: { count: 0, x: 0, y: 0 }, chest: { count: 0, x: 0, y: 0 }, legs: { count: 0, x: 0, y: 0 } };
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(((region.y + y) * imageWidth + region.x) * 4, ((region.y + y) * imageWidth + region.x + width) * 4); row.copy(raw, y * width * 4);
    for (let x = 0; x < width; x++) {
      const alpha = row[x * 4 + 3];
      if (alpha) { nonzero++; any = [Math.min(any[0], x), Math.min(any[1], y), Math.max(any[2], x), Math.max(any[3], y)]; }
      if (alpha >= options.alpha) { occupied++; solid = [Math.min(solid[0], x), Math.min(solid[1], y), Math.max(solid[2], x), Math.max(solid[3], y)]; alphaWeight += alpha; sumX += x * alpha; sumY += y * alpha; }
      const r = row[x * 4], g = row[x * 4 + 1], b = row[x * 4 + 2];
      if (alpha >= 200 && r >= 180 && g >= 120 && b >= 110 && r - g >= 5 && r - b >= 5 && g - b >= -15 && g - b <= 30) {
        for (const [name, from, to] of [['face', .24, .52], ['chest', .52, .72], ['legs', .72, .98]]) if (y / height >= from && y / height <= to) { skinSamples[name].count++; skinSamples[name].x += x; skinSamples[name].y += y; }
      }
    }
  }
  const alphaAt = pixel => raw[pixel * 4 + 3];
  for (let pixel = 0; pixel < labels.length; pixel++) {
    if (labels[pixel] || alphaAt(pixel) < options.alpha) continue;
    const id = components.length + 1, queue = [pixel]; labels[pixel] = id;
    let head = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
    while (head < queue.length) {
      const current = queue[head++], x = current % width, y = Math.floor(current / width);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (!labels[neighbor] && alphaAt(neighbor) >= options.alpha) { labels[neighbor] = id; queue.push(neighbor); }
      }
    }
    components.push({ id, pixels: queue.length, bbox: bbox(x0, y0, x1, y1) });
  }
  components.sort((a, b) => b.pixels - a.pixels);
  const main = components[0], body = main?.bbox ?? null;
  const boundaryContinuations = { left: 0, right: 0, top: 0, bottom: 0 };
  const imageHeight = rgba.length / 4 / imageWidth;
  if (main) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (labels[y * width + x] !== main.id) continue;
    const neighbors = [];
    if (x === 0 && region.x > 0) neighbors.push(['left', region.x - 1, region.y + y]);
    if (x === width - 1 && region.x + width < imageWidth) neighbors.push(['right', region.x + width, region.y + y]);
    if (y === 0 && region.y > 0) neighbors.push(['top', region.x + x, region.y - 1]);
    if (y === height - 1 && region.y + height < imageHeight) neighbors.push(['bottom', region.x + x, region.y + height]);
    for (const [edge, nx, ny] of neighbors) if (rgba[(ny * imageWidth + nx) * 4 + 3] >= options.alpha) boundaryContinuations[edge]++;
  }
  let torsoWeight = 0, torsoX = 0, torsoY = 0, foot = null;
  if (body) for (let y = body.y; y < body.y + body.height; y++) for (let x = body.x; x < body.x + body.width; x++) {
    const pixel = y * width + x;
    if (labels[pixel] !== main.id) continue;
    const relativeY = (y - body.y) / body.height, alpha = alphaAt(pixel);
    if (relativeY >= .4 && relativeY <= .7) { torsoWeight += alpha; torsoX += x * alpha; torsoY += y * alpha; }
    if (relativeY >= .75 && x >= body.x + body.width * .25 && x <= body.x + body.width * .75) foot = Math.max(foot ?? y, y);
  }
  const anyBox = bbox(...any), solidBox = bbox(...solid), wholeFeature = sampleFeature(rgba, imageWidth, region, 96, 144);
  const figureRegion = body ? { x: region.x + body.x, y: region.y + body.y, width: body.width, height: body.height } : region;
  const figureFeature = sampleFeature(rgba, imageWidth, figureRegion, 64, 96);
  const warnings = [];
  if (!body) warnings.push('empty-or-below-alpha-threshold');
  if (touching(anyBox, width, height).length) warnings.push('some-nonzero-alpha-touches-cell-edge');
  if (touching(body, width, height).length) warnings.push('main-body-touches-cell-edge-review-for-clipping');
  if (nonzero === width * height) warnings.push('no-fully-transparent-pixel-in-cell');
  if (main && components[1]?.pixels > main.pixels * .15) warnings.push('large-disconnected-component-review-complete-figure');
  return {
    evidence: { index, row: Math.floor(index / options.columns), column: index % options.columns, sourceRegion: region,
      nonzeroAlphaBBox: anyBox, thresholdAlphaBBox: solidBox, mainBodyBBox: body,
      cellEdgeAlpha: touching(anyBox, width, height), cellEdgeMainBody: touching(body, width, height),
      mainBodyContinuesAcrossGrid: boundaryContinuations,
      fullyTransparentFraction: fixed(1 - nonzero / (width * height)), thresholdOccupiedFraction: fixed(occupied / (width * height)),
      alphaCentroid: alphaWeight ? { x: fixed(sumX / alphaWeight), y: fixed(sumY / alphaWeight) } : null,
      skinCentroidEstimates: Object.fromEntries(Object.entries(skinSamples).map(([name, sample]) => [name, sample.count ? { x: fixed(sample.x / sample.count), y: fixed(sample.y / sample.count), samples: sample.count } : null])),
      torsoCenterEstimate: torsoWeight ? { x: fixed(torsoX / torsoWeight), y: fixed(torsoY / torsoWeight), method: 'alpha-weighted main-component band at 40–70% of figure height' } : null,
      silhouetteBottom: body ? body.y + body.height - 1 : null, footBaselineEstimate: foot,
      footEstimateMethod: 'lowest main-component alpha inside central 50% of width and bottom 25% of height; inspect visually for tail/dress ambiguity',
      exactRawRgbaHash: sha(Buffer.concat([Buffer.from(`${width}x${height}:`), raw])), normalizedFrameHash: sha(wholeFeature), normalizedFigureHash: sha(figureFeature),
      componentCount: components.length, largestComponents: components.slice(0, 8).map(({ pixels, bbox }) => ({ pixels, bbox })), warnings,
    }, wholeFeature, figureFeature,
  };
}
function range(values) { const valid = values.filter(Number.isFinite); return valid.length ? { min: fixed(Math.min(...valid)), max: fixed(Math.max(...valid)), span: fixed(Math.max(...valid) - Math.min(...valid)) } : null; }
function median(values) { const valid = values.filter(Number.isFinite).sort((a, b) => a - b); return valid.length ? (valid[Math.floor((valid.length - 1) / 2)] + valid[Math.floor(valid.length / 2)]) / 2 : null; }
function compareGreenForeground(original, alpha, width, height) {
  const green = pixel => original[pixel * 4 + 1] > 110 && original[pixel * 4 + 1] > original[pixel * 4] * 1.4 && original[pixel * 4 + 1] > original[pixel * 4 + 2] * 1.4;
  const totals = { interiorForegroundPixels: 0, erasedInteriorPixels: 0, translucentInteriorPixels: 0, interiorSkinTonePixels: 0, erasedSkinTonePixels: 0, translucentSkinTonePixels: 0, interiorNeutralLightPixels: 0, erasedNeutralLightPixels: 0, translucentNeutralLightPixels: 0, distantGreenBackgroundPixels: 0, remainingNonzeroAlphaOnDistantGreen: 0, remainingAlpha4PlusOnDistantGreen: 0, remainingAlphaOnDistantGreen: 0, remainingAlpha128OnDistantGreen: 0, remainingOpaqueAlphaOnDistantGreen: 0 };
  const cells = Array.from({ length: options.columns * options.rows }, (_, frame) => ({ frame, ...totals }));
  const faces = Array.from({ length: cells.length }, () => ({ weight: 0, x: 0, y: 0 }));
  for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
    const pixel = y * width + x, isGreen = green(pixel); let sameNeighborhood = true;
    for (let dy = -2; dy <= 2 && sameNeighborhood; dy++) for (let dx = -2; dx <= 2; dx++) if (green((y + dy) * width + x + dx) !== isGreen) { sameNeighborhood = false; break; }
    if (!sameNeighborhood) continue;
    const row = Math.min(options.rows - 1, Math.ceil((y + 1) * options.rows / height) - 1), column = Math.min(options.columns - 1, Math.ceil((x + 1) * options.columns / width) - 1), cellIndex = row * options.columns + column;
    const cell = cells[cellIndex];
    const count = key => { totals[key]++; cell[key]++; };
    const opacity = alpha[pixel * 4 + 3];
    if (isGreen) { count('distantGreenBackgroundPixels'); if (opacity > 0) count('remainingNonzeroAlphaOnDistantGreen'); if (opacity >= 4) count('remainingAlpha4PlusOnDistantGreen'); if (opacity >= options.alpha) count('remainingAlphaOnDistantGreen'); if (opacity >= 128) count('remainingAlpha128OnDistantGreen'); if (opacity >= 240) count('remainingOpaqueAlphaOnDistantGreen'); continue; }
    count('interiorForegroundPixels'); if (opacity < 16) count('erasedInteriorPixels'); else if (opacity < 240) count('translucentInteriorPixels');
    const r = original[pixel * 4], g = original[pixel * 4 + 1], b = original[pixel * 4 + 2];
    if (r >= 180 && g >= 120 && b >= 110 && r - g >= 5 && r - b >= 5 && g - b >= -15 && g - b <= 30) {
      count('interiorSkinTonePixels'); if (opacity < 16) count('erasedSkinTonePixels'); else if (opacity < 240) count('translucentSkinTonePixels');
      const localY = y - Math.floor(row * height / options.rows), cellHeight = Math.floor((row + 1) * height / options.rows) - Math.floor(row * height / options.rows);
      if (localY >= cellHeight * .24 && localY <= cellHeight * .52) { faces[cellIndex].weight++; faces[cellIndex].x += x - Math.floor(column * width / options.columns); faces[cellIndex].y += localY; }
    }
    if (Math.min(r, g, b) >= 130 && Math.max(r, g, b) - Math.min(r, g, b) < 40) {
      count('interiorNeutralLightPixels'); if (opacity < 16) count('erasedNeutralLightPixels'); else if (opacity < 240) count('translucentNeutralLightPixels');
    }
  }
  cells.forEach((cell, index) => { const face = faces[index]; cell.faceSkinCentroidEstimate = face.weight ? { x: fixed(face.x / face.weight), y: fixed(face.y / face.weight), samples: face.weight, method: 'pink source pixels in 24–52% vertical cell band; approximate independent check of registration, includes ears' } : null; });
  return { method: 'Compare same pixel coordinates; classify original green by G>110 and G>1.4R,1.4B; require a 5×5 same-class neighborhood. Color categories are approximate evidence, not semantic segmentation.', displayCaveat: 'Nonzero alpha is not equivalent to visible noise. Pixels with alpha 1–3 contribute at most 1.2% opacity; judge properly composited light/dark 200px/400px previews. Counts at alpha≥32 and ≥128 are retained separately for review.', totals, frames: cells };
}
const reports = [];
const sources = new Map();
for (const file of files) {
  const bytes = await fs.readFile(file);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`Not a PNG: ${file}`);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < options.columns || height < options.rows || width > 8192 || height > 8192) throw new Error(`Unsupported PNG dimensions ${width}×${height}`);
  const originalHash = sha(bytes), rgba = await runDecoder(file, width * height * 4), frames = [];
  const alphaHistogram = { zero: 0, oneToThree: 0, fourTo31: 0, thirtyTwoTo127: 0, one28To239: 0, two40To254: 0, opaque: 0 };
  for (let offset = 3; offset < rgba.length; offset += 4) { const alpha = rgba[offset]; alphaHistogram[alpha === 0 ? 'zero' : alpha <= 3 ? 'oneToThree' : alpha <= 31 ? 'fourTo31' : alpha <= 127 ? 'thirtyTwoTo127' : alpha <= 239 ? 'one28To239' : alpha <= 254 ? 'two40To254' : 'opaque']++; }
  for (let row = 0; row < options.rows; row++) for (let column = 0; column < options.columns; column++) {
    const x = Math.floor(column * width / options.columns), y = Math.floor(row * height / options.rows);
    frames.push(inspectFrame(rgba, width, { x, y, width: Math.floor((column + 1) * width / options.columns) - x, height: Math.floor((row + 1) * height / options.rows) - y }, frames.length));
  }
  const duplicatePairs = [], neighboringDifferences = [];
  for (let a = 0; a < frames.length; a++) for (let b = a + 1; b < frames.length; b++) {
    const frameDifference = difference(frames[a].wholeFeature, frames[b].wholeFeature), figureDifference = difference(frames[a].figureFeature, frames[b].figureFeature);
    const exact = frames[a].evidence.exactRawRgbaHash === frames[b].evidence.exactRawRgbaHash;
    const normalizedExact = frames[a].evidence.normalizedFigureHash === frames[b].evidence.normalizedFigureHash;
    if (exact || normalizedExact || figureDifference.premultipliedRgbMAD <= options.nearThreshold && figureDifference.alphaMAD <= options.nearThreshold) duplicatePairs.push({ frames: [a, b], exactRawFrame: exact, exactNormalizedFigure: normalizedExact, frameDifference, figureDifference, status: 'manual-review-required; metric similarity is not proof of repeated pose' });
  }
  for (let index = 0; index < frames.length; index++) neighboringDifferences.push({ from: index, to: (index + 1) % frames.length, loopSeam: index === frames.length - 1, ...difference(frames[index].wholeFeature, frames[(index + 1) % frames.length].wholeFeature) });
  const medianFoot = median(frames.map(frame => frame.evidence.footBaselineEstimate));
  const medianTorsoX = median(frames.map(frame => frame.evidence.torsoCenterEstimate?.x)), medianTorsoY = median(frames.map(frame => frame.evidence.torsoCenterEstimate?.y));
  for (const { evidence } of frames) evidence.offsetFromMedian = {
    footY: evidence.footBaselineEstimate === null || medianFoot === null ? null : fixed(evidence.footBaselineEstimate - medianFoot),
    torsoX: evidence.torsoCenterEstimate === null || medianTorsoX === null ? null : fixed(evidence.torsoCenterEstimate.x - medianTorsoX),
    torsoY: evidence.torsoCenterEstimate === null || medianTorsoY === null ? null : fixed(evidence.torsoCenterEstimate.y - medianTorsoY),
  };
  const report = { version: 1, source: file, sha256: originalHash, bytes: bytes.length, width, height, columns: options.columns, rows: options.rows, alphaThreshold: options.alpha, decodedPixelFormat: '8-bit straight RGBA from ffmpeg',
    note: 'Geometry and similarity evidence only. No automatic aesthetic approval or count of genuinely different poses. No original pixels changed.',
    alphaHistogram, frames: frames.map(frame => frame.evidence), neighboringDifferences, duplicatePairs,
    alignment: { medianFootBaseline: medianFoot, medianTorsoCenter: { x: medianTorsoX, y: medianTorsoY }, footBaselinePixels: range(frames.map(frame => frame.evidence.footBaselineEstimate)), silhouetteBottomPixels: range(frames.map(frame => frame.evidence.silhouetteBottom)), torsoCenterXPixels: range(frames.map(frame => frame.evidence.torsoCenterEstimate?.x)), torsoCenterYPixels: range(frames.map(frame => frame.evidence.torsoCenterEstimate?.y)), note: 'Offsets are measured in each original cell, with per-frame deviations from the median. Body motion and gait can legitimately shift these values.' },
    reviewStatus: 'human-review-pending', artifacts: {},
  };
  if (/-alpha\.png$/i.test(file)) {
    const greenFile = file.replace(/-alpha\.png$/i, '-green.png');
    const original = await fs.readFile(greenFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (original) {
      if (original.readUInt32BE(16) !== width || original.readUInt32BE(20) !== height) throw new Error('Paired green original dimensions differ; pixel-coordinate comparison would be misleading.');
      report.greenSourceComparison = { source: greenFile, sha256: sha(original), ...compareGreenForeground(await runDecoder(greenFile, width * height * 4), rgba, width, height) };
    }
  }
  const safeName = path.basename(file, path.extname(file)).replace(/[^a-zA-Z0-9_-]/g, '_');
  report.outputDirectory = path.join(outputRoot, `${safeName}-${originalHash.slice(0, 8)}`); await fs.mkdir(report.outputDirectory, { recursive: true });
  sources.set(`/source-${reports.length}.png`, { bytes, report }); reports.push(report);
  if (sha(await fs.readFile(file)) !== originalHash) throw new Error(`Source changed while inspecting ${file}`);
}
const server = createServer((request, response) => {
  const source = sources.get(request.url);
  if (source) { response.setHeader('content-type', 'image/png'); response.end(source.bytes); }
  else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><style>body{margin:0}canvas{display:block}</style><canvas></canvas>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: options.chrome, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1800 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for (let index = 0; index < reports.length; index++) {
    const report = reports[index];
    for (const theme of ['light', 'dark']) {
      await page.evaluate(async ({ report, index, theme }) => {
        const image = new Image(); image.src = `/source-${index}.png`; await image.decode();
        const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d'), tileW = 240, tileH = 412;
        canvas.width = report.columns * tileW; canvas.height = report.rows * tileH;
        ctx.fillStyle = theme === 'dark' ? '#252232' : '#f2f0f7'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        for (const frame of report.frames) {
          const x = frame.column * tileW, y = frame.row * tileH, region = frame.sourceRegion, scale = Math.min((tileW - 24) / region.width, 340 / region.height), dx = x + (tileW - region.width * scale) / 2, dy = y + 30;
          ctx.fillStyle = theme === 'dark' ? '#e1d8ee' : '#4e435c'; ctx.font = '13px sans-serif'; ctx.fillText(`Frame ${String(frame.index).padStart(2, '0')} · ${region.width}×${region.height}`, x + 10, y + 19);
          ctx.strokeStyle = theme === 'dark' ? '#71627d' : '#c4bacf'; ctx.strokeRect(dx, dy, region.width * scale, region.height * scale);
          ctx.drawImage(image, region.x, region.y, region.width, region.height, dx, dy, region.width * scale, region.height * scale);
          if (frame.mainBodyBBox) { const b = frame.mainBodyBBox; ctx.setLineDash([3, 3]); ctx.strokeStyle = frame.cellEdgeMainBody.length ? '#ec6f6f' : '#ab8c44'; ctx.strokeRect(dx + b.x * scale, dy + b.y * scale, b.width * scale, b.height * scale); ctx.setLineDash([]); }
          ctx.fillStyle = frame.cellEdgeMainBody.length ? '#dc7979' : theme === 'dark' ? '#bdb0cc' : '#746580'; ctx.font = '11px sans-serif';
          ctx.fillText(`bottom ${frame.footBaselineEstimate ?? '?'} · torso x ${frame.torsoCenterEstimate?.x.toFixed(1) ?? '?'}`, x + 10, y + 386);
          ctx.fillText(frame.cellEdgeMainBody.length ? 'Body touches: ' + frame.cellEdgeMainBody.join(',') : 'Manual appearance review pending', x + 10, y + 402);
        }
      }, { report, index, theme });
      const file = path.join(report.outputDirectory, `contact-${theme}.png`); await page.locator('canvas').screenshot({ path: file }); report.artifacts[`contact-${theme}`] = file;
    }
    const json = path.join(report.outputDirectory, 'inspection.json'); report.artifacts.report = json;
    await fs.writeFile(json, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ source: report.source, size: `${report.width}x${report.height}`, frames: report.frames.length, touchingFrames: report.frames.filter(frame => frame.cellEdgeMainBody.length).map(frame => frame.index), duplicateReviewPairs: report.duplicatePairs.length, alignment: report.alignment, report: json, contacts: report.artifacts }));
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
await fs.writeFile(path.join(outputRoot, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), reviewStatus: 'human-review-pending', sources: reports.map(report => ({ source: report.source, sha256: report.sha256, report: report.artifacts.report, contacts: report.artifacts })) }, null, 2) + '\n');
for (const report of reports) if (sha(await fs.readFile(report.source)) !== report.sha256) throw new Error(`Original source changed: ${report.source}`);
