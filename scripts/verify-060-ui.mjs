import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright';
const arg = key => { const i=process.argv.indexOf(key); return i<0?null:process.argv[i+1]; };
const directory=await fs.mkdtemp(path.resolve('.local/native-060-'));
const dataDir=path.join(directory,'user-data'); await fs.mkdir(dataDir);
await fs.writeFile(path.join(dataDir,'settings.json'),JSON.stringify({roaming:false}));
const executable=arg('--executable');
const env={...process.env,DRAGON_PET_DATA_DIR:dataDir,CODEX_HOME:arg('--codex-home') || 'C:\\Users\\LCY\\.codex'};delete env.ELECTRON_RUN_AS_NODE;
let app;
const result={ok:false,directory,checks:[],errors:[]};
try {
 app=await _electron.launch({executablePath:executable?path.resolve(executable):path.resolve('node_modules/electron/dist/electron.exe'),args:executable?[]:[process.cwd()],env,timeout:45000});
 let pet,bubble;const deadline=Date.now()+20000;
 while((!pet||!bubble)&&Date.now()<deadline){pet=app.windows().find(w=>w.url().includes('view=pet'));bubble=app.windows().find(w=>w.url().includes('view=bubble'));await new Promise(r=>setTimeout(r,50));}
 assert(pet&&bubble);for(const p of [pet,bubble])p.on('pageerror',e=>result.errors.push(e.message));
 await pet.waitForFunction(async()=>window.pet && (await window.pet.getState()).assistant.connected,{},{timeout:60000});
 const native=()=>app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('view=bubble'));return {visible:w.isVisible(),...w.getBounds()};});
 const settle=async()=>{let prev='';let stable=0;for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,60));const v=await native();const key=JSON.stringify(v);stable=key===prev?stable+1:0;prev=key;if(v.visible&&stable>=3)return v;}throw Error('Native layout did not settle.');};
 await pet.evaluate(()=>window.pet.openComposer());await bubble.locator('.compose-shell').waitFor();
 const input=bubble.getByRole('textbox',{name:'对龙娘说点什么',exact:true});
 for(const [name,text] of [['empty',''],['single','你好'],['multi',Array(5).fill('中文多行输入检查').join('\n')],['long',Array(25).fill('较长输入需要内部滚动').join('\n')],['cleared','']]){
  await input.fill(text);const size=await settle();
  const rect=await bubble.locator('.quick-composer .send-button').boundingBox();const gap=size.height-8-rect.y-rect.height;
  assert(gap>=11&&gap<=17,`${name} send button gap ${gap}`);
  if(['empty','single','cleared'].includes(name))assert.equal(size.height,88);else assert(size.height>88&&size.height<=160);
  result.checks.push({name,height:size.height,bottomGap:gap});await bubble.screenshot({path:path.join(directory,`${name}.png`),omitBackground:true});
 }
 await input.fill('切换保留草稿');
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('view=bubble'));globalThis.__quotaSizes=[];const save=()=>globalThis.__quotaSizes.push({visible:w.isVisible(),height:w.getBounds().height});w.on('show',save);w.on('resize',save);});
 await pet.evaluate(()=>window.pet.openQuota());await bubble.locator('.quota-shell').waitFor();assert.equal((await settle()).height,340);
 await bubble.getByRole('button',{name:'刷新额度',exact:true}).waitFor();await bubble.waitForFunction(()=>!document.querySelector('[aria-label="刷新额度"]').disabled,{},{timeout:20000});
 await bubble.getByRole('button',{name:'刷新额度',exact:true}).click();assert.equal((await settle()).height,340);
 const sizes=await app.evaluate(()=>globalThis.__quotaSizes);assert(sizes.filter(s=>s.visible).every(s=>s.height===340),'Quota never becomes visible at a provisional height.');result.checks.push({name:'quota-layout',sizes});
 await bubble.screenshot({path:path.join(directory,'quota.png'),omitBackground:true});
 // A delayed resize for the previous view must be ignored by main.
 const old=(await pet.evaluate(()=>window.pet.getState())).quickLayout.id;
 await pet.evaluate(()=>window.pet.openComposer());await settle();
 await pet.evaluate(old=>window.pet.layoutQuickBubble({id:old,width:320,height:340,body:{x:0,y:0,width:320,height:340},regions:[]}),old);
 assert.equal((await settle()).height,88);assert.equal(await input.inputValue(),'切换保留草稿');
 result.checks.push({name:'stale-layout-ignored-and-draft-preserved'});
 await pet.evaluate(()=>window.pet.setBubbleMode('panel','settings'));await bubble.getByRole('heading',{name:'项目接续'}).waitFor();await bubble.getByRole('heading',{name:'独立 Chrome'}).waitFor();
 assert.equal(await bubble.getByRole('button',{name:'安装官方扩展'}).count(),0);
 const final=await pet.evaluate(()=>window.pet.getState());assert.equal(final.assistant.threadId,null);assert.equal(final.assistant.activeTurnId,null);assert.deepEqual(result.errors,[]);
 result.ok=true;console.log(directory);
}catch(error){result.errors.push(String(error.stack||error));throw error;}finally{await fs.writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2));await app?.close();}
