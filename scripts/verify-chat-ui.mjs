import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright';
const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const dataDir=arg('--data-dir');
if(!dataDir||!path.isAbsolute(dataDir))throw Error('Pass the authorized absolute data directory containing the manual Chat login.');
const send=process.argv.includes('--send');
const directory=await fs.mkdtemp(path.resolve('.local/chat-ui-070-'));
const env={...process.env,DRAGON_PET_DATA_DIR:dataDir};delete env.ELECTRON_RUN_AS_NODE;
const executable=arg('--executable');let app;const proof={ok:false,sent:false,mode:null,model:null,effort:null,errors:[]};
try{
  app=await _electron.launch({executablePath:path.resolve(executable||'node_modules/electron/dist/electron.exe'),args:executable?[]:[process.cwd()],env,timeout:45000});
  let bubble;for(let i=0;i<200&&!bubble;i++){bubble=app.windows().find(w=>w.url().includes('view=bubble'));await new Promise(r=>setTimeout(r,100));}assert(bubble);
  bubble.on('pageerror',e=>proof.errors.push(e.message));await bubble.waitForFunction(()=>Boolean(window.pet));
  await bubble.evaluate(()=>window.pet.connectChat());
  for(let i=0;i<90;i++){const state=await bubble.evaluate(()=>window.pet.getState());if(!state.chat.active)break;await new Promise(r=>setTimeout(r,500));}
  if(process.argv.includes('--new-chat')){await bubble.evaluate(()=>window.pet.newChat());await bubble.evaluate(()=>window.pet.connectChat());}
  const before=await bubble.evaluate(()=>window.pet.getState());assert.equal(before.chat.status,'ready');assert.equal(before.chat.effort,'high');assert(before.chat.model);
  proof.mode='ordinary Chat';proof.model=before.chat.model;proof.effort=before.chat.effort;
  await bubble.evaluate(()=>window.pet.openComposer());await bubble.locator('.compose-shell').waitFor();
  await bubble.getByRole('combobox',{name:'消息通道'}).selectOption('auto');
  const input=bubble.getByRole('textbox',{name:'对龙娘说点什么',exact:true});const original=await input.inputValue();
  if(!send&&original==='桌宠 0.7.0 普通聊天验收：只回复“气泡聊天成功”，不要使用工具。')await input.fill('');
  if(send){
    assert(original===''||original==='桌宠 0.7.0 普通聊天验收：只回复“气泡聊天成功”，不要使用工具。','Do not overwrite an existing user draft.');
    await input.fill('桌宠 0.7.0 普通聊天验收：只回复“气泡聊天成功”，不要使用工具。');
    await bubble.getByRole('button',{name:'发送消息',exact:true}).click();
    let done=false;
    for(let i=0;i<180;i++){
      await new Promise(r=>setTimeout(r,500));const s=await bubble.evaluate(()=>window.pet.getState());
      if(['uncertain','error','setup-required','login-required'].includes(s.chat.status))throw Error(s.chat.message);
      if(s.chat.messages.length>before.chat.messages.length&&s.chat.status==='ready'&&s.chat.messages.at(-1)?.role==='assistant'&&s.chat.messages.at(-1)?.text.includes('气泡聊天成功')){done=true;break;}
    }
    assert(done,'Chat response timed out');
    proof.sent=true;
    // Chrome or an outside click can legitimately collapse the bubble. Reopen it
    // as a character click would, then verify the visible reply separately.
    if(!process.argv.includes('--expect-auto-reply'))await bubble.evaluate(()=>window.pet.showReply());
    await bubble.waitForFunction(()=>document.querySelector('.quick-reply-text')?.textContent.includes('气泡聊天成功'),{},{timeout:10000});
    if(process.argv.includes('--expect-auto-reply')){
      let visible=false;
      for(let i=0;i<30&&!visible;i++){visible=await app.evaluate(({BrowserWindow})=>Boolean(BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('view=bubble'))?.isVisible()));if(!visible)await new Promise(r=>setTimeout(r,100));}
      assert(visible,'Completed Chat reply appears without reopening the bubble manually.');proof.autoReply=true;
    }
  }
  const after=await bubble.evaluate(()=>window.pet.getState());
  assert.equal(after.assistant.threadId,before.assistant.threadId);assert.equal(after.assistant.activeTurnId,before.assistant.activeTurnId);
  assert.deepEqual(after.assistant.messages,before.assistant.messages,'Ordinary chat cannot append Codex messages or start a turn.');
  await bubble.evaluate(()=>window.pet.showReply());await bubble.locator('.reply-shell').waitFor();
  await bubble.waitForTimeout(350);await bubble.screenshot({path:path.join(directory,'chat-reply.png'),omitBackground:true});
  await bubble.evaluate(()=>window.pet.openComposer());await bubble.locator('.compose-shell').waitFor();
  if(send)await bubble.waitForFunction(()=>document.querySelector('.quick-composer textarea')?.value==='');
  await bubble.waitForTimeout(350);await bubble.screenshot({path:path.join(directory,'chat-input.png'),omitBackground:true});
  assert.deepEqual(proof.errors,[]);proof.ok=true;console.log(JSON.stringify({...proof,directory}));
}catch(error){proof.errors.push(String(error));throw error;}finally{await fs.writeFile(path.join(directory,'proof.json'),JSON.stringify(proof,null,2));await app?.close();}
