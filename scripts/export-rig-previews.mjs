import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => { const index = process.argv.indexOf(name); if (index === -1) return null; const value = process.argv[index + 1]; if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`); return value; };
const manifestPath = path.resolve(argument('--manifest') ?? path.join(project, 'assets/skins/silver-dragon-rig/skin.json'));
const output = path.resolve(argument('--out') ?? path.join(project, 'release/previews-0.4.0'));
const ffmpeg = argument('--ffmpeg') ?? 'E:/Apps/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe';
const chrome = argument('--chrome') ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const width = Number(argument('--width') ?? 400), fps = 25;
assert(Number.isInteger(width) && width >= 100 && width <= 1200, '--width must be 100–1200 pixels.');
const contains = (base, target) => { const relative = path.relative(base, target); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); };
assert(contains(path.join(project, 'release'), output) || contains(path.join(project, '.local'), output), 'Preview outputs must stay inside project release/ or .local/, away from drawing sources.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const states = [
  ['idle', '待机', 'idle', 'idle', 'right', 5400, true],
  ['running-left', '向左慢跑', 'idle', 'running', 'left', 7200, true],
  ['running-right', '向右慢跑', 'idle', 'running', 'right', 7200, true],
  ['speaking', '说话', 'speaking', 'idle', 'right', 5400, true],
  ['thinking', '思考', 'thinking', 'idle', 'right', 5400, true],
  ['awaiting-input', '等待回答', 'awaiting-input', 'idle', 'right', 5400, true],
  ['awaiting-approval', '等待批准', 'awaiting-approval', 'idle', 'right', 5400, true],
  ['success', '完成', 'success', 'idle', 'right', 3000, false],
  ['error', '出错', 'error', 'idle', 'right', 5400, true],
].map(([id, label, activity, motion, direction, durationMs, loop]) => ({ id, label, control: { activity, motion, direction }, durationMs, loop, frames: durationMs / 1000 * fps }));

function gifInfo(bytes) {
  assert(['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)), 'Invalid GIF output.');
  const global = Boolean(bytes[10] & 128), paletteLength = global ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0;
  let index = 13 + paletteLength, images = 0, localPalettes = 0; const delays = [], redundantTables = [];
  const subblocks = () => { while (index < bytes.length) { const size = bytes[index++]; if (!size) return; index += size; } throw new Error('Truncated GIF subblocks.'); };
  while (index < bytes.length) {
    const marker = bytes[index++];
    if (marker === 0x3b) break;
    if (marker === 0x21) { const label = bytes[index++]; if (label === 0xf9) delays.push(bytes.readUInt16LE(index + 2)); subblocks(); continue; }
    assert.equal(marker, 0x2c, 'Invalid GIF image block.');
    const packedAt = index + 8, packed = bytes[packedAt]; index += 9;
    if (packed & 128) {
      localPalettes++; const tableLength = 3 * 2 ** ((packed & 7) + 1);
      if (tableLength === paletteLength && bytes.subarray(index, index + tableLength).equals(bytes.subarray(13, 13 + paletteLength))) redundantTables.push({ packedAt, from: index, to: index + tableLength });
      index += tableLength;
    }
    index++; subblocks(); images++;
  }
  return { images, localPalettes, globalPalette: global, paletteSha256: sha(bytes.subarray(13, 13 + paletteLength)), delays, redundantTables };
}
function fixedGlobalGif(bytes) {
  const info = gifInfo(bytes); assert.equal(info.localPalettes, info.redundantTables.length, 'GIF encoder changed palette indices across frames.');
  let cursor = 0; const chunks = [];
  // FFmpeg writes a redundant first-frame table even when it equals the global
  // table byte-for-byte. Removing it does not alter pixel indices or LZW data.
  for (const table of info.redundantTables) { chunks.push(bytes.subarray(cursor, table.packedAt), Buffer.from([bytes[table.packedAt] & 127]), bytes.subarray(table.packedAt + 1, table.from)); cursor = table.to; }
  chunks.push(bytes.subarray(cursor)); return Buffer.concat(chunks);
}
async function encode(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', data => { error = (error + data.toString()).slice(-4000); });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg failed (${code}): ${error}`)));
  });
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const style = `*{box-sizing:border-box}body{margin:0;background:#eeeaf3;color:#322b40;font:15px/1.5 system-ui,"Microsoft YaHei",sans-serif}header{max-width:1220px;margin:40px auto 20px;padding:0 24px}h1{font-size:28px;margin:0 0 10px}p{color:#70677b}button,a,select,input{font:inherit}button,select,a.control{border:1px solid #c9bfda;background:#fff;border-radius:10px;padding:8px 14px;color:inherit;cursor:pointer}a{color:#665380}.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.grid{max-width:1220px;margin:24px auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px;padding:0 24px 36px}.card{background:#fff;border:1px solid #d5cce0;border-radius:16px;overflow:hidden}.card h2{font-size:18px;margin:14px 18px 0}.card p{margin:5px 18px 14px;font-size:13px}.stage{background-color:#f8f7fb;background-image:linear-gradient(45deg,#ece8f1 25%,transparent 25%),linear-gradient(-45deg,#ece8f1 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ece8f1 75%),linear-gradient(-45deg,transparent 75%,#ece8f1 75%);background-size:24px 24px;background-position:0 0,0 12px,12px -12px,-12px 0;display:flex;align-items:flex-end;justify-content:center;min-height:340px;overflow:hidden}.stage img,.stage canvas{display:block;max-width:100%;height:auto}.links{display:flex;gap:18px;margin:0 18px 18px}.note{background:#fbf9e9;border-radius:12px;padding:12px 16px}.interactive{max-width:820px;padding:24px;margin:auto}.interactive .stage{margin:20px 0;border-radius:16px}label{display:flex;align-items:center;gap:8px}.readout{font-variant-numeric:tabular-nums}`;

async function main() {
  let raw;
  try { raw = await fs.readFile(manifestPath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') throw new Error(`Rig manifest is not ready: ${manifestPath}. Wait for the assembled fixed-PNG rig before exporting.`); throw error; }
  const manifest = JSON.parse(raw); assert(manifest.rig?.version === 1, 'The selected manifest must contain a v1 rig.');
  const skinRoot = await fs.realpath(path.dirname(manifestPath));
  assert(!contains(skinRoot, output) && !contains(output, skinRoot), 'The output directory must not overlap the fixed-PNG source directory.');
  const files = [...new Set(Object.values(manifest.rig.views).flatMap(view => view.layers.map(layer => layer.file)))];
  const sources = new Map(), hashes = {};
  for (const file of files) {
    assert(typeof file === 'string' && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..') && /\.png$/i.test(file), 'Only fixed local PNG rig textures are allowed.');
    const source = await fs.realpath(path.join(skinRoot, file)); assert(contains(skinRoot, source), 'Source texture escapes its skin directory.');
    sources.set(file.replaceAll('\\', '/'), source); hashes[file.replaceAll('\\', '/')] = sha(await fs.readFile(source));
  }
  const bundle = await build({ stdin: { contents: `import{sampleRigPose,rigFiles}from ${JSON.stringify(path.join(project, 'src/shared/rig.ts'))};import{drawRigPose}from ${JSON.stringify(path.join(project, 'src/shared/render-rig.ts'))};
let manifest,textures,canvas,ctx,view;export async function initialize(data,base,width){manifest=data;canvas=document.querySelector('canvas');canvas.width=width;canvas.height=Math.round(width*manifest.height/manifest.width);ctx=canvas.getContext('2d',{alpha:true});textures=new Map;await Promise.all(rigFiles(manifest.rig).map(async file=>{const image=new Image;image.src=new URL(file,base).href;await image.decode();textures.set(file,image)}));view={scale:width/manifest.width,x:0,y:0};canvas.dataset.ready='true';return{width:canvas.width,height:canvas.height}}export function render(control,time,loopDurationMs,capture=true){ctx.clearRect(0,0,canvas.width,canvas.height);const playback={control,startedAt:0};const pose=sampleRigPose(manifest.rig,playback,time,loopDurationMs?{loopDurationMs}:undefined);drawRigPose(ctx,pose,textures,view);canvas.dataset.motion=control.motion;canvas.dataset.direction=control.direction;canvas.dataset.time=String(time);return capture?canvas.toDataURL('image/png').split(',')[1]:undefined}export function seam(control,duration){const playback={control,startedAt:0},a=sampleRigPose(manifest.rig,playback,0,{loopDurationMs:duration}),b=sampleRigPose(manifest.rig,playback,duration,{loopDurationMs:duration});return Math.max(0,...a.layers.flatMap((layer,index)=>[...layer.matrix.map((value,part)=>Math.abs(value-b.layers[index].matrix[part])),Math.abs(layer.opacity-b.layers[index].opacity)]))}export function live(control,time){return render(control,time,undefined,false)};`, resolveDir: project, sourcefile: 'rig-preview-runtime.ts', loader: 'ts' }, bundle: true, platform: 'browser', format: 'iife', globalName: 'RigPreview', write: false, target: 'chrome120' });
  const runtime = bundle.outputFiles[0].text;
  await fs.mkdir(output, { recursive: true });
  const realOutput = await fs.realpath(output); assert(!contains(skinRoot, realOutput) && !contains(realOutput, skinRoot), 'The output directory must not link into the fixed-PNG sources.');
  const frameRoot = path.join(output, '.render-' + randomUUID()); await fs.mkdir(frameRoot);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><meta charset="utf-8"><canvas></canvas><script src="/runtime.js"></script>'); return; }
      if (url.pathname === '/runtime.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(runtime); return; }
      if (url.pathname === '/global-palette.png') { response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); response.end(await fs.readFile(path.join(output, 'global-palette.png'))); return; }
      if (['/interactive.html', '/rig-runtime.js', '/rig.json'].includes(url.pathname)) {
        response.writeHead(200, { 'Content-Type': url.pathname.endsWith('.html') ? 'text/html; charset=utf-8' : url.pathname.endsWith('.js') ? 'text/javascript' : 'application/json' });
        response.end(await fs.readFile(path.join(output, url.pathname.slice(1)))); return;
      }
      const file = decodeURIComponent(url.pathname.replace(/^\/textures\//, '')); assert(url.pathname.startsWith('/textures/') && sources.has(file));
      response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(await fs.readFile(sources.get(file)));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`; let browser;
  const metadata = { version: '0.4.0', renderer: 'sampleRigPose + drawRigPose', fps, width, height: null, palette: 'one global palette shared by every GIF, dither=none', sourceManifest: path.relative(project, manifestPath), sourceHashes: hashes, sourcePngUnchanged: false, states: [] };
  try {
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage({ deviceScaleFactor: 1 }); await page.goto(origin);
    const size = await page.evaluate(({ manifest, base, width }) => RigPreview.initialize(manifest, base, width), { manifest, base: origin + '/textures/', width }); metadata.height = size.height;
    const allFrames = [];
    for (const state of states) {
      const directory = path.join(frameRoot, state.id); await fs.mkdir(directory);
      if (state.loop) { const seam = await page.evaluate(({ control, durationMs }) => RigPreview.seam(control, durationMs), state); assert(seam < 1e-7, `${state.id} loop has a pose seam (${seam}).`); }
      const distinct = new Set();
      for (let index = 0; index < state.frames; index++) {
        const encoded = await page.evaluate(({ control, time, duration }) => RigPreview.render(control, time, duration), { control: state.control, time: index * 1000 / fps, duration: state.loop ? state.durationMs : null });
        const bytes = Buffer.from(encoded, 'base64'), file = path.join(directory, `${String(index).padStart(5, '0')}.png`);
        await fs.writeFile(file, bytes); distinct.add(sha(bytes)); allFrames.push(file);
      }
      assert(distinct.size > 1, `${state.id} did not animate.`);
      metadata.states.push({ ...state, distinctFrames: distinct.size, gif: `${state.id}.gif`, webp: `${state.id}.webp` });
      process.stdout.write(`Rendered ${state.id}: ${state.frames} frames.\n`);
    }
    const concat = path.join(frameRoot, 'all.ffconcat'), palette = path.join(output, 'global-palette.png');
    await fs.writeFile(concat, 'ffconcat version 1.0\n' + allFrames.map(file => `file '${file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`).join('\n'));
    await encode(['-f', 'concat', '-safe', '0', '-i', concat, '-vf', 'palettegen=stats_mode=full:reserve_transparent=1:max_colors=256', '-frames:v', '1', '-update', '1', palette]);
    // FFmpeg compacts duplicate palette entries into a first-frame local table.
    // Give unused slots distinct colors so every frame uses the same global table.
    const normalizedPalette = await page.evaluate(async source => {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const pixels = context.getImageData(0, 0, 16, 16), bytes = pixels.data;
      const key = index => (bytes[index * 4] << 16) | (bytes[index * 4 + 1] << 8) | bytes[index * 4 + 2];
      const occupied = new Set(Array.from({ length: 256 }, (_, index) => key(index))), seen = new Set(); let candidate = 0x010000;
      for (let index = 0; index < 256; index++) {
        let color = key(index);
        if (seen.has(color) || (index < 255 && color === 0)) { while (occupied.has(candidate)) candidate++; color = candidate++; occupied.add(color); bytes[index * 4] = color >> 16 & 255; bytes[index * 4 + 1] = color >> 8 & 255; bytes[index * 4 + 2] = color & 255; }
        seen.add(color); bytes[index * 4 + 3] = index === 255 ? 0 : 255;
      }
      context.putImageData(pixels, 0, 0); return canvas.toDataURL('image/png').split(',')[1];
    }, origin + '/global-palette.png');
    await fs.writeFile(palette, Buffer.from(normalizedPalette, 'base64'));
    let paletteHash;
    for (const state of metadata.states) {
      const input = path.join(frameRoot, state.id, '%05d.png');
      await encode(['-framerate', String(fps), '-i', input, '-i', palette, '-filter_complex', '[0:v][1:v]paletteuse=dither=none:alpha_threshold=128:new=0', '-global_palette', '1', '-loop', state.loop ? '0' : '-1', path.join(output, state.gif)]);
      await fs.writeFile(path.join(output, state.gif), fixedGlobalGif(await fs.readFile(path.join(output, state.gif))));
      await encode(['-framerate', String(fps), '-i', input, '-c:v', 'libwebp_anim', '-lossless', '1', '-quality', '100', '-compression_level', '4', '-pix_fmt', 'bgra', '-loop', state.loop ? '0' : '1', path.join(output, state.webp)]);
      const info = gifInfo(await fs.readFile(path.join(output, state.gif)));
      assert(info.globalPalette && info.localPalettes === 0, `${state.id} must use only the fixed global GIF palette.`);
      assert.equal(info.images, state.frames); assert(info.delays.every(delay => delay === 4), `${state.id} is not 25 fps.`);
      if (paletteHash) assert.equal(info.paletteSha256, paletteHash); else paletteHash = info.paletteSha256;
      state.gifValidation = { frames: info.images, frameDelayMs: 40, localPalettes: info.localPalettes, paletteSha256: info.paletteSha256 };
      state.gifBytes = (await fs.stat(path.join(output, state.gif))).size; state.webpBytes = (await fs.stat(path.join(output, state.webp))).size;
      process.stdout.write(`Encoded ${state.id}: GIF + lossless transparent WebP.\n`);
    }
    for (const [file, source] of sources) { assert.equal(sha(await fs.readFile(source)), hashes[file], `Source PNG changed: ${file}`); const destination = path.join(output, 'textures', file); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination); }
    metadata.sourcePngUnchanged = true;
    await fs.writeFile(path.join(output, 'rig.json'), raw); await fs.writeFile(path.join(output, 'rig-runtime.js'), runtime);
    await fs.writeFile(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
    await writePages(metadata);
    // Browser-load every actual exported animation before reporting success.
    for (const state of metadata.states) assert((await fs.readFile(path.join(output, state.webp))).toString('ascii', 0, 4) === 'RIFF');
    const gallery = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await gallery.goto(pathToFileURL(path.join(output, 'index.html')).href);
    const waitImages = () => gallery.waitForFunction(() => { const images = [...document.querySelectorAll('img[data-state]')]; return images.length === 9 && images.every(image => image.complete && image.naturalWidth > 0); });
    await waitImages(); await gallery.screenshot({ path: path.join(output, 'gallery-webp.png'), fullPage: true });
    await gallery.locator('#format').selectOption('gif'); await waitImages(); await gallery.screenshot({ path: path.join(output, 'gallery-gif.png'), fullPage: true });
    const interactive = await browser.newPage(); await interactive.goto(origin + '/interactive.html');
    await interactive.waitForFunction(() => document.querySelector('canvas')?.dataset.ready === 'true');
    await interactive.locator('#state').selectOption('running-right');
    await interactive.waitForFunction(() => { const canvas = document.querySelector('canvas'); return canvas?.dataset.motion === 'running' && canvas?.dataset.direction === 'right' && Number(canvas.dataset.time) > 0 && canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0); });
    await interactive.screenshot({ path: path.join(output, 'interactive.png') });
    console.log(JSON.stringify({ ok: true, directory: output, states: metadata.states.length, fps, globalPaletteShared: true, sourcePngUnchanged: true, gallery: path.join(output, 'index.html') }));
  } finally {
    if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
    if (!process.argv.includes('--keep-frames')) {
      const real = await fs.realpath(frameRoot); assert(contains(output, real) && path.basename(real).startsWith('.render-'), 'Refusing to remove an unexpected render directory.'); await fs.rm(real, { recursive: true, force: true });
    }
  }
}

async function writePages(metadata) {
  const cards = metadata.states.map(state => `<article class="card"><div class="stage"><img data-state="${state.id}" src="${state.webp}" alt="${escapeHtml(state.label)}动画" width="${metadata.width}" height="${metadata.height}"></div><h2>${escapeHtml(state.label)}</h2><p>25 帧/秒 · ${state.durationMs / 1000} 秒 · ${state.loop ? '连续循环' : '单次完成，可点重播'}</p><div class="links"><a href="${state.webp}">打开 WebP</a><a href="${state.gif}">打开 GIF</a></div></article>`).join('');
  await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>龙娘桌宠 · 九种动作预览</title><style>${style}</style><header><h1>龙娘桌宠 · 九种动作</h1><p>直接打开本文件即可查看全部动画。WebP 保留透明与无损颜色；GIF 使用固定全局色板，无抖动。</p><div class="toolbar"><label>动画格式<select id="format"><option value="webp">透明无损 WebP</option><option value="gif">GIF</option></select></label><button id="replay">重播全部</button><button id="background">切换背景</button><a class="control" href="http://127.0.0.1:4177/interactive.html">打开实时交互预览</a></div><p class="note">实时预览需要在此目录运行 <code>node serve-preview.mjs</code>，再打开上方链接。所有 GIF / WebP 均可独立打开，无需服务器。</p></header><main class="grid">${cards}</main><script>let background=0;const format=document.querySelector('#format');function replay(){for(const image of document.querySelectorAll('img[data-state]'))image.src=image.dataset.state+'.'+format.value+'?replay='+Date.now()}format.onchange=replay;document.querySelector('#replay').onclick=replay;document.querySelector('#background').onclick=()=>{background=(background+1)%3;for(const element of document.querySelectorAll('.stage')){element.style.backgroundImage=background?'none':'';element.style.backgroundColor=background===1?'#fff':background===2?'#36303f':''}}</script></html>`);
  await fs.writeFile(path.join(output, 'interactive.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>龙娘 · 实时骨骼预览</title><style>${style}</style><main class="interactive"><h1>实时动作预览</h1><p>与桌宠使用同一个姿势采样与 Canvas 绘制器；固定 PNG 只作为纹理读取。</p><div class="toolbar"><label>动作<select id="state">${metadata.states.map(state => `<option value="${state.id}">${state.label}</option>`).join('')}</select></label><button id="pause">暂停</button><button id="restart">重新开始</button><label>速度<input id="speed" type="range" min="0.1" max="2" step="0.1" value="1"><span id="speedValue">1×</span></label></div><div class="stage"><canvas></canvas></div><label>取时<input id="time" type="range" min="0" max="10" step="0.04" value="0"><span id="readout" class="readout">0.00 秒</span></label><p><a href="index.html">返回全部动画</a></p></main><script src="rig-runtime.js"></script><script>const states=${JSON.stringify(metadata.states.map(({ id, control, durationMs }) => ({ id, control, durationMs })))};let selected=states[0],elapsed=0,last=performance.now(),playing=true;const slider=document.querySelector('#time'),speed=document.querySelector('#speed');fetch('rig.json').then(response=>response.json()).then(async manifest=>{await RigPreview.initialize(manifest,new URL('textures/',location.href).href,${metadata.width});function draw(now){if(playing)elapsed+=(now-last)*Number(speed.value);last=now;RigPreview.live(selected.control,elapsed);slider.value=String((elapsed/1000)%Number(slider.max));document.querySelector('#readout').textContent=(elapsed/1000).toFixed(2)+' 秒';requestAnimationFrame(draw)}requestAnimationFrame(draw)});document.querySelector('#state').onchange=event=>{selected=states.find(state=>state.id===event.target.value);elapsed=0;slider.max=String(Math.max(10,selected.durationMs/1000));last=performance.now()};document.querySelector('#pause').onclick=event=>{playing=!playing;event.target.textContent=playing?'暂停':'播放';last=performance.now()};document.querySelector('#restart').onclick=()=>{elapsed=0;last=performance.now()};slider.oninput=()=>{elapsed=Number(slider.value)*1000;last=performance.now()};speed.oninput=()=>document.querySelector('#speedValue').textContent=speed.value+'×';</script></html>`);
  await fs.writeFile(path.join(output, 'serve-preview.mjs'), `import http from'node:http';import fs from'node:fs/promises';import path from'node:path';import{fileURLToPath}from'node:url';const root=path.dirname(fileURLToPath(import.meta.url)),port=Number(process.argv[2]||4177);http.createServer(async(req,res)=>{try{const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+(name==='/'?'/index.html':name)),relative=path.relative(root,file);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('outside');const real=await fs.realpath(file),r=path.relative(root,real);if(r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r))throw Error('outside');const type={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.png':'image/png','.gif':'image/gif','.webp':'image/webp'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type});res.end(await fs.readFile(real))}catch{res.writeHead(404).end('Not found')}}).listen(port,'127.0.0.1',()=>console.log('Open http://127.0.0.1:'+port+'/interactive.html'));`);
}
await main();
