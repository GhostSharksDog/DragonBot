import fs from 'node:fs/promises';
import path from 'node:path';

// Metadata only. Selection: [{state:"idle",sources:[{file:"idle-24-v4.png",indices:[0,1,...]}]}].
// Extra figures are allowed, but the first 24 must be distinct and reviewed.
const args = process.argv.slice(2), options = { geometry: 'docs/imagegen/atlas-geometry-24.json', output: 'assets/skins/silver-dragon/skin.json', sequenceReport: 'docs/imagegen/atlas-sequence-review-24.json', reviewedNearDuplicates: false, dryRun: false };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--reviewed-near-duplicates') options.reviewedNearDuplicates = true;
  else if (args[i] === '--dry-run') options.dryRun = true;
  else if (args[i] === '--sequence-report') options.sequenceReport = args[++i];
  else if (['--geometry', '--output', '--selection'].includes(args[i])) options[args[i].slice(2)] = args[++i];
  else throw new Error(`Unknown option ${args[i]}`);
}
const geometry = JSON.parse(await fs.readFile(options.geometry, 'utf8'));
if (geometry.version < 3) throw new Error('Re-run inspect-atlases-24.mjs to generate validated outline metadata before building.');
const selectionData = options.selection ? JSON.parse(await fs.readFile(options.selection, 'utf8')) : [];
const selections = Array.isArray(selectionData) ? selectionData : selectionData.animations ?? [selectionData];
const states = ['idle', 'speaking', 'thinking', 'awaiting-input', 'awaiting-approval', 'success', 'error', 'idle-back', 'walking-right', 'running-right', 'walking-left', 'running-left'];
const animations = {}, failures = [];
const sequenceReview = { version: 1, generatedAt: new Date().toISOString(), description: 'Differences use normalized premultiplied figure RGBA after outline clipping. Ordering suggestions require visual gait/expression review.', states: {} };
function differenceMatrix(samples) {
  return samples.map(first => samples.map(second => {
    let color = 0, silhouette = 0;
    for (let i = 0; i < first.length; i++) { const delta = Math.abs(first[i] - second[i]) / 255; if (i % 4 === 3) silhouette += delta; else color += delta; }
    return .65 * color / (first.length / 4 * 3) + .35 * silhouette / (first.length / 4);
  }));
}
function sequenceStats(order, matrix, loop = true) {
  const differences = order.slice(1).map((index, i) => matrix[order[i]][index]);
  const seam = loop ? matrix[order.at(-1)][order[0]] : null;
  if (loop) differences.push(seam);
  return { mean: differences.reduce((sum, value) => sum + value, 0) / differences.length, max: Math.max(...differences), seam };
}
function improveLoop(initial, matrix) {
  const order = [...initial], length = order.length;
  for (let pass = 0; pass < 100; pass++) {
    let best = 0, pair = null;
    for (let first = 1; first < length - 1; first++) for (let last = first + 1; last < length; last++) {
      const before = order[first - 1], a = order[first], b = order[last], after = order[(last + 1) % length];
      const improvement = matrix[before][a] + matrix[b][after] - matrix[before][b] - matrix[a][after];
      if (improvement > best + 1e-10) { best = improvement; pair = [first, last]; }
    }
    if (!pair) break;
    order.splice(pair[0], pair[1] - pair[0] + 1, ...order.slice(pair[0], pair[1] + 1).reverse());
  }
  return order;
}
function smoothLoop(matrix) {
  const original = matrix.map((_, index) => index), nearest = [0], remaining = new Set(original.slice(1));
  while (remaining.size) {
    const next = [...remaining].sort((a, b) => matrix[nearest.at(-1)][a] - matrix[nearest.at(-1)][b] || a - b)[0];
    nearest.push(next); remaining.delete(next);
  }
  return [original, improveLoop(original, matrix), improveLoop(nearest, matrix)].sort((a, b) => sequenceStats(a, matrix).mean - sequenceStats(b, matrix).mean)[0];
}
for (const state of states) {
  const explicit = selections.find(selection => selection.state === state);
  const candidates = Object.entries(geometry.files).filter(([, data]) => data.state === state).sort(([a], [b]) => Number(b.match(/-v(\d+)\.png$/)?.[1] ?? 0) - Number(a.match(/-v(\d+)\.png$/)?.[1] ?? 0));
  const sources = explicit?.sources ?? (candidates[0] ? [{ file: candidates[0][0], indices: candidates[0][1].frames.map(frame => frame.index) }] : []);
  const selected = sources.flatMap(source => (source.indices ?? []).map(index => ({ file: source.file, index, data: geometry.files[source.file], frame: geometry.files[source.file]?.frames[index] })));
  if (selected.length < 24) { failures.push(`${state}: ${selected.length} source figures, requires at least 24`); continue; }
  let frames = selected.slice(0, 24);
  if (frames.some(item => !Number.isInteger(item.index) || item.index < 0 || !item.frame || !item.data)) { failures.push(`${state}: invalid source file/frame selection`); continue; }
  const sourceWidth = frames[0].data.sourceWidth, sourceHeight = frames[0].data.sourceHeight;
  if (new Set(frames.map(item => item.frame.exactHash)).size !== 24) failures.push(`${state}: repeated source image/pose; duplicates cannot count toward 24 frames`);
  if (frames.some(item => !Array.isArray(item.frame.region.outline) || item.frame.region.outline.length < 3 || item.frame.outlineValidation?.foreignPixelsKept !== 0 || item.frame.outlineValidation?.ownCoverage < .999)) failures.push(`${state}: every selected frame requires a validated body outline`);
  for (const item of frames) {
    const errors = item.data.errors.filter(error => error.frame === item.index || error.frame === undefined && error.kind !== 'figure-count-mismatch');
    if (errors.length) failures.push(`${state}: ${item.file}[${item.index}]: ${errors.map(error => error.kind).join(', ')}`);
  }
  const samples = frames.map(item => Buffer.from(item.frame.comparisonSample, 'base64')), nearPairs = [];
  for (let a = 0; a < frames.length; a++) for (let b = a + 1; b < frames.length; b++) {
    let sum = 0, alphaSum = 0;
    for (let i = 0; i < samples[a].length; i++) { const delta = Math.abs(samples[a][i] - samples[b][i]) / 255; sum += delta; if (i % 4 === 3) alphaSum += delta; }
    if (sum / samples[a].length <= .02 && alphaSum / (samples[a].length / 4) <= .035) nearPairs.push([a, b]);
  }
  if (nearPairs.length && !options.reviewedNearDuplicates) failures.push(`${state}: near-duplicate candidate pairs ${JSON.stringify(nearPairs)} need visual review, then --reviewed-near-duplicates`);
  const matrix = differenceMatrix(samples), originalOrder = frames.map((_, index) => index), suggestedOrder = state === 'success' ? originalOrder : smoothLoop(matrix);
  const requested = explicit?.sequence ?? 'original';
  if (!['original', 'smooth-loop'].includes(requested)) failures.push(`${state}: sequence must be original or smooth-loop`);
  const appliedOrder = requested === 'smooth-loop' && state !== 'success' ? suggestedOrder : originalOrder;
  const sourceKey = item => `${item.file}[${item.index}]`;
  sequenceReview.states[state] = { requested, applied: state === 'success' ? 'original (non-looping success is locked)' : requested, before: sequenceStats(originalOrder, matrix, state !== 'success'), suggested: sequenceStats(suggestedOrder, matrix, state !== 'success'), appliedMetrics: sequenceStats(appliedOrder, matrix, state !== 'success'), originalSources: frames.map(sourceKey), suggestedSources: suggestedOrder.map(index => sourceKey(frames[index])), suggestedOrder, appliedOrder };
  frames = appliedOrder.map(index => frames[index]);
  const files = [...new Set(frames.map(item => item.file))];
  animations[state] = { frames: files, fps: 24, loop: state !== 'success', atlas: { columns: 6, rows: 4, sourceWidth, sourceHeight, regions: frames.map(item => item.frame.region), indices: Array.from({ length: 24 }, (_, i) => i), ...(files.length > 1 ? { frameSources: frames.map(item => files.indexOf(item.file)), sourceSizes: files.map(file => ({ width: geometry.files[file].sourceWidth, height: geometry.files[file].sourceHeight })) } : {}) } };
}
const manifest = { name: '银白龙娘', width: 512, height: 512, anchor: { x: 256, y: 512 }, animations };
const prettyManifest = JSON.stringify(manifest, null, 2);
const serializedManifest = Buffer.byteLength(prettyManifest) <= 1024 * 1024 ? prettyManifest : JSON.stringify(manifest);
sequenceReview.manifestByteLength = Buffer.byteLength(serializedManifest);
sequenceReview.manifestFormatting = serializedManifest === prettyManifest ? 'pretty' : 'compact';
await fs.mkdir(path.dirname(path.resolve(options.sequenceReport)), { recursive: true });
await fs.writeFile(options.sequenceReport, JSON.stringify(sequenceReview, null, 2));
if (failures.length) throw new Error(`24-frame manifest was not written:\n${failures.join('\n')}`);
if (options.dryRun) { console.log(`Validated 12 states and 288 distinct source frames; ${sequenceReview.manifestByteLength} metadata bytes; skin.json was not written. Sequence review: ${options.sequenceReport}`); process.exit(0); }
await fs.writeFile(options.output, serializedManifest);
console.log(`Wrote ${options.output}: 12 states, 24 fps, 288 distinct source frames. Semantic pose and sequence quality require visual review.`);
