import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const directory=path.resolve('assets/skins/silver-dragon-frames'),output=path.resolve('.local/frames-preview');await fs.mkdir(output,{recursive:true});
const manifest=JSON.parse(await fs.readFile(path.join(directory,'skin.json'),'utf8'));
const atlases=Object.fromEntries(await Promise.all(['idle','thinking'].map(async state=>[state,'data:image/png;base64,'+(await fs.readFile(path.join(directory,`${state}-atlas.png`))).toString('base64')])));
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1320,height:1060},deviceScaleFactor:1});await page.setContent('<style>body{margin:0}canvas{display:block}</style><canvas width="1320" height="1060"></canvas>');
  await page.evaluate(async({manifest,atlases})=>{const images={};for(const [state,url]of Object.entries(atlases)){const image=new Image();image.src=url;await image.decode();images[state]=image;}const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');for(let row=0;row<2;row++){const top=row*530;ctx.fillStyle=row?'#252232':'#f2eff7';ctx.fillRect(0,top,1320,530);let left=0;for(const [state,width]of[['idle',200],['thinking',200],['idle',400],['thinking',400]]){const height=width*1.2,scale=Math.min(width/272,(height-24)/272),stageTop=top+35;ctx.fillStyle=row?'#e4d7f0':'#584365';ctx.font='14px sans-serif';ctx.fillText(state+' · '+width+'×'+height,left+12,top+22);ctx.strokeStyle=row?'#655773':'#d0c6dc';ctx.strokeRect(left+10.5,stageTop+.5,width,height);ctx.drawImage(images[state],0,0,272,272,left+10+width/2-manifest.anchor.x*scale,stageTop+height-8-manifest.anchor.y*scale,272*scale,272*scale);left+=width+24;}}},{manifest,atlases});
  await page.locator('canvas').screenshot({path:path.join(output,'idle-thinking-light-dark.png')});
  const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>银白龙娘 · 逐帧预览</title><style>body{margin:0;background:#252232;color:#e1d6ef;font:16px sans-serif}header{padding:18px}img{max-width:100%;height:auto;display:block}</style><header>待机与思考 · 实际200px和400px视图</header><img src="idle-thinking-light-dark.png" alt="待机与思考浅深背景对照">';
  await fs.writeFile(path.join(output,'index.html'),html);console.log(path.join(output,'idle-thinking-light-dark.png'));
}finally{await browser.close();}
