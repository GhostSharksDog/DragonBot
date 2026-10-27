import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatService } from '../src/main/chat/service';
import type { ChatBrowser } from '../src/main/chat/browser';
import type { ChatPageState } from '../src/main/chat/page';
import { routeMessage, taskContext } from '../src/shared/chat';
import { SettingsStore } from '../src/main/settings';

const page=():ChatPageState=>({url:'https://chatgpt.com/',loggedIn:true,mode:'chat',model:'GPT-test',effort:'high',draft:'',generating:false,messages:[],problem:null,controls:[],models:['GPT-test']});
class Browser implements ChatBrowser {
  state=page(); calls:string[]=[]; onclose?:()=>void; uncertain=false;failBefore=false;
  async connect(url?:string|null){this.calls.push('connect');if(url)this.state.url=url;}
  async read(){return structuredClone(this.state);}
  async configure(){return this.read();}
  async show(){} async close(){this.onclose?.();} async stop(){this.state.generating=false;}
  async navigate(url:string){this.state={...page(),url};}
  async send(text:string,_model:string,before:()=>Promise<void>){
    this.calls.push('send');if(this.failBefore)throw Error('没有点击发送');await before();if(this.uncertain)throw Error('发送结果未知');
    this.state.url='https://chatgpt.com/c/test-chat';this.state.messages.push({id:'u'+this.calls.length,role:'user',text});this.state.generating=true;
  }
  respond(text='你好'){this.state.generating=false;this.state.messages.push({id:'a'+this.calls.length,role:'assistant',text,complete:true});}
}
function setup(t:any,browser=new Browser()){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dragon-chat-test-'));let settings={mode:'auto' as const,model:'',effort:'high' as const};
  const options={dataDir:dir,getSettings:()=>settings,saveModel:(model:string)=>{settings={...settings,model};},createBrowser:async()=>browser,openLogin:async()=>{},changed:()=>{},pollMs:5};
  const service=new ChatService(options);t.after(async()=>{await service.dispose();fs.rmSync(dir,{recursive:true,force:true});});return {service,browser,dir,options};
}
async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('State did not settle');}

test('routes consultations locally and keeps explicit task supplements with Codex',()=>{
  for(const text of ['你好','如何修改代码','帮我理解这个报错','请问怎么运行测试','把这段文字改写得简短一点'])assert.equal(routeMessage(text,'auto'),'chat',text);
  for(const text of ['帮我修改这个项目','运行 npm test','打开浏览器查一下资料'])assert.equal(routeMessage(text,'auto'),'task',text);
  assert.equal(routeMessage('继续桌宠项目','auto'),'project');assert.equal(routeMessage('继续','auto'),'choose');assert.equal(routeMessage('继续','auto',true),'task');assert.equal(routeMessage('补充要求：用中文','auto',true),'task');assert.equal(routeMessage('帮我修改项目','chat'),'chat');
});
test('context transfers no more than 12 messages and 16000 characters, retaining quoted data',()=>{
  const messages=Array.from({length:30},(_,i)=>({id:String(i),role:'user' as const,text:'x'.repeat(2000),createdAt:i,channel:'chat' as const}));
  const result=taskContext(messages,'实际任务');const parsed=JSON.parse(result.slice(result.indexOf('[{"role"')));
  assert.ok(parsed.length<=12);assert.equal(parsed.reduce((n:number,m:any)=>n+m.text.length,0),16000);assert.ok(result.startsWith('实际任务'));
});
test('real Chat service records separate messages and rejects duplicate sends while generating',async t=>{
  const {service,browser}=setup(t);await service.send('你好');await assert.rejects(service.send('重复'));
  browser.respond();await until(()=>service.getSnapshot().status==='ready');
  const state=service.getSnapshot();assert.equal(browser.calls.filter(c=>c==='send').length,1);assert.equal(state.messages.length,2);assert.equal(state.messages[0].text,'你好');assert.equal(state.messages[1].text,'你好');assert.ok(state.messages.every(m=>m.channel==='chat'));
});
test('incorrect mode, low effort, missing login never dispatch or fall back',async t=>{
  for(const patch of [{mode:'work'}, {effort:'low'}, {loggedIn:false}]){const b=new Browser();Object.assign(b.state,patch);const {service}=setup(t,b);await assert.rejects(service.send('你好'));assert.ok(!b.calls.includes('send'));}
});
test('uncertain dispatch survives restart, reconciles exact message once, never resends',async t=>{
  const {service,browser,options}=setup(t);browser.uncertain=true;await assert.rejects(service.send('确认这条'));
  assert.equal(service.getSnapshot().status,'uncertain');await service.dispose();
  const saved=JSON.parse(fs.readFileSync(path.join(options.dataDir,'chat/history.json'),'utf8'));browser.state.messages=[{id:'confirmed-user',role:'user',text:saved.outbox.wire},{id:'confirmed-answer',role:'assistant',text:'收到',complete:true}];browser.state.url='https://chatgpt.com/c/test-chat';
  const resumed=new ChatService(options);t.after(()=>resumed.dispose());await resumed.check();assert.equal(resumed.getSnapshot().status,'ready');assert.equal(resumed.getSnapshot().messages.length,2);assert.equal(browser.calls.filter(c=>c==='send').length,1);
});
test('user draft is retained and never dispatched over',async t=>{const {service,browser}=setup(t);browser.state.draft='我的草稿';await assert.rejects(service.send('你好'),/草稿/);assert.equal(browser.state.draft,'我的草稿');assert.ok(!browser.calls.includes('send'));});
test('another user message prevents attributing an unrelated reply to the request',async t=>{
  const {service,browser}=setup(t);await service.send('你好');browser.state.messages.push({id:'other',role:'user',text:'其他输入'});browser.respond();await until(()=>service.getSnapshot().status==='uncertain');assert.equal(service.getSnapshot().messages.filter(m=>m.role==='assistant').length,0);
});
test('disconnect preserves outbox and changes no task state',async t=>{const {service,browser}=setup(t);await service.send('你好');browser.onclose?.();assert.equal(service.getSnapshot().status,'uncertain');assert.equal(service.getSnapshot().active,false);await assert.rejects(service.send('重发'));});
test('first reply at ChatGPT local conversation URL is read and retained for resume',async t=>{
  const {service,browser}=setup(t);await service.send('第一次聊天');browser.state.url='https://chatgpt.com/c/local-chatgpt%3Anew-conversation';browser.respond('你好');
  await until(()=>service.getSnapshot().status==='ready');assert.equal(service.getSnapshot().messages.at(-1)?.text,'你好');
});
test('a completed DOM marker does not truncate a reply while the stop control remains',async t=>{
  const {service,browser}=setup(t);await service.send('你好');browser.respond('第一部分');browser.state.generating=true;
  await until(()=>service.getSnapshot().messages.some(m=>m.text==='第一部分'));assert.equal(service.getSnapshot().active,true);
  browser.state.messages.at(-1)!.text='完整回复';browser.state.generating=false;await until(()=>service.getSnapshot().status==='ready');assert.equal(service.getSnapshot().messages.at(-1)?.text,'完整回复');
});
test('chat settings and lasting website grants survive restart',t=>{const {dir}=setup(t);const settings=new SettingsStore(dir);settings.update({chat:{mode:'chat',model:'GPT-test',effort:'high'},grant:{folders:[dir],origins:['https://example.com'],browserInput:true}});const reloaded=new SettingsStore(dir);assert.deepEqual(reloaded.value.chat,settings.value.chat);assert.deepEqual(reloaded.value.grant,{folders:[],origins:['https://example.com'],browserInput:true});});
