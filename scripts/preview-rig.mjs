import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const directory = path.resolve('assets/skins/silver-dragon-rig');
const output = path.resolve('.local/rig-preview');
await fs.mkdir(output, { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'skin.json'), 'utf8'));
const bundled = await build({ stdin: { contents: `
import { sampleRigPose } from './src/shared/rig';
import { drawRigPose } from './src/shared/render-rig';
globalThis.renderRigPreview = async (manifest) => {
  const textures = new Map();
  for (const file of new Set(Object.values(manifest.rig.views).flatMap(view => view.layers.map(layer => layer.file)))) {
    const img = new Image(); img.src = '/' + file; await img.decode(); textures.set(file,img);
  }
  globalThis.rigPreviewTextures = textures;
  const states = [ ['front', 'idle', 0], ['front', 'speaking', 650], ['front', 'thinking', 950], ['left', 'running', 0], ['left', 'running', 450], ['left', 'running', 900], ['right', 'running', 0], ['right', 'running', 450], ['right', 'running', 900] ];
  const canvas = document.querySelector('canvas'),ctx=canvas.getContext('2d');
  ctx.fillStyle='#f3f0fa'; ctx.fillRect(0,0,canvas.width,canvas.height);
  for (let i=0;i<states.length;i++) {
    const [facing,activity,time]=states[i], x=i%3*360,y=Math.floor(i/3)*490;
    ctx.fillStyle='#5d506f'; ctx.font='16px sans-serif'; ctx.fillText(facing+' '+activity+' '+time+' ms',x+12,y+24);
    ctx.strokeStyle='#c5bbd3'; ctx.beginPath(); ctx.moveTo(x+12,y+465);ctx.lineTo(x+348,y+465);ctx.stroke();
    const playback={control:{activity,motion:activity==='running'?'running':'idle',direction:facing==='left'?'left':'right'},startedAt:0};
    drawRigPose(ctx,sampleRigPose(manifest.rig,playback,time),textures,{scale:.68,x:x+6,y:y+42});
  }
};
globalThis.renderRigScalePreview = (manifest,userScale) => {
  const width=Math.round(200*userScale),height=Math.round(240*userScale),cellWidth=width+24,cellHeight=height+42;
  const canvas=document.querySelector('canvas');canvas.width=cellWidth*3;canvas.height=cellHeight*2;
  const ctx=canvas.getContext('2d'),scale=Math.min(width/manifest.width,(height-24)/manifest.height);
  for(let row=0;row<2;row++)for(let col=0;col<3;col++){
    const x=col*cellWidth,y=row*cellHeight,facing=['front','left','right'][col];
    ctx.fillStyle=row?'#252232':'#f3f0fa';ctx.fillRect(x,y,cellWidth,cellHeight);
    ctx.fillStyle=row?'#ddd3ef':'#5d506f';ctx.font='12px sans-serif';ctx.fillText(facing+' '+width+'×'+height+' ('+userScale+'×)',x+7,y+17);
    ctx.strokeStyle=row?'#685c7c':'#c5bbd3';ctx.strokeRect(x+12,y+30,width,height);
    const playback={control:{activity:'idle',motion:facing==='front'?'idle':'running',direction:facing==='left'?'left':'right'},startedAt:0};
    drawRigPose(ctx,sampleRigPose(manifest.rig,playback,450),globalThis.rigPreviewTextures,{scale,x:x+12+width/2-manifest.anchor.x*scale,y:y+30+height-8-manifest.anchor.y*scale});
  }
};`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife', platform: 'browser' });
const server = createServer(async (request, response) => {
  if (request.url === '/bundle.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundled.outputFiles[0].contents); return; }
  const file = decodeURIComponent(request.url?.slice(1) ?? '');
  if (/^parts-(front|left|right)-v\d+\.png$/.test(file)) { response.setHeader('content-type', 'image/png'); response.end(await fs.readFile(path.join(directory,file))); return; }
  response.setHeader('content-type','text/html'); response.end('<!doctype html><style>body{margin:0}canvas{display:block}</style><canvas width="1080" height="1470"></canvas><script src="/bundle.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1080,height:1470}});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(manifest=>globalThis.renderRigPreview(manifest),manifest);
  const file=path.join(output,'rig-contact-sheet.png'); await page.screenshot({path:file}); console.log(file);
  for (const scale of [.6,1,1.7]) {
    await page.evaluate(({manifest,scale})=>globalThis.renderRigScalePreview(manifest,scale),{manifest,scale});
    const file=path.join(output,`rig-size-${scale}.png`);await page.locator('canvas').screenshot({path:file});console.log(file);
  }
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
