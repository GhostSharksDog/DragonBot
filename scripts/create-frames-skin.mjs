import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const idleFile = argument('--idle'), idleDirectory = argument('--idle-directory'), rectanglesFile = argument('--idle-source-rects');
if (Boolean(idleFile) === Boolean(idleDirectory)) throw new Error('Provide --idle <approved transparent PNG> or --idle-directory <approved PNG frames>. The appearance reference must be transparently extracted with ImageGen; opaque white-background references are rejected.');
const thinkingDirectory = path.resolve(argument('--thinking-directory') ?? path.join(project, 'release/animation-redraw-v1/thinking'));
const output = path.join(project, 'assets/skins/silver-dragon-frames');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(project, file).replaceAll('\\', '/');
const sources = [], jobs = [];
if (idleDirectory) {
  const directory = path.resolve(idleDirectory), files = (await fs.readdir(directory)).filter(file => /^frame-\d+\.png$/.test(file)).sort();
  assert(files.length > 0 && files.length <= 120, 'Approved idle directory must contain 1–120 frame PNGs.');
  for (const file of files) { const full = path.join(directory, file), bytes = await fs.readFile(full); sources.push({ file: relative(full), sha256: sha(bytes), encoded: bytes.toString('base64') }); jobs.push({ state: 'idle', source: sources.length - 1 }); }
} else {
  const full = path.resolve(idleFile), bytes = await fs.readFile(full); sources.push({ file: relative(full), sha256: sha(bytes), encoded: bytes.toString('base64') });
  if (rectanglesFile) {
    const config = JSON.parse(await fs.readFile(rectanglesFile, 'utf8')), selection = config.sources?.idle;
    assert.equal(selection?.sourceSha256, sources[0].sha256, 'Idle review must match the actual PNG.');
    assert(Array.isArray(selection.frames) && selection.frames.length >= 1 && selection.frames.length <= 120);
    const globalScale=selection.globalScale??1;assert(Number.isFinite(globalScale)&&globalScale>0&&globalScale<=1,'Idle requires one positive global scale no greater than one.');
    for (const frame of selection.frames) jobs.push({ state: 'idle', source: 0, sourceRect: frame.sourceRect, destination: frame.destination, globalScale });
  } else jobs.push({ state: 'idle', source: 0 });
}
const sourceIdleCount = jobs.length;
for (let index = 1; index <= 24; index++) {
  const file = path.join(thinkingDirectory, `frame-${String(index).padStart(2, '0')}.png`), bytes = await fs.readFile(file);
  assert.equal(bytes.readUInt32BE(16), 272); assert.equal(bytes.readUInt32BE(20), 272);
  sources.push({ file: relative(file), sha256: sha(bytes), encoded: bytes.toString('base64') }); jobs.push({ state: 'thinking', source: sources.length - 1, exactCopy: true });
}
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
let rendered;
try {
  const page = await browser.newPage(); await page.setContent('<canvas></canvas>');
  rendered = await page.evaluate(async ({ sources, jobs, sourceIdleCount }) => {
    const images = [], sourceStats = [], canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    for (const source of sources) {
      const image = new Image(); image.src = 'data:image/png;base64,' + source.encoded; await image.decode(); images.push(image);
      canvas.width = image.width; canvas.height = image.height; ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, image.width, image.height).data; let zero = 0, min = 255, max = 0;
      for (let pixel = 3; pixel < data.length; pixel += 4) { const alpha = data[pixel]; if (!alpha) zero++; min = Math.min(min, alpha); max = Math.max(max, alpha); }
      if (!zero || max < 128) throw new Error('An approved source lacks genuine transparent background or a visible character. Never threshold white clothing to invent alpha.');
      sourceStats.push({ width: image.width, height: image.height, zeroAlphaPixels: zero, minAlpha: min, maxAlpha: max });
    }
    const idleJobs = jobs.slice(0, sourceIdleCount), globalScale = Math.min(1, ...idleJobs.map(job => job.sourceRect ? job.globalScale : Math.min(256 / images[job.source].width, 256 / images[job.source].height)));
    const results = [];
    for (const job of jobs) {
      const image = images[job.source]; canvas.width = 272; canvas.height = 272;
      let transform;
      if (job.exactCopy) { ctx.drawImage(image, 0, 0); transform = { scale: 1, x: 0, y: 0 }; }
      else if (job.sourceRect) {
        const region = job.sourceRect, destination = job.destination;
        if (![region.x, region.y, region.width, region.height, destination.x, destination.y].every(Number.isInteger) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > image.width || region.y + region.height > image.height || destination.x < 8 || destination.y < 8 || destination.x + region.width*globalScale > 264 || destination.y + region.height*globalScale > 264) throw new Error('Reviewed whole-character rectangle must fit the 272px canvas with 8px padding.');
        ctx.drawImage(image, region.x, region.y, region.width, region.height, destination.x, destination.y, region.width*globalScale, region.height*globalScale); transform = { scale: globalScale, x: destination.x, y: destination.y, sourceRect: region };
      } else {
        const x = Math.round((272 - image.width * globalScale) / 2), y = Math.round(264 - image.height * globalScale);
        ctx.drawImage(image, x, y, image.width * globalScale, image.height * globalScale); transform = { scale: globalScale, x, y };
      }
      const data = ctx.getImageData(0, 0, 272, 272).data; let zero = 0, partial = 0, minX = 272, minY = 272, maxX = -1, maxY = -1;
      for (let pixel = 0; pixel < data.length; pixel += 4) { const alpha = data[pixel + 3]; if (!alpha) zero++; else if (alpha < 255) partial++; if (alpha >= 128) { const x = pixel / 4 % 272, y = Math.floor(pixel / 4 / 272); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); } }
      if (!zero || maxX < minX) throw new Error('A selected frame is empty or opaque.');
      results.push({ png: canvas.toDataURL('image/png').split(',')[1], alpha: { zero, partial, threshold: 128, bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } }, transform });
    }
    return { results, sourceStats, globalScale };
  }, { sources, jobs, sourceIdleCount });
} finally { await browser.close(); }
await fs.mkdir(output, { recursive: true });
const manifest = { name: '银白龙娘 · 逐帧', width: 272, height: 272, anchor: { x: 136, y: 264 }, animations: {} };
const provenance = { version: 1, kind: 'complete-character frames', appearanceReference: 'assets/animation-redraw-v1/references/appearance-master.png', appearanceReferenceSha256: sha(await fs.readFile(path.join(project, 'assets/animation-redraw-v1/references/appearance-master.png'))), policy: 'Preserve approved thinking bytes; idle uses only complete-character rectangles, one global uniform scale if needed, and whole-person translation. No body parts, white threshold cleanup, or new drawing.', sources: sources.map(({ encoded, ...source }, index) => ({ ...source, alpha: rendered.sourceStats[index] })), animations: {}, frames: [] };
for (const state of ['idle', 'thinking']) {
  await fs.mkdir(path.join(output, state), { recursive: true }); const selected = jobs.map((job, index) => ({ job, index })).filter(item => item.job.state === state), paths = [];
  for (let index = 0; index < selected.length; index++) {
    const { job, index: resultIndex } = selected[index], renderedFrame = rendered.results[resultIndex], file = `${state}/frame-${String(index + 1).padStart(2, '0')}.png`;
    const bytes = job.exactCopy ? Buffer.from(sources[job.source].encoded, 'base64') : Buffer.from(renderedFrame.png, 'base64');
    await fs.writeFile(path.join(output, file), bytes); paths.push(file);
    provenance.frames.push({ file, sha256: sha(bytes), source: job.source, width: 272, height: 272, exactSourceCopy: Boolean(job.exactCopy), ...renderedFrame });
    delete provenance.frames.at(-1).png;
  }
  assert.equal(paths.length,24,'This bundled skin uses exactly 24 output frames for each action.');
  const atlas=`${state}-atlas.png`;
  await new Promise((resolve,reject)=>{const child=spawn('E:/Apps/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe',['-v','error','-y','-framerate','12','-start_number','1','-i',path.join(output,state,'frame-%02d.png'),'-vf','tile=6x4','-frames:v','1','-pix_fmt','rgba','-update','1',path.join(output,atlas)],{windowsHide:true,stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',bytes=>error+=bytes);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(error)));});
  const atlasBytes=await fs.readFile(path.join(output,atlas));
  assert.equal(atlasBytes.readUInt32BE(16),1632);assert.equal(atlasBytes.readUInt32BE(20),1088);
  const fps=12;manifest.animations[state]={frames:[atlas],fps,loop:true,atlas:{columns:6,rows:4,indices:Array.from({length:24},(_,index)=>index)}};
  provenance.animations[state] = { frames: paths.length, uniqueSourceImages: new Set(provenance.frames.filter(frame => frame.file.startsWith(state + '/')).map(frame => frame.sha256)).size, durationMs: paths.length / fps * 1000,atlas:{file:atlas,sha256:sha(atlasBytes),width:1632,height:1088} };
}
await fs.writeFile(path.join(output, 'skin.json'), JSON.stringify(manifest, null, 2) + '\n');
await fs.writeFile(path.join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
for (const source of sources) assert.equal(sha(await fs.readFile(path.resolve(project, source.file))), source.sha256, 'A preserved source changed.');
console.log(JSON.stringify({ skin: relative(path.join(output, 'skin.json')), animations: provenance.animations, thinkingCopiedExactly: true, idleGlobalScale: rendered.globalScale }));
