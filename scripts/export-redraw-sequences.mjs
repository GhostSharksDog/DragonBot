import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contains = (base, target) => { const relative = path.relative(base, target); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const u24 = value => { assert(Number.isInteger(value) && value >= 0 && value <= 0xffffff); const bytes = Buffer.alloc(3); bytes.writeUIntLE(value, 0, 3); return bytes; };
const chunk = (name, payload) => { const header = Buffer.alloc(8); header.write(name, 0, 'ascii'); header.writeUInt32LE(payload.length, 4); return Buffer.concat([header, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
export const frameDurations = (total, count = 24) => Array.from({ length: count }, (_, index) => Math.floor((index + 1) * total / count) - Math.floor(index * total / count));
export function playbackOrder(config, id) {
  if (!config) return { sourceIndices: Array.from({ length: 24 }, (_, index) => index + 1), holds: [] };
  assert.equal(config.approvedByRoot, true, 'Playback reordering requires the reviewed approvedByRoot:true order file.'); assert.equal(config.indexBase, 1, 'Order files use explicit 1-based source frame numbers.'); assert(typeof config.reason === 'string' && config.reason.trim());
  const action = config.actions?.[id]; if (!action) return { sourceIndices: Array.from({ length: 24 }, (_, index) => index + 1), holds: [] };
  assert.equal(action.sourceIndices?.length, 24, `${id} must have 24 output-frame source indices.`); for (const source of action.sourceIndices) assert(Number.isInteger(source) && source >= 1 && source <= 24, 'Source indices are integers 1–24.');
  const holds = action.holds ?? [], seen = new Set();
  for (const [index, source] of action.sourceIndices.entries()) { if (seen.has(source)) { const hold = holds.find(value => value.outputFrame === index + 1 && value.sourceFrame === source); assert(hold && typeof hold.reason === 'string' && hold.reason.trim(), `Duplicated ${id} source frame ${source} at output ${index + 1} requires an explicit hold explanation.`); } seen.add(source); }
  for (const hold of holds) { assert(Number.isInteger(hold.outputFrame) && hold.outputFrame >= 1 && hold.outputFrame <= 24); assert.equal(action.sourceIndices[hold.outputFrame - 1], hold.sourceFrame); }
  return { sourceIndices: [...action.sourceIndices], holds };
}
export function labelAlphaComponents(rgba, width, height, threshold = 128) {
  const labels = new Int32Array(width * height), queue = new Int32Array(width * height), components = [];
  for (let seed = 0; seed < labels.length; seed++) {
    if (labels[seed] || rgba[seed * 4 + 3] < threshold) continue;
    const id = components.length + 1; let head = 0, tail = 1, minX = width, minY = height, maxX = -1, maxY = -1; queue[0] = seed; labels[seed] = id;
    while (head < tail) { const pixel = queue[head++], x = pixel % width, y = Math.floor(pixel / width); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue; const next = ny * width + nx; if (!labels[next] && rgba[next * 4 + 3] >= threshold) { labels[next] = id; queue[tail++] = next; } }
    }
    components.push({ id, pixels: tail, bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, right: maxX + 1, bottom: maxY + 1 }, touchesSourceEdges: [minX === 0 && 'left', minY === 0 && 'top', maxX === width - 1 && 'right', maxY === height - 1 && 'bottom'].filter(Boolean) });
  }
  return { labels, components };
}
export function inspectBodyAlpha(rgba, width, height, threshold = 128) {
  const { components } = labelAlphaComponents(rgba, width, height, threshold); return { threshold, connectivity: 8, largest: components.sort((a, b) => b.pixels - a.pixels)[0] ?? null };
}

function webpChunks(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WEBP'); assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
  const chunks = []; let offset = 12;
  while (offset < bytes.length) { const name = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), end = offset + 8 + size; assert(end <= bytes.length); chunks.push({ name, payload: bytes.subarray(offset + 8, end), bytes: bytes.subarray(offset, end + size % 2) }); offset = end + size % 2; }
  assert.equal(offset, bytes.length); return chunks;
}
// Mux unmodified lossless full-canvas VP8L frames. Frame durations are integer
// milliseconds, independent of encoder framerate rounding, and alpha is retained.
export function animatedWebp(frames, width, height, durations) {
  assert.equal(frames.length, durations.length); const extended = Buffer.concat([Buffer.from([0x12, 0, 0, 0]), u24(width - 1), u24(height - 1)]);
  const chunks = [chunk('VP8X', extended), chunk('ANIM', Buffer.alloc(6))];
  for (let index = 0; index < frames.length; index++) {
    const source = webpChunks(frames[index]); assert(!source.some(value => value.name === 'VP8 ' || value.name === 'ANMF'), 'Frame must be a single lossless WebP.');
    const lossless = source.filter(value => value.name === 'VP8L'); assert.equal(lossless.length, 1); const payload = lossless[0].payload; assert.equal(payload[0], 0x2f);
    const bits = payload.readUInt32LE(1); assert.equal((bits & 0x3fff) + 1, width); assert.equal(((bits >>> 14) & 0x3fff) + 1, height);
    // No-blend replaces the whole canvas, including transparent pixels.
    const header = Buffer.concat([u24(0), u24(0), u24(width - 1), u24(height - 1), u24(durations[index]), Buffer.from([2])]);
    chunks.push(chunk('ANMF', Buffer.concat([header, lossless[0].bytes])));
  }
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]), header = Buffer.alloc(8); header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(body.length, 4); return Buffer.concat([header, body]);
}
export function inspectAnimatedWebp(bytes) {
  const chunks = webpChunks(bytes), extended = chunks.find(value => value.name === 'VP8X')?.payload; assert(extended && extended[0] & 2);
  const frames = chunks.filter(value => value.name === 'ANMF'); assert(frames.length);
  const durations = frames.map(({ payload }) => payload.readUIntLE(12, 3));
  for (const { payload } of frames) { assert.equal(payload[15], 2); assert.equal(payload.toString('ascii', 16, 20), 'VP8L'); assert.equal(payload.readUInt32LE(20) + 24 + payload.readUInt32LE(20) % 2, payload.length); }
  return { width: extended.readUIntLE(4, 3) + 1, height: extended.readUIntLE(7, 3) + 1, frames: frames.length, durationsMs: durations, totalMs: durations.reduce((a, b) => a + b, 0), lossless: true, alpha: Boolean(extended[0] & 16), loopCount: chunks.find(value => value.name === 'ANIM').payload.readUInt16LE(4) };
}

export function inspectGif(bytes) {
  assert(['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))); const global = Boolean(bytes[10] & 128), size = global ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0;
  let index = 13 + size, loopCount = null; const frames = [], locals = [];
  const skip = () => { while (index < bytes.length) { const count = bytes[index++]; if (!count) return; index += count; } throw new Error('Truncated GIF.'); };
  let control;
  while (index < bytes.length) {
    const marker = bytes[index++]; if (marker === 0x3b) break;
    if (marker === 0x21) { const label = bytes[index++]; if (label === 0xf9) { assert.equal(bytes[index], 4); control = { delayAt: index + 2, delay: bytes.readUInt16LE(index + 2), transparent: Boolean(bytes[index + 1] & 1) }; } else if (label === 0xff && bytes[index] === 11 && bytes.toString('ascii', index + 1, index + 12) === 'NETSCAPE2.0') { assert.equal(bytes[index + 12], 3); assert.equal(bytes[index + 13], 1); loopCount = bytes.readUInt16LE(index + 14); } skip(); continue; }
    assert.equal(marker, 0x2c); const packedAt = index + 8, packed = bytes[packedAt]; index += 9;
    if (packed & 128) { const localSize = 3 * 2 ** ((packed & 7) + 1); assert.equal(localSize, size); assert(bytes.subarray(index, index + localSize).equals(bytes.subarray(13, 13 + size)), 'GIF encoder changed color indices.'); locals.push({ packedAt, start: index, end: index + localSize }); index += localSize; }
    assert(control, 'GIF frame is missing its duration.'); frames.push(control); control = null; index++; skip();
  }
  return { frames, locals, global, loopCount, paletteSha256: sha(bytes.subarray(13, 13 + size)), width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}
export function normalizeGif(bytes, durationsCs) {
  const info = inspectGif(bytes); assert(info.global); assert.equal(info.frames.length, durationsCs.length); const copy = Buffer.from(bytes);
  for (let index = 0; index < info.frames.length; index++) copy.writeUInt16LE(durationsCs[index], info.frames[index].delayAt);
  let cursor = 0; const parts = [];
  // Remove only byte-identical redundant local palettes; pixel indices stay intact.
  for (const local of info.locals) { parts.push(copy.subarray(cursor, local.packedAt), Buffer.from([copy[local.packedAt] & 127]), copy.subarray(local.packedAt + 1, local.start)); cursor = local.end; }
  parts.push(copy.subarray(cursor)); return Buffer.concat(parts);
}

const crcTable = Array.from({ length: 256 }, (_, value) => { for (let index = 0; index < 8; index++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
const crc32 = bytes => { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0; };
async function zipDirectory(directory, destination) {
  const files = []; async function walk(root) { for (const entry of await fs.readdir(root, { withFileTypes: true })) { if (entry.name.startsWith('.render-')) continue; const name = path.join(root, entry.name); if (entry.isDirectory()) await walk(name); else if (entry.isFile() && name !== destination) files.push(name); } } await walk(directory); files.sort();
  const local = [], central = []; let offset = 0;
  for (const file of files) {
    const bytes = await fs.readFile(file), name = Buffer.from(path.relative(directory, file).replaceAll('\\', '/')), crc = crc32(bytes), header = Buffer.alloc(30); assert(bytes.length <= 0xffffffff && offset <= 0xffffffff);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes); const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); header.copy(record, 6, 4, 30); record.writeUInt32LE(offset, 42); central.push(record, name); offset += header.length + name.length + bytes.length;
  }
  const directoryBytes = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16); await fs.writeFile(destination, Buffer.concat([...local, directoryBytes, end])); return { files: files.length, bytes: (await fs.stat(destination)).size, sha256: sha(await fs.readFile(destination)) };
}
async function encode(ffmpeg, args) {
  await new Promise((resolve, reject) => { const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] }); let errors = ''; child.stderr.on('data', data => { errors = (errors + data).slice(-4000); }); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg (${code}): ${errors}`))); });
}
async function decodeRgba(ffmpeg, input, sequence = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...(sequence ? ['-framerate', '12', '-start_number', '1'] : ['-ignore_loop', '1']), '-i', input, '-frames:v', '24', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const parts = []; let errors = ''; child.stdout.on('data', data => parts.push(data)); child.stderr.on('data', data => { errors = (errors + data).slice(-2000); }); child.once('error', reject); child.once('close', code => code === 0 ? resolve(Buffer.concat(parts)) : reject(new Error(`RGBA verification (${code}): ${errors}`)));
  });
}

async function main() {
  const argument = name => { const index = process.argv.indexOf(name); if (index === -1) return null; const value = process.argv[index + 1]; if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`); return value; };
  const output = path.resolve(argument('--out') ?? path.join(project, 'release/animation-redraw-v1')), sourceRoot = path.join(project, 'assets/animation-redraw-v1');
  assert(contains(path.join(project, 'release'), output) || contains(path.join(project, '.local'), output), 'Outputs must stay in project release/ or .local/.');
  assert(!contains(sourceRoot, output) && !contains(output, sourceRoot), 'Do not write into source assets.');
  assert(!process.argv.includes('--green-screen'), 'Only original source alpha is supported. Green-screen encoding was removed.');
  if (process.argv.includes('--zip-only')) {
    assert(contains(await fs.realpath(project), await fs.realpath(output)), 'ZIP output directory must not link outside project.');
    const existing = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
    for (const source of existing.sources) { const saved = path.resolve(output, source.savedSource); assert(contains(output, saved)); assert.equal(sha(await fs.readFile(saved)), source.sha256, 'Packaged source PNG must remain unchanged.'); }
    console.log(JSON.stringify({ ok: true, zipOnly: true, ...await zipDirectory(output, path.join(output, 'animation-redraw-v1.zip')) }, null, 2)); return;
  }
  const scale = Number(argument('--scale') ?? 1); assert(Number.isFinite(scale) && scale > 0 && scale <= 4, 'Scale must be one shared positive factor, at most 4.');
  const padding = Number(argument('--padding') ?? 8); assert(Number.isInteger(padding) && padding >= 8 && padding <= 128, 'Shared padding must be an integer of at least 8 pixels.');
  const chrome = argument('--chrome') ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', ffmpeg = argument('--ffmpeg') ?? 'E:/Apps/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe';
  const sources = [{ id: 'thinking', label: '思考', file: path.resolve(argument('--thinking') ?? path.join(sourceRoot, 'raw/thinking.png')), durationMs: 2000 }, { id: 'running-left', label: '向左跑', file: path.resolve(argument('--running-left') ?? path.join(sourceRoot, 'raw/running-left.png')), durationMs: 1800 }];
  const offsetsPath = argument('--offsets'), offsets = offsetsPath ? JSON.parse(await fs.readFile(offsetsPath, 'utf8')) : null;
  const orderPath = argument('--order'), order = orderPath ? JSON.parse(await fs.readFile(orderPath, 'utf8')) : null;
  const rectsPath = argument('--source-rects'), sourceRects = rectsPath ? JSON.parse(await fs.readFile(rectsPath, 'utf8')) : null;
  if (sourceRects) { assert.equal(sourceRects.approvedByRoot, true, 'Whole-character source rectangles must be visually reviewed and approvedByRoot:true.'); assert.equal(sourceRects.indexBase, 1); assert(typeof sourceRects.reason === 'string' && sourceRects.reason.trim()); assert(sourceRects.sources && Object.keys(sourceRects.sources).every(id => ['thinking', 'running-left'].includes(id))); }
  for (const id of ['thinking', 'running-left']) playbackOrder(order, id);
  if (offsets) { assert.equal(offsets.approvedByRoot, true, 'Per-cell pure translations require prior root visual review and explicit approvedByRoot:true.'); assert(typeof offsets.reason === 'string' && offsets.reason.trim(), 'Record the reviewed translation reason.'); }
  for (const source of sources) { source.bytes = await fs.readFile(source.file); source.sha256 = sha(source.bytes); const rectangles = sourceRects?.sources?.[source.id]; if (rectangles) { assert.equal(rectangles.sourceSha256, source.sha256, 'Reviewed source rectangles must match the exact selected raw PNG hash.'); assert.equal(rectangles.frames?.length, 24); assert(!offsets?.frames?.[source.id], 'Source-rect destinations are final placements; do not add a second offset list for the same action.'); } }
  if (offsets?.sourceSha256) { const source = offsets.source ? sources.find(source => path.resolve(source.file).toLowerCase() === path.resolve(offsets.source).toLowerCase()) : Object.keys(offsets.frames ?? {}).length === 1 ? sources.find(source => source.id === Object.keys(offsets.frames)[0]) : null; assert(source, 'Hash-bound translations must identify their selected source PNG.'); assert.equal(source.sha256, offsets.sourceSha256, 'Reviewed translations must match the exact selected raw PNG hash.'); }
  await fs.mkdir(output, { recursive: true }); const realOutput = await fs.realpath(output); assert(contains(await fs.realpath(project), realOutput), 'Output directory must not link outside project.');
  for (const source of sources) assert(!contains(realOutput, await fs.realpath(source.file)), 'Output may not contain raw sources.');
  const work = path.join(output, '.render-' + randomUUID()); await fs.mkdir(work); let browser;
  const manifest = { version: 1, name: '完整角色逐帧动画 · 机械导出', count: 24, columns: 6, rows: 4, commonCanvas: null, scale, padding, transformPolicy: 'strict uniform-grid crop or explicitly hash-matched reviewed whole-character source rectangles; shared padded canvas and optional one global uniform scale; reviewed whole-frame playback selection/repeated holds; right-run horizontal mirror only; original alpha preserved', transparencyEncoding: { mode: 'preserve-source-alpha' }, playbackOrder: order ?? null, wholeCharacterSourceRects: sourceRects ?? null, translations: offsets ?? null, translationIndexing: '24 offsets indexed by original source frame 1–24, applied before playback reordering; source-rect destinations already include final padding/placement and never receive additional offsets', sources: sources.map(({ id, file, sha256 }) => ({ id, file: path.relative(project, file).replaceAll('\\', '/'), savedSource: `sources/${id}.png`, sha256 })), sourcePngUnchanged: false, animations: [] };
  try {
    browser = await chromium.launch({ executablePath: chrome, headless: true }); const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 }); await page.setContent('<canvas></canvas>');
    await page.evaluate(`window.labelAlphaComponents = ${labelAlphaComponents.toString()}; window.inspectBodyAlpha = ${inspectBodyAlpha.toString()}`);
    const grids = await page.evaluate(async sources => {
      window.redrawImages = new Map(); const grids = [];
      for (const source of sources) { const image = new Image(); image.src = 'data:image/png;base64,' + source.encoded; await image.decode(); if (image.naturalWidth < 6 || image.naturalHeight < 4) throw new Error(`${source.id}: raw atlas is too small for 6 × 4 cells.`); window.redrawImages.set(source.id, image); grids.push({ id: source.id, width: Math.ceil(image.naturalWidth / 6), height: Math.ceil(image.naturalHeight / 4), xEdges: Array.from({ length: 7 }, (_, index) => Math.floor(index * image.naturalWidth / 6)), yEdges: Array.from({ length: 5 }, (_, index) => Math.floor(index * image.naturalHeight / 4)), sourceWidth: image.naturalWidth, sourceHeight: image.naturalHeight }); }
      return grids;
    }, sources.map(source => ({ id: source.id, encoded: source.bytes.toString('base64') })));
    const common = { width: Math.max(...grids.map(grid => grid.width)) + padding * 2, height: Math.max(...grids.map(grid => grid.height)) + padding * 2 }, size = { width: common.width * scale, height: common.height * scale };
    assert(Number.isInteger(size.width) && Number.isInteger(size.height), 'Shared uniform scale must produce integer canvas dimensions.'); assert(size.width <= 4096 && size.height <= 4096, 'Common canvas is unexpectedly large.'); manifest.commonCanvas = { ...size, logicalWidth: common.width, logicalHeight: common.height, paddingLogicalPixels: padding, paddingOutputPixels: padding * scale, anchor: { x: size.width / 2, y: (common.height - padding) * scale }, placement: 'integer floor grid edges; shared 8px-or-greater padding on all sides; cell horizontally centered, bottom content edge aligned; no automatic per-frame registration' }; manifest.sourceGrids = grids;
    if (sourceRects) manifest.sourceRectValidation = await page.evaluate(({ config, common, padding }) => {
      const reviews = [];
      for (const [id, source] of Object.entries(config.sources)) {
        const image = window.redrawImages.get(id), canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0); const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data, { labels, components } = window.labelAlphaComponents(rgba, canvas.width, canvas.height), bodies = components.sort((a, b) => b.pixels - a.pixels).slice(0, 24), bodyIds = new Set(bodies.map(body => body.id)), assigned = new Set(), frames = [];
        if (bodies.length !== 24) throw new Error(`${id}: cannot identify 24 separate main alpha bodies.`);
        for (let index = 0; index < 24; index++) {
          const { sourceRect: rect, destination } = source.frames[index];
          if (!rect || !destination || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(rect[key])) || !['x', 'y'].every(key => Number.isInteger(destination[key]))) throw new Error(`${id} source frame ${index + 1}: rectangles and final placements must be integer pixels.`);
          if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > canvas.width || rect.y + rect.height > canvas.height) throw new Error(`${id} source frame ${index + 1}: rectangle is outside raw PNG.`);
          if (destination.x < padding || destination.y < padding || destination.x + rect.width > common.width - padding || destination.y + rect.height > common.height - padding) throw new Error(`${id} source frame ${index + 1}: full rectangle must fit common canvas with all shared padding; no per-frame scaling is allowed.`);
          const included = new Set(); for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) { const label = labels[y * canvas.width + x]; if (bodyIds.has(label)) included.add(label); }
          if (included.size !== 1) throw new Error(`${id} source frame ${index + 1}: rectangle includes ${included.size} main characters; neighbor pixels are forbidden.`);
          const body = bodies.find(body => included.has(body.id)), box = body.bbox;
          if (assigned.has(body.id)) throw new Error(`${id}: two source rectangles select the same character; use explicit playback holds instead.`);
          if (box.x < rect.x || box.y < rect.y || box.right > rect.x + rect.width || box.bottom > rect.y + rect.height) throw new Error(`${id} source frame ${index + 1}: rectangle cuts its full main alpha component.`);
          if (body.touchesSourceEdges.length) throw new Error(`${id} source frame ${index + 1}: main character touches original PNG outer boundary.`);
          assigned.add(body.id); frames.push({ sourceFrame: index + 1, sourceRect: rect, destination, mainBody: body, includesNeighborMainBody: false });
        }
        for (let a = 0; a < 24; a++) for (let b = a + 1; b < 24; b++) { const left = source.frames[a].sourceRect, right = source.frames[b].sourceRect, x0 = Math.max(left.x, right.x), y0 = Math.max(left.y, right.y), x1 = Math.min(left.x + left.width, right.x + right.width), y1 = Math.min(left.y + left.height, right.y + right.height); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (rgba[(y * canvas.width + x) * 4 + 3] >= 128) throw new Error(`${id} source rectangles ${a + 1}/${b + 1} overlap actual foreground alpha.`); }
        reviews.push({ id, method: '24 largest alpha>=128 8-connected main components; entire component within its rectangle; no other main component; no actual alpha>=128 overlap between source rectangles; original PNG boundary checked; final rectangle fits shared padding', frames });
      }
      return reviews;
    }, { config: sourceRects, common, padding });
    const actions = [...sources.map(source => ({ ...source, grid: grids.find(grid => grid.id === source.id), mirrored: false })), { id: 'running-right', label: '向右跑', durationMs: 1800, grid: grids.find(grid => grid.id === 'running-left'), mirrored: true }];
    const allFrames = [];
    for (const action of actions) {
      const directory = path.join(output, action.id); await fs.mkdir(directory, { recursive: true }); const stats = [];
      const selection = playbackOrder(order, action.mirrored ? 'running-left' : action.id), seenSources = new Set(), outputMapping = selection.sourceIndices.map((sourceFrame, index) => { const duplicatedHold = seenSources.has(sourceFrame); seenSources.add(sourceFrame); return { outputFrame: index + 1, sourceFrame, sourceIndex0: sourceFrame - 1, duplicatedHold, holdReason: duplicatedHold ? selection.holds.find(hold => hold.outputFrame === index + 1)?.reason : null }; });
      const reviewed = offsets?.frames?.[action.mirrored ? 'running-left' : action.id];
      if (reviewed) { assert.equal(reviewed.length, 24); for (const point of reviewed) assert(Number.isInteger(point.x) && Number.isInteger(point.y), 'Only integer pure translations are allowed.'); }
      for (let index = 0; index < 24; index++) {
        const sourceIndex = selection.sourceIndices[index] - 1;
        const sourceAction = action.mirrored ? 'running-left' : action.id, approvedPlacement = sourceRects?.sources?.[sourceAction]?.frames[sourceIndex] ?? null, reviewedBody = manifest.sourceRectValidation?.find(review => review.id === sourceAction)?.frames[sourceIndex].mainBody ?? null;
        const result = await page.evaluate(({ action, sourceIndex, index, common, size, scale, padding, offset, approvedPlacement, reviewedBody }) => {
          const image = window.redrawImages.get(action.mirrored ? 'running-left' : action.id), canvas = document.querySelector('canvas'); canvas.width = size.width; canvas.height = size.height; const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (action.mirrored) { ctx.translate(size.width, 0); ctx.scale(-1, 1); } ctx.scale(scale, scale);
          const column = sourceIndex % 6, row = Math.floor(sourceIndex / 6), sourceX = approvedPlacement?.sourceRect.x ?? action.grid.xEdges[column], sourceY = approvedPlacement?.sourceRect.y ?? action.grid.yEdges[row], cellWidth = approvedPlacement?.sourceRect.width ?? action.grid.xEdges[column + 1] - sourceX, cellHeight = approvedPlacement?.sourceRect.height ?? action.grid.yEdges[row + 1] - sourceY;
          const sourceCanvas = document.createElement('canvas'); sourceCanvas.width = cellWidth; sourceCanvas.height = cellHeight; const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true }); sourceCtx.drawImage(image, sourceX, sourceY, cellWidth, cellHeight, 0, 0, cellWidth, cellHeight); const body = window.inspectBodyAlpha(sourceCtx.getImageData(0, 0, cellWidth, cellHeight).data, cellWidth, cellHeight);
          if (!body.largest) throw new Error(`${action.id} source frame ${sourceIndex + 1}: no main alpha body.`);
          if (!approvedPlacement && body.largest.touchesSourceEdges.length) throw new Error(`${action.id} source frame ${sourceIndex + 1}: main alpha body touches raw grid ${body.largest.touchesSourceEdges.join('/')}; refusing to crop a possibly clipped complete character.`);
          if (reviewedBody && body.largest.pixels !== reviewedBody.pixels) throw new Error(`${action.id} source frame ${sourceIndex + 1}: approved rectangle did not preserve its complete original main alpha component.`);
          const x = approvedPlacement?.destination.x ?? Math.floor((common.width - cellWidth) / 2) + (offset?.x ?? 0), y = approvedPlacement?.destination.y ?? common.height - padding - cellHeight + (offset?.y ?? 0), box = body.largest.bbox;
          if (x + box.x < 0 || y + box.y < 0 || x + box.right > common.width || y + box.bottom > common.height) throw new Error(`${action.id} source frame ${sourceIndex + 1}: reviewed translation would clip main alpha body.`);
          ctx.drawImage(image, sourceX, sourceY, cellWidth, cellHeight, x, y, cellWidth, cellHeight);
          const bytes = ctx.getImageData(0, 0, size.width, size.height).data; let minX = size.width, minY = size.height, maxX = -1, maxY = -1, nonzero = 0, partial = 0, transparent = 0;
          for (let pixel = 0; pixel < bytes.length; pixel += 4) { const alpha = bytes[pixel + 3]; if (alpha === 0) { transparent++; continue; } if (alpha < 255) partial++; const x = pixel / 4 % size.width, y = Math.floor(pixel / 4 / size.width); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); nonzero++; }
          return { png: canvas.toDataURL('image/png').split(',')[1], placement: { sourceRect: { x: sourceX, y: sourceY, width: cellWidth, height: cellHeight }, destination: { x, y }, fullCharacterTranslation: { x: x - sourceX, y: y - sourceY }, sourceExtraction: approvedPlacement ? 'reviewed-whole-character-rectangle' : 'strict-uniform-grid-cell', mirroredAfterPlacement: action.mirrored }, stats: { frame: index + 1, sourceFrame: sourceIndex + 1, bodyIntegrity: { ...body, sourceRectReviewed: Boolean(approvedPlacement), clippedByOutput: false, logicalTargetMargins: { left: x + box.x, top: y + box.y, right: common.width - x - box.right, bottom: common.height - y - box.bottom } }, bbox: nonzero ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, bottom: maxY + 1 } : null, nonzeroPixels: nonzero, partiallyTransparentPixels: partial, transparentPixels: transparent, touchesEdge: minX === 0 || minY === 0 || maxX === size.width - 1 || maxY === size.height - 1 } };
        }, { action: { id: action.id, grid: action.grid, mirrored: action.mirrored }, sourceIndex, index, common, size, scale, padding, offset: reviewed?.[sourceIndex] ?? null, approvedPlacement, reviewedBody });
        Object.assign(outputMapping[index], result.placement);
        assert(result.stats.nonzeroPixels > 0, `${action.id} frame ${index + 1} is empty.`); assert(result.stats.transparentPixels > 0, `${action.id} frame ${index + 1} has no transparency. Raw alpha must already be correct; this script never removes backgrounds.`);
        const destination = path.join(directory, `frame-${String(index + 1).padStart(2, '0')}.png`); await fs.writeFile(destination, Buffer.from(result.png, 'base64')); stats.push(result.stats); allFrames.push(destination);
      }
      const atlas = await page.evaluate(async ({ paths, size }) => { const canvas = document.querySelector('canvas'); canvas.width = size.width * 6; canvas.height = size.height * 4; const ctx = canvas.getContext('2d'); for (let index = 0; index < paths.length; index++) { const image = new Image(); image.src = paths[index]; await image.decode(); ctx.drawImage(image, index % 6 * size.width, Math.floor(index / 6) * size.height); } return canvas.toDataURL('image/png').split(',')[1]; }, { paths: await Promise.all(Array.from({ length: 24 }, async (_, index) => 'data:image/png;base64,' + (await fs.readFile(path.join(directory, `frame-${String(index + 1).padStart(2, '0')}.png`))).toString('base64'))), size });
      await fs.writeFile(path.join(output, `${action.id}-atlas.png`), Buffer.from(atlas, 'base64'));
      manifest.animations.push({ id: action.id, label: action.label, durationMs: action.durationMs, frameDurationsMs: frameDurations(action.durationMs), gifDurationsCs: frameDurations(action.durationMs / 10), frameCount: 24, uniqueSourceFrames: seenSources.size, duplicateHoldFrames: outputMapping.filter(frame => frame.duplicatedHold).length, outputMapping, frames: Array.from({ length: 24 }, (_, index) => `${action.id}/frame-${String(index + 1).padStart(2, '0')}.png`), atlas: `${action.id}-atlas.png`, webp: `${action.id}.webp`, gif: `${action.id}.gif`, mirroredFrom: action.mirrored ? 'running-left' : null, geometry: stats });
      console.log(`Cropped ${action.id}: 24 complete-character frames, ${size.width} × ${size.height}.`);
    }
    const [leftRgba, rightRgba] = await Promise.all(['running-left', 'running-right'].map(id => decodeRgba(ffmpeg, path.join(output, id, 'frame-%02d.png')))); assert.equal(leftRgba.length, rightRgba.length);
    for (let pixel = 0; pixel < leftRgba.length; pixel += 4) { const x = pixel / 4 % size.width, other = pixel + (size.width - 1 - 2 * x) * 4; assert(leftRgba[pixel] === rightRgba[other] && leftRgba[pixel + 1] === rightRgba[other + 1] && leftRgba[pixel + 2] === rightRgba[other + 2] && leftRgba[pixel + 3] === rightRgba[other + 3], 'Right run must be an exact horizontal mirror of the exported left PNG sequence.'); }
    manifest.mirrorVerification = { checkedFrames: 24, exactRgbaMirror: true };
    const concat = path.join(work, 'palette.ffconcat'), palette = path.join(output, 'global-palette.png'); await fs.writeFile(concat, 'ffconcat version 1.0\n' + allFrames.map(file => `file '${file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`).join('\n'));
    await encode(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', concat, '-vf', 'palettegen=stats_mode=full:reserve_transparent=1:max_colors=256', '-frames:v', '1', '-update', '1', palette]);
    const normalizedPalette = await page.evaluate(async encoded => {
      const image = new Image(); image.src = 'data:image/png;base64,' + encoded; await image.decode(); const canvas = document.querySelector('canvas'); canvas.width = 16; canvas.height = 16; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); const pixels = ctx.getImageData(0, 0, 16, 16), bytes = pixels.data;
      const key = index => bytes[index * 4] << 16 | bytes[index * 4 + 1] << 8 | bytes[index * 4 + 2], occupied = new Set(Array.from({ length: 256 }, (_, index) => key(index))), seen = new Set(); let next = 0x010000;
      for (let index = 0; index < 256; index++) { let color = key(index); if (seen.has(color) || (index < 255 && color === 0)) { while (occupied.has(next)) next++; color = next++; occupied.add(color); bytes[index * 4] = color >> 16 & 255; bytes[index * 4 + 1] = color >> 8 & 255; bytes[index * 4 + 2] = color & 255; } seen.add(color); bytes[index * 4 + 3] = index === 255 ? 0 : 255; }
      ctx.putImageData(pixels, 0, 0); return canvas.toDataURL('image/png').split(',')[1];
    }, (await fs.readFile(palette)).toString('base64')); await fs.writeFile(palette, Buffer.from(normalizedPalette, 'base64'));
    let paletteHash;
    for (const action of manifest.animations) {
      const input = path.join(output, action.id, 'frame-%02d.png'), webpRoot = path.join(work, action.id); await fs.mkdir(webpRoot);
      await encode(ffmpeg, ['-framerate', '12', '-start_number', '1', '-i', input, '-i', palette, '-filter_complex', '[0:v][1:v]paletteuse=dither=none:alpha_threshold=128:new=0', '-frames:v', '24', '-global_palette', '1', '-loop', '0', path.join(output, action.gif)]);
      await fs.writeFile(path.join(output, action.gif), normalizeGif(await fs.readFile(path.join(output, action.gif)), action.gifDurationsCs)); const gif = inspectGif(await fs.readFile(path.join(output, action.gif)));
      assert.equal(gif.locals.length, 0); assert.equal(gif.frames.length, 24); assert.equal(gif.loopCount, 0); assert(gif.frames.every(frame => frame.transparent)); if (paletteHash) assert.equal(gif.paletteSha256, paletteHash); paletteHash = gif.paletteSha256;
      await encode(ffmpeg, ['-framerate', '12', '-start_number', '1', '-i', input, '-frames:v', '24', '-c:v', 'libwebp', '-lossless', '1', '-quality', '100', '-compression_level', '4', '-pix_fmt', 'bgra', '-start_number', '1', path.join(webpRoot, '%02d.webp')]);
      const frames = await Promise.all(Array.from({ length: 24 }, (_, index) => fs.readFile(path.join(webpRoot, `${String(index + 1).padStart(2, '0')}.webp`)))); const webp = animatedWebp(frames, size.width, size.height, action.frameDurationsMs); await fs.writeFile(path.join(output, action.webp), webp);
      const webpInfo = inspectAnimatedWebp(webp); assert.equal(webpInfo.totalMs, action.durationMs); assert.equal(webpInfo.frames, 24); assert(webpInfo.alpha && webpInfo.lossless); assert.deepEqual(webpInfo.durationsMs, action.frameDurationsMs);
      // Decode both formats with the same software decoder. Browsers can use
      // different premultiplication rounding for PNG and WebP canvas draws.
      const [pngRgba, webpRgba, gifRgba] = await Promise.all([decodeRgba(ffmpeg, input), decodeRgba(ffmpeg, path.join(webpRoot, '%02d.webp')), decodeRgba(ffmpeg, path.join(output, action.gif), false)]); assert.equal(pngRgba.length, size.width * size.height * 4 * 24); assert.equal(webpRgba.length, pngRgba.length); assert.equal(gifRgba.length, pngRgba.length);
      for (let pixel = 0; pixel < pngRgba.length; pixel += 4) assert(pngRgba[pixel + 3] === webpRgba[pixel + 3] && (pngRgba[pixel + 3] === 0 || pngRgba[pixel] === webpRgba[pixel] && pngRgba[pixel + 1] === webpRgba[pixel + 1] && pngRgba[pixel + 2] === webpRgba[pixel + 2]), 'Lossless WebP changed alpha or visible RGBA.');
      for (let pixel = 3; pixel < pngRgba.length; pixel += 4) assert.equal(gifRgba[pixel], pngRgba[pixel] >= 128 ? 255 : 0, 'GIF alpha/disposal must match the thresholded PNG without ghost pixels.');
      const losslessVerification = { checkedFrames: 24, decoder: 'FFmpeg rgba', equalAlphaAndVisibleRgba: true };
      action.verification = { gif: { frames: 24, durationsCs: gif.frames.map(frame => frame.delay), totalMs: gif.frames.reduce((sum, frame) => sum + frame.delay * 10, 0), loopCount: gif.loopCount, globalPaletteSha256: gif.paletteSha256, localPalettes: 0, dither: 'none', transparency: 'one-bit (GIF format limitation)', decodedThresholdAlphaMatches: true }, webp: { ...webpInfo, ...losslessVerification } }; assert.equal(action.verification.gif.totalMs, action.durationMs);
      console.log(`Encoded ${action.id}: exact ${action.durationMs}ms, shared GIF palette, lossless transparent WebP.`);
    }
    await fs.mkdir(path.join(output, 'sources'), { recursive: true }); for (const source of sources) { assert.equal(sha(await fs.readFile(source.file)), source.sha256, 'Raw source image was modified.'); await fs.copyFile(source.file, path.join(output, 'sources', `${source.id}.png`)); } manifest.sourcePngUnchanged = true;
    if (order) await fs.writeFile(path.join(output, 'playback-order.json'), JSON.stringify(order, null, 2));
    if (offsets) await fs.writeFile(path.join(output, 'translations.json'), JSON.stringify(offsets, null, 2));
    if (sourceRects) await fs.writeFile(path.join(output, 'whole-character-source-rects.json'), JSON.stringify(sourceRects, null, 2));
    {
      const qa = await page.evaluate(async ({ images, size }) => {
        const canvas = document.querySelector('canvas'), factor = 2, cellWidth = size.width * factor + 40, cellHeight = size.height * factor + 60; canvas.width = cellWidth * 2; canvas.height = cellHeight * images.length; const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.font = '18px "Microsoft YaHei",sans-serif';
        for (let row = 0; row < images.length; row++) { const image = new Image(); image.src = images[row].data; await image.decode(); for (let column = 0; column < 2; column++) { const x = column * cellWidth, y = row * cellHeight; ctx.fillStyle = column ? '#282331' : '#ffffff'; ctx.fillRect(x, y, cellWidth, cellHeight); ctx.fillStyle = column ? '#dfd2eb' : '#554166'; ctx.fillText(images[row].label + ' · 第1帧 · ' + (column ? '深色' : '浅色') + ' · 2× 像素边缘检查', x + 16, y + 28); ctx.drawImage(image, x + 20, y + 45, size.width * factor, size.height * factor); } }
        return canvas.toDataURL('image/png').split(',')[1];
      }, { images: await Promise.all(manifest.animations.filter(action => action.id !== 'running-right').map(async action => ({ label: action.label, data: 'data:image/png;base64,' + (await fs.readFile(path.join(output, action.frames[0]))).toString('base64') }))), size });
      await fs.writeFile(path.join(output, 'edge-qa.png'), Buffer.from(qa, 'base64')); manifest.edgeQa = 'edge-qa.png';
    }
    await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2)); await writePreview(output, manifest);
    await fs.writeFile(path.join(output, 'EXPORT-NOTES.md'), `# 完整角色动画素材\n\n这里只对原始完整角色帧做固定网格裁切、共同画布留白、经过复核的整数平移与播放选帧；右跑逐帧水平镜像左跑。没有拆开或重新拼装身体，没有逐帧缩放、形变、去背景、平滑或去噪。原始 alpha 保留。\n\n统一画布 ${size.width} × ${size.height}；全体逻辑画布四周各 ${padding}px 留白；全局统一比例 ${scale}。源 PNG 原样保存在 sources/，SHA-256 与来源路径见 manifest.json。\n\n${manifest.animations.map(action => `- ${action.label}：24个播放帧，${action.uniqueSourceFrames}个原始来源帧，${action.duplicateHoldFrames}个重复持姿播放帧；总时长${action.durationMs}ms。`).join('\n')}\n\n选帧表采用明确的1-based来源帧编号；每个输出帧的 sourceFrame、sourceIndex0、duplicatedHold 与原因都在 manifest.json。纯平移按原始来源帧索引应用，再按播放表编排。最大主体 alpha>=128 的8连通轮廓若触源格边界会拒绝导出；这项检查不替代对实际姿势和动作的视觉检查。\n\nGIF 使用跨动作共同的固定全局色板与无抖动编码，格式限制为单比特透明度；WebP保留透明与无损颜色。WebP每个单帧VP8L已与PNG用相同解码器逐像素核对，最终动画复用同一VP8L块并检查结构与浏览器加载。\n\n双击 index.html 查看PNG序列、GIF和WebP，可切换200px/400px、浅色/深色、慢放、暂停和逐帧。edge-qa.png 是不修改源图的深浅背景合成检查图。\n\n实际提示词、用户参考和姿势参考请一并查看交付者提供的 README.md 与对应文件；可在加入这些说明文件后使用导出脚本 --zip-only 重建ZIP，已有源PNG校验必须保持一致。\n`);
    if (sourceRects) {
      const notesPath = path.join(output, 'EXPORT-NOTES.md'), notes = await fs.readFile(notesPath, 'utf8');
      await fs.writeFile(notesPath, notes.replace('做固定网格裁切', '做固定网格或明确批准的完整人物原图矩形裁切').replace('最大主体 alpha>=128 的8连通轮廓若触源格边界会拒绝导出', '严格uniform模式中，最大主体 alpha>=128 的8连通轮廓触源格边界会拒绝导出；已批准完整人物矩形模式则在全原图验证主体完整包含、唯一主体、与邻居无前景重叠和原PNG外边界，并记录最终全人平移，绝不先按格线截身体再平移'));
    }
    const preview = await browser.newPage({ viewport: { width: 1380, height: 1000 }, deviceScaleFactor: 1 }); const errors = []; preview.on('pageerror', error => errors.push(error.message)); await preview.goto(pathToFileURL(path.join(output, 'index.html')).href);
    await preview.waitForFunction(() => [...document.querySelectorAll('img.sequence')].length === 3 && [...document.querySelectorAll('img.sequence')].every(image => image.complete && image.naturalWidth > 0)); await preview.screenshot({ path: path.join(output, 'preview-light.png'), fullPage: true });
    await preview.locator('#theme').click(); await preview.locator('#size').selectOption('large'); await preview.locator('#speed').selectOption('0.5'); await preview.locator('[data-id="running-left"] .pause').click(); await preview.locator('[data-id="running-left"] .next').click(); assert((await preview.locator('[data-id="running-left"] .readout').innerText()).includes('/ 24'));
    await preview.screenshot({ path: path.join(output, 'preview-dark-large.png'), fullPage: true });
    for (const format of ['gif', 'webp']) { await preview.locator('#format').selectOption(format); await preview.waitForFunction(() => [...document.querySelectorAll('img.sequence')].every(image => image.complete && image.naturalWidth > 0)); }
    assert.deepEqual(errors, []); await fs.writeFile(path.join(output, 'preview-verification.json'), JSON.stringify({ offline: true, threeActionsDecoded: true, pngGifWebpDecoded: true, themeSizeSlowFrameControls: true, errors }, null, 2));
  } finally {
    if (browser) await browser.close(); const realWork = await fs.realpath(work); assert(contains(realOutput, realWork) && path.basename(realWork).startsWith('.render-')); await fs.rm(realWork, { recursive: true, force: true });
  }
  const zip = await zipDirectory(output, path.join(output, 'animation-redraw-v1.zip')); console.log(JSON.stringify({ ok: true, directory: output, manifest: path.join(output, 'manifest.json'), preview: path.join(output, 'index.html'), zip, sourcePngUnchanged: manifest.sourcePngUnchanged }, null, 2));
}

async function writePreview(output, manifest) {
  const data = JSON.stringify(manifest.animations.map(({ id, label, frameDurationsMs, durationMs, frames, gif, webp, atlas, outputMapping }) => ({ id, label, frameDurationsMs, durationMs, frames, gif, webp, atlas, outputMapping })));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>龙娘 · 完整角色逐帧动画</title><style>*{box-sizing:border-box}html{background:#eeeaf3;color:#44394f;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}body{margin:0;padding:30px;max-width:1400px;margin:auto}h1{font-size:27px;margin:0 0 7px}p{color:#887b94}button,select,input{font:inherit}button,select{background:#fff;border:1px solid #d1c7dc;border-radius:8px;color:inherit;padding:7px 10px;cursor:pointer}a{color:#78608d}.toolbar{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:20px 0}.grid{display:grid;grid-template-columns:repeat(3,minmax(260px,1fr));gap:18px}.card{border:1px solid #d5cade;border-radius:14px;overflow:hidden;background:#faf8fd}.stage{min-height:300px;display:flex;align-items:flex-end;justify-content:center;background:#fff;overflow:auto;padding:22px 0}.sequence{display:block;width:200px;height:auto;max-width:none}.large .sequence{width:400px}.large .stage{min-height:480px}.info{padding:14px 17px}h2{font-size:18px;margin:0 0 5px}.controls{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.frame{width:100%;margin:10px 0}.readout{font-variant-numeric:tabular-nums;font-size:12px}.links{display:flex;gap:14px;flex-wrap:wrap;margin-top:13px;font-size:12px}.note{padding:12px 16px;border-radius:10px;background:#f9f4df;font-size:12px;color:#8c7b50}.dark{background:#24212b;color:#e8deef}.dark .card{background:#342d3f;border-color:#5d4c6c}.dark .stage{background:#292430}.dark p{color:#b5a6c1}.dark button,.dark select{background:#493a56;color:#e7dced;border-color:#776383}.dark a{color:#c3a9d9}.dark .note{background:#4b402b;color:#ebdbb4}@media(max-width:950px){.grid{grid-template-columns:1fr}body{padding:18px}}</style></head><body><h1>完整角色 · 三组逐帧动画</h1><p>思考 24 帧 / 2 秒 · 左跑 24 帧 / 1.8 秒 · 右跑由左跑整帧镜像。原始透明度保留；没有拆分身体或逐帧拉伸。</p><div class="toolbar"><button id="theme">深色背景</button><label>显示尺寸 <select id="size"><option value="actual">实际 200px 宽</option><option value="large">大图 400px 宽</option></select></label><label>格式 <select id="format"><option value="png">透明 PNG 逐帧播放</option><option value="webp">无损透明 WebP</option><option value="gif">GIF（固定全局色板）</option></select></label><label>PNG 速度 <select id="speed"><option value="1">原速</option><option value="0.5">0.5× 慢放</option><option value="0.25">0.25× 慢放</option></select></label><a href="animation-redraw-v1.zip">下载完整素材 ZIP</a></div><p class="note">暂停、慢放与逐帧查看使用原始 PNG 序列。GIF 按格式使用单比特透明度与固定 256 色，无抖动；WebP 保留无损颜色与透明度。帧位置沿用原始格子，统一落在共同画布；未自动移动单帧角色。</p><main class="grid">${manifest.animations.map(action => `<article class="card" data-id="${action.id}"><div class="stage"><img class="sequence" src="${action.frames[0]}" alt="${action.label}完整角色"></div><div class="info"><h2>${action.label}</h2><div class="controls"><button class="prev" aria-label="${action.label}上一帧">←</button><button class="pause">暂停</button><button class="next" aria-label="${action.label}下一帧">→</button><span class="readout">1 / 24</span></div><input class="frame" aria-label="${action.label}帧" type="range" min="1" max="24" step="1" value="1"><div class="links"><a href="${action.webp}">WebP</a><a href="${action.gif}">GIF</a><a href="${action.atlas}">6×4 图集</a><a href="${action.frames[0]}">透明 PNG</a></div></div></article>`).join('')}</main><p><a href="manifest.json">画布、精确帧时长与源文件 SHA</a> · <a href="preview-verification.json">格式与预览验证</a></p><script>const actions=${data},format=document.querySelector('#format'),speed=document.querySelector('#speed');const players=actions.map(action=>{const element=document.querySelector('[data-id="'+action.id+'"]'),image=element.querySelector('img'),slider=element.querySelector('.frame'),button=element.querySelector('.pause'),readout=element.querySelector('.readout');return{action,element,image,slider,button,readout,index:0,elapsed:0,playing:true}});function update(player){player.image.src=format.value==='png'?player.action.frames[player.index]:player.action[format.value];player.slider.value=String(player.index+1);player.readout.textContent=(player.index+1)+' / 24 · '+(player.action.durationMs/1000)+' 秒'}for(const player of players){const step=delta=>{format.value='png';for(const other of players)update(other);player.playing=false;player.button.textContent='播放';player.index=(player.index+delta+24)%24;player.elapsed=player.action.frameDurationsMs.slice(0,player.index).reduce((a,b)=>a+b,0);update(player)};player.element.querySelector('.prev').onclick=()=>step(-1);player.element.querySelector('.next').onclick=()=>step(1);player.button.onclick=()=>{player.playing=!player.playing;player.button.textContent=player.playing?'暂停':'播放'};player.slider.oninput=()=>{player.index=Number(player.slider.value)-1;step(0)}}let last=performance.now();function animate(now){const delta=Math.min(100,now-last)*Number(speed.value);last=now;for(const player of players){if(format.value!=='png'||!player.playing)continue;player.elapsed=(player.elapsed+delta)%player.action.durationMs;let time=0,index=0;while(index<23&&time+player.action.frameDurationsMs[index]<=player.elapsed)time+=player.action.frameDurationsMs[index++];if(index!==player.index){player.index=index;update(player)}}requestAnimationFrame(animate)}requestAnimationFrame(animate);format.onchange=()=>{for(const player of players)update(player)};document.querySelector('#theme').onclick=event=>{const dark=document.documentElement.classList.toggle('dark');event.target.textContent=dark?'浅色背景':'深色背景'};document.querySelector('#size').onchange=event=>document.documentElement.classList.toggle('large',event.target.value==='large');</script></body></html>`;
  const summary = manifest.animations.filter(action => action.id !== 'running-right').map(action => `${action.label}：24个播放帧，${action.uniqueSourceFrames}个原始来源帧${action.duplicateHoldFrames ? `，含${action.duplicateHoldFrames}个重复持姿播放帧` : ''}`).join('；');
  await fs.writeFile(path.join(output, 'index.html'), html.replace('原始透明度保留', summary + '。原始透明度保留').replace('<a href="manifest.json">', '<a href="edge-qa.png">深浅背景边缘检查图</a> · <a href="manifest.json">').replace("player.readout.textContent=(player.index+1)+' / 24 · '+(player.action.durationMs/1000)+' 秒'", "player.readout.textContent=(player.index+1)+' / 24 · '+(player.action.durationMs/1000)+' 秒 · 来源 '+player.action.outputMapping[player.index].sourceFrame+(player.action.outputMapping[player.index].duplicatedHold?'（重复持姿）':'')"));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
