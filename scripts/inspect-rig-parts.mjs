import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { traceAlphaOutline } from './alpha-outline.mjs';

// Pixel reads and geometric metadata only. No PNG is sliced or re-encoded.
const options = { directory: 'assets/skins/silver-dragon-rig', output: 'docs/imagegen/v040/parts-geometry.json', files: [], strict: false };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--strict') options.strict = true;
  else if (['--directory', '--output', '--config', '--chrome'].includes(args[i])) options[args[i].slice(2)] = args[++i];
  else if (args[i].startsWith('--')) throw new Error(`Unknown option ${args[i]}`);
  else options.files.push(args[i]);
}
const directory = path.resolve(options.directory), config = options.config ? JSON.parse(await fs.readFile(options.config, 'utf8')) : {};
const filenames = options.files.length ? options.files : (await fs.readdir(directory)).filter(file => /^parts-(front|left|right)-v\d+\.png$/i.test(file)).sort();
if (!filenames.length) throw new Error('No fixed rig-part atlases found.');
const partNames = ['hair-back', 'head', 'body', 'skirt', 'arm-left', 'arm-right', 'leg-left', 'leg-right', 'calf-left', 'calf-right', 'wing-left', 'wing-right', 'tail', 'eyes', 'mouth', 'hair-front'];
const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Read-only rig-part inspection</title>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: options.chrome ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const report = { version: 1, generatedAt: new Date().toISOString(), mode: 'read-only alpha geometry; original PNG bytes remain unchanged', columns: 4, rows: 4, partNames, files: {} };
try {
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({ content: `globalThis.traceAlphaOutline = ${traceAlphaOutline.toString()};` });
  for (const file of filenames) {
    const bytes = await fs.readFile(path.join(directory, file)), rules = config.files?.[file] ?? config[file] ?? {};
    const result = await page.evaluate(async ({ url, rules, partNames }) => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height), width = canvas.width, height = canvas.height;
      const labels = new Int32Array(width * height), groups = [];
      for (let pixel = 0; pixel < labels.length; pixel++) {
        if (labels[pixel] || data[pixel * 4 + 3] < 96) continue;
        const id = groups.length + 1, queue = [pixel]; labels[pixel] = id;
        let head = 0, x0 = width, y0 = height, x1 = -1, y1 = -1, sumX = 0, sumY = 0, saturatedNoise = 0;
        while (head < queue.length) {
          const next = queue[head++], x = next % width, y = Math.floor(next / width), offset = next * 4;
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); sumX += x; sumY += y;
          const r = data[offset], g = data[offset + 1], b = data[offset + 2];
          if (g < 90 && (r > 180 && b > 150 && r > g * 1.7 && b > g * 1.7 || r > 200 && r > b * 1.8 || b > 200 && b > r * 1.8)) saturatedNoise++;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const neighbor = ny * width + nx;
            if (labels[neighbor] || data[neighbor * 4 + 3] < 96) continue;
            labels[neighbor] = id; queue.push(neighbor);
          }
        }
        groups.push({ id, pixels: queue.length, bounds: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }, center: { x: sumX / queue.length, y: sumY / queue.length }, saturatedNoiseFraction: saturatedNoise / queue.length });
      }
      const cells = Array.from({ length: 16 }, (_, index) => rules.slots?.[index] ?? { x: index % 4 * width / 4, y: Math.floor(index / 4) * height / 4, width: width / 4, height: height / 4 });
      const candidates = cells.map(cell => groups.filter(group => group.center.x >= cell.x && group.center.x < cell.x + cell.width && group.center.y >= cell.y && group.center.y < cell.y + cell.height).sort((a, b) => b.pixels - a.pixels));
      const selections = [], errors = [], warnings = [];
      for (let index = 0; index < 16; index++) {
        const rule = rules.parts?.[index] ?? rules.parts?.[partNames[index]] ?? {};
        const viable = candidates[index].filter(group => group.pixels >= (rule.minPixels ?? 8) && group.saturatedNoiseFraction < .35);
        const paired = index === 13 || index === 15;
        let selected;
        if (rule.componentIds) selected = rule.componentIds.map(id => groups.find(group => group.id === id)).filter(Boolean);
        else if (paired && viable[0]) selected = viable.filter(group => group.bounds.height >= Math.max(3, viable[0].bounds.height * .3) && group.pixels >= Math.max(8, viable[0].pixels * .04)).slice(0, 2);
        else selected = viable.slice(0, 1);
        selections.push(selected);
        if (!selected.length) errors.push({ kind: 'missing-part', part: index, role: partNames[index] });
        if (paired && selected.length < 2) errors.push({ kind: 'missing-paired-component', part: index, role: partNames[index], selected: selected.length });
        if (selected.some(group => group.bounds.width > width / 4 * 1.8 || group.bounds.height > height / 4 * 1.8)) errors.push({ kind: 'possible-merged-parts', part: index });
      }
      // Every unselected strong component is explicitly foreign noise. The
      // two-pixel outline margin must not admit its white/magenta islands.
      const owner = new Map(groups.map(group => [group.id, -1]));
      for (let index = 0; index < selections.length; index++) for (const group of selections[index]) {
        if (owner.get(group.id) !== -1) errors.push({ kind: 'component-selected-twice', part: index, component: group.id });
        owner.set(group.id, index);
      }
      const eyeTop = selections[13].length ? Math.min(...selections[13].map(group => group.bounds.y)) : 0;
      const eyeHeight = Math.max(1, ...selections[13].map(group => group.bounds.height));
      const eyebrows = candidates[13].filter(group => owner.get(group.id) === -1 && group.saturatedNoiseFraction < .35 && group.pixels >= 20 && group.bounds.height < eyeHeight * .35 && group.bounds.width > eyeHeight * .35 && group.bounds.y + group.bounds.height <= eyeTop && eyeTop - group.bounds.y - group.bounds.height < eyeHeight * .7).slice(0, 2);
      for (const group of eyebrows) owner.set(group.id, 16);
      const parts = [];
      for (let index = 0; index < 16; index++) {
        const selected = selections[index];
        if (!selected.length) { parts.push({ index, role: partNames[index], sourceRegion: null, components: [], candidates: candidates[index].slice(0, 8) }); continue; }
        const x0 = Math.min(...selected.map(group => group.bounds.x)), y0 = Math.min(...selected.map(group => group.bounds.y)), x1 = Math.max(...selected.map(group => group.bounds.x + group.bounds.width)), y1 = Math.max(...selected.map(group => group.bounds.y + group.bounds.height));
        const contentBounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        const edgeTouches = ['left', 'top', 'right', 'bottom'].filter(side => side === 'left' ? x0 === 0 : side === 'top' ? y0 === 0 : side === 'right' ? x1 === width : y1 === height);
        if (edgeTouches.length) errors.push({ kind: 'part-on-image-edge', part: index, edges: edgeTouches });
        const region = { x: Math.max(0, x0 - 3), y: Math.max(0, y0 - 3), width: Math.min(width, x1 + 3) - Math.max(0, x0 - 3), height: Math.min(height, y1 + 3) - Math.max(0, y0 - 3) };
        const traced = globalThis.traceAlphaOutline({ region, figureIndex: index, sourceWidth: width, labels, owner });
        region.outline = traced.outline;
        if (traced.validation.ownCoverage < .999 || traced.validation.foreignPixelsKept !== 0 || region.outline.length < 3) errors.push({ kind: 'outline-validation-failed', part: index, ...traced.validation });
        if (region.outline.length > 2048) errors.push({ kind: 'outline-too-complex', part: index, points: region.outline.length });
        if (traced.validation.foreignPixels > 0) warnings.push({ kind: 'runtime-outline-excludes-noise', part: index, pixels: traced.validation.foreignPixels });
        const componentPixels = selected.reduce((sum, group) => sum + group.pixels, 0);
        if (index === 14 && componentPixels < 100) warnings.push({ kind: 'tiny-mouth-preserved', part: index, pixels: componentPixels });
        parts.push({ index, role: partNames[index], contentBounds, sourceRegion: region, componentPixels, componentCount: selected.length, components: selected, candidates: candidates[index].slice(0, 8), edgeTouches, outlineValidation: traced.validation });
      }
      const retained = groups.filter(group => owner.get(group.id) !== -1), discarded = groups.filter(group => owner.get(group.id) === -1);
      const auxiliaryParts = [];
      if (eyebrows.length) {
        const x0 = Math.min(...eyebrows.map(group => group.bounds.x)), y0 = Math.min(...eyebrows.map(group => group.bounds.y)), x1 = Math.max(...eyebrows.map(group => group.bounds.x + group.bounds.width)), y1 = Math.max(...eyebrows.map(group => group.bounds.y + group.bounds.height));
        const region = { x: Math.max(0, x0 - 3), y: Math.max(0, y0 - 3), width: Math.min(width, x1 + 3) - Math.max(0, x0 - 3), height: Math.min(height, y1 + 3) - Math.max(0, y0 - 3) };
        const traced = globalThis.traceAlphaOutline({ region, figureIndex: 16, sourceWidth: width, labels, owner }); region.outline = traced.outline;
        auxiliaryParts.push({ id: 'eyebrows', role: 'static', parent: 'head', sourceRegion: region, componentCount: eyebrows.length, components: eyebrows, outlineValidation: traced.validation, note: 'Keep these fixed on the head; the eyes layer alone blinks.' });
      }
      let transparent = 0; for (let offset = 3; offset < data.length; offset += 4) if (data[offset] === 0) transparent++;
      return { sourceWidth: width, sourceHeight: height, transparentFraction: transparent / (width * height), parts, regions: parts.map(part => part.sourceRegion), auxiliaryParts, retainedComponents: retained.length, discardedNoiseComponents: discarded.length, discardedNoisePixels: discarded.reduce((sum, group) => sum + group.pixels, 0), warnings, errors };
    }, { url: 'data:image/png;base64,' + bytes.toString('base64'), rules, partNames });
    report.files[file] = { facing: file.match(/^parts-(front|left|right)-/i)?.[1], sha256: createHash('sha256').update(bytes).digest('hex'), sourceBytes: bytes.length, ...result };
    console.log(`${file}: ${result.sourceWidth}x${result.sourceHeight}, parts=${result.parts.filter(part => part.sourceRegion).length}/16, eyes=${result.parts[13].componentCount ?? 0}, front-hair=${result.parts[15].componentCount ?? 0}, discarded-noise=${result.discardedNoiseComponents}, errors=${result.errors.length}`);
  }
  await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true }); await fs.writeFile(options.output, JSON.stringify(report, null, 2));
  if (options.strict && Object.values(report.files).some(file => file.errors.length)) process.exitCode = 1;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
