import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

// Whole-character rectangles and integer registration only. Original PNG bytes
// are read and hashed; no body part, alpha value, or source pixel is changed.
const source = path.resolve(process.argv[2] ?? 'assets/animation-redraw-v1/raw/running-left-v2-alpha.png');
const action = process.argv[3] ?? 'running-left';
const globalScale = action === 'idle' ? .96 : 1;
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bytes = await fs.readFile(source), hash = createHash('sha256').update(bytes).digest('hex');
const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
const rgba = await new Promise((resolve,reject)=>{
  const child=spawn('E:/Apps/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe',['-v','error','-i',source,'-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','pipe']});const data=[];let error='';child.stdout.on('data',chunk=>data.push(chunk));child.stderr.on('data',chunk=>error+=chunk);child.on('error',reject);child.on('close',code=>code===0?resolve(Buffer.concat(data)):reject(new Error(error)));
});
if(rgba.length!==width*height*4)throw new Error('Unexpected decoded size.');
const labels=new Int32Array(width*height),groups=[];
for(let pixel=0;pixel<labels.length;pixel++){
  if(labels[pixel]||rgba[pixel*4+3]<128)continue;
  const id=groups.length+1,queue=[pixel];labels[pixel]=id;let head=0,x0=width,y0=height,x1=-1,y1=-1,sumX=0,sumY=0;
  while(head<queue.length){const next=queue[head++],x=next%width,y=Math.floor(next/width);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);sumX+=x;sumY+=y;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy;if(nx<0||nx>=width||ny<0||ny>=height)continue;const neighbor=ny*width+nx;if(!labels[neighbor]&&rgba[neighbor*4+3]>=128){labels[neighbor]=id;queue.push(neighbor);}}
  }
  groups.push({id,pixels:queue.length,bbox:{x:x0,y:y0,width:x1-x0+1,height:y1-y0+1},center:{x:sumX/queue.length,y:sumY/queue.length}});
}
const main=groups.filter(group=>group.pixels>=3000).sort((a,b)=>a.center.y-b.center.y);
if(main.length!==24)throw new Error(`Expected 24 separate whole characters, found ${main.length}; merged or missing figures need manual review.`);
const ordered=[];for(let row=0;row<4;row++){const strip=main.slice(row*6,row*6+6).sort((a,b)=>a.center.x-b.center.x);if(Math.max(...strip.map(group=>group.center.y))-Math.min(...strip.map(group=>group.center.y))>height/8)throw new Error('Ambiguous row assignment.');ordered.push(...strip);}
const distance=(a,b)=>Math.hypot(Math.max(a.x-b.x-b.width,b.x-a.x-a.width,0),Math.max(a.y-b.y-b.height,b.y-a.y-a.height,0));
const mainIds=new Set(main.map(group=>group.id));
const figures=ordered.map((group,index)=>{
  const accessories=groups.filter(candidate=>!mainIds.has(candidate.id)&&candidate.pixels>=6&&distance(candidate.bbox,group.bbox)<=6&&ordered.every(other=>other.id===group.id||distance(candidate.bbox,group.bbox)<=distance(candidate.bbox,other.bbox)));
  const selected=[group,...accessories],left=Math.min(...selected.map(item=>item.bbox.x)),top=Math.min(...selected.map(item=>item.bbox.y)),right=Math.max(...selected.map(item=>item.bbox.x+item.bbox.width)),bottom=Math.max(...selected.map(item=>item.bbox.y+item.bbox.height));
  const x=Math.max(0,left-3),y=Math.max(0,top-3),sourceRect={x,y,width:Math.min(width,right+3)-x,height:Math.min(height,bottom+3)-y};
  const included=new Set(selected.map(item=>item.id));let foreignMainPixels=0,foreignAccessoryPixels=0,torsoWeight=0,torsoX=0,torsoY=0,faceCount=0,faceX=0,faceY=0,foot=null;
  for(let sy=y;sy<y+sourceRect.height;sy++)for(let sx=x;sx<x+sourceRect.width;sx++){
    const pixel=sy*width+sx,label=labels[pixel],alpha=rgba[pixel*4+3];if(label&&!included.has(label)){if(mainIds.has(label))foreignMainPixels++;else foreignAccessoryPixels++;}
    if(label!==group.id)continue;
    const relative=(sy-group.bbox.y)/group.bbox.height;
    if(relative>=.4&&relative<=.7){torsoWeight+=alpha;torsoX+=sx*alpha;torsoY+=sy*alpha;}
    if(relative>=.75&&sx>=group.bbox.x+group.bbox.width*.25&&sx<=group.bbox.x+group.bbox.width*.75)foot=Math.max(foot??sy,sy);
    const r=rgba[pixel*4],g=rgba[pixel*4+1],b=rgba[pixel*4+2];
    if(relative>=.24&&relative<=.52&&r>=180&&g>=120&&b>=110&&r-g>=5&&r-b>=5&&g-b>=-15&&g-b<=30){faceCount++;faceX+=sx;faceY+=sy;}
  }
  const canvasEdges=[];if(left===0)canvasEdges.push('left');if(top===0)canvasEdges.push('top');if(right===width)canvasEdges.push('right');if(bottom===height)canvasEdges.push('bottom');
  return {sourceFrame:index+1,row:Math.floor(index/6),column:index%6,mainComponentId:group.id,mainComponentPixels:group.pixels,mainBodyBBox:group.bbox,sourceRect,accessories:accessories.map(item=>({pixels:item.pixels,bbox:item.bbox})),foreignMainPixels,foreignAccessoryPixels,originalCanvasTouches:canvasEdges,torsoCenter:{x:torsoX/torsoWeight,y:torsoY/torsoWeight},faceCenter:faceCount?{x:faceX/faceCount,y:faceY/faceCount}:null,shoeBottom:foot};
});
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return(sorted[11]+sorted[12])/2;};
const origin=figure=>({x:Math.floor(figure.column*width/6),y:Math.floor(figure.row*height/4)});
const torsoX=figures.map(figure=>figure.torsoCenter.x-origin(figure).x),faceX=figures.map(figure=>figure.faceCenter.x-origin(figure).x);
// Match the thinking template's stable body center while retaining the profile
// face's natural horizontal offset from the torso. Keep room for full alpha.
const targetTorso=134,targetFace=targetTorso+median(faceX.map((x,index)=>x-torsoX[index])),targetFaceY=111;
for(let index=0;index<figures.length;index++){
  const figure=figures[index],rawShiftX=Math.round(((targetTorso-torsoX[index])+(targetFace-faceX[index]))/2);
  if(action==='idle'){
    figure.registration={rawCellTranslation:null,destination:{x:Math.round(138-(figure.faceCenter.x-figure.sourceRect.x)*globalScale),y:Math.round(260-(figure.shoeBottom-figure.sourceRect.y)*globalScale)}};
    const d=figure.registration.destination;figure.outputBounds={left:d.x,top:d.y,right:d.x+figure.sourceRect.width*globalScale,bottom:d.y+figure.sourceRect.height*globalScale};
    if(d.x<8||d.y<8||figure.outputBounds.right>264||figure.outputBounds.bottom>264)throw new Error(`Idle complete rectangle ${index+1} does not fit after one shared global scale.`);
    continue;
  }
  // Stabilize the camera using the face, preserving up to one pixel of natural
  // within-row bob in each direction. Never use the shoe or bbox bottom as a Y anchor.
  const rowMedian=median([...Array(4)].flatMap(()=>figures.slice(figure.row*6,figure.row*6+6).map(item=>item.faceCenter.y-item.row*256)));
  const faceLocalY=figure.faceCenter.y-figure.row*256,naturalBob=Math.max(-1,Math.min(1,(faceLocalY-rowMedian)*.6));
  const rawShiftY=Math.round(targetFaceY-faceLocalY+naturalBob);
  figure.registration={rawCellTranslation:{x:rawShiftX,y:rawShiftY},destination:{x:8+figure.sourceRect.x-figure.column*256+rawShiftX,y:8+figure.sourceRect.y-figure.row*256+rawShiftY}};
  const d=figure.registration.destination;figure.outputBounds={left:d.x,top:d.y,right:d.x+figure.sourceRect.width,bottom:d.y+figure.sourceRect.height};
  if(d.x<8||d.y<8||d.x+figure.sourceRect.width>264||d.y+figure.sourceRect.height>264)throw new Error(`Complete source rectangle ${index+1} does not fit the common canvas with 8px outer padding.`);
}
const output=path.join(project,'.local/redraw-qa',path.basename(source,'.png')+'-'+hash.slice(0,8)+'-whole');await fs.mkdir(output,{recursive:true});
const report={version:1,approvedByRoot:false,source,sourceSha256:hash,width,height,threshold:128,globalScale,sourceOrder:'four rows of six complete main components, sorted by centroid Y then X',transformPolicy:'Full-character rectangular crop with 3px alpha margin and integer translation. Idle alone uses one shared 0.96 uniform scale for all 24 frames; no body-part compositing, source cleanup, or per-frame scaling.',canvas:{width:272,height:272,padding:8},mainComponentCount:main.length,originalCanvasClipped:figures.some(figure=>figure.originalCanvasTouches.length),mergedCharacters:false,neighborPollution:figures.some(figure=>figure.foreignMainPixels>0),registrationTargets:{torsoX:targetTorso,faceX:targetFace,faceY:targetFaceY},figures,sourceRects:{[action]:figures.map(figure=>figure.sourceRect)},placements:{[action]:figures.map(figure=>figure.registration.destination)},frames:{[action]:figures.map(figure=>figure.registration.rawCellTranslation)},notes:['This is a proposal requiring visual review. It is not approval.','Generated guide lines are not crop boundaries. Rectangles follow full figures.','Low-alpha pixels within the rectangles are preserved. Noise is not removed.','Running Y follows the face with ±1px natural bob; stationary idle follows its stable shoe sole and face X.','Original variations remain. One global idle scale is shared by the entire action; no per-frame scaling is applied.']};
await fs.writeFile(path.join(output,'registration.json'),JSON.stringify(report,null,2)+'\n');
const sourceRectsConfig={approvedByRoot:false,indexBase:1,reason:'Review pending: recover complete characters, retain 3px alpha margin, and apply whole-person registration only. Idle uses one shared global uniform scale; no source pixels are rewritten.',sources:{[action]:{sourceSha256:hash,globalScale,frames:figures.map(figure=>({sourceRect:figure.sourceRect,destination:figure.registration.destination}))}}};
await fs.writeFile(path.join(output,'source-rects-proposal.json'),JSON.stringify(sourceRectsConfig,null,2)+'\n');
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1700,height:1400}});await page.setContent('<style>body{margin:0}canvas{display:block}</style><canvas></canvas>');
  for(const mode of ['overview','contact'])for(const theme of ['light','dark']){
    await page.evaluate(async({report,encoded,mode,theme})=>{const image=new Image();image.src='data:image/png;base64,'+encoded;await image.decode();const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');canvas.width=mode==='overview'?report.width:6*282;canvas.height=mode==='overview'?report.height:4*308;ctx.fillStyle=theme==='dark'?'#252232':'#f1edf6';ctx.fillRect(0,0,canvas.width,canvas.height);if(mode==='overview'){ctx.drawImage(image,0,0);for(const f of report.figures){ctx.strokeStyle=f.foreignMainPixels?'#f55':'#b38c43';ctx.lineWidth=1;ctx.strokeRect(f.sourceRect.x+.5,f.sourceRect.y+.5,f.sourceRect.width,f.sourceRect.height);ctx.fillStyle='#c17b33';ctx.font='15px sans-serif';ctx.fillText(String(f.sourceFrame),f.sourceRect.x+3,f.sourceRect.y+17);}}else for(const f of report.figures){const left=f.column*282,top=f.row*308,region=f.sourceRect,d=f.registration.destination;ctx.fillStyle=theme==='dark'?'#ded3ea':'#564261';ctx.font='12px sans-serif';ctx.fillText('Source '+f.sourceFrame+' · '+report.globalScale+'×',left+7,top+17);ctx.drawImage(image,region.x,region.y,region.width,region.height,left+5+d.x,top+27+d.y,region.width*report.globalScale,region.height*report.globalScale);ctx.strokeStyle='#a88d53';ctx.strokeRect(left+5.5,top+27.5,272,272);}}, {report,encoded:bytes.toString('base64'),mode,theme});
    await page.locator('canvas').screenshot({path:path.join(output,`${mode}-${theme}.png`)});
  }
}finally{await browser.close();}
if(createHash('sha256').update(await fs.readFile(source)).digest('hex')!==hash)throw new Error('Original source changed.');
console.log(JSON.stringify({output,components:main.length,clipped:report.originalCanvasClipped,polluted:report.neighborPollution,bboxes:figures.map(f=>({i:f.sourceFrame,b:f.mainBodyBBox,rect:f.sourceRect,foreign:f.foreignMainPixels,d:f.registration.destination,bounds:f.outputBounds}))}));
