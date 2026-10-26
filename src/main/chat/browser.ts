import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { launchOwnedChrome, type CdpConnection } from '../tools/cdp-browser';
import { readChatPage, isChatUrl, normalizedMessage, type ChatPageState } from './page';
import type { BrowserConnectionConfig } from '../../shared/types';
const manualWindows=new Map<string,ChildProcess>();

export interface ChatBrowser {
  onclose?:()=>void;
  connect(url?:string|null):Promise<void>; read():Promise<ChatPageState>;
  configure(model:string):Promise<ChatPageState>; show():Promise<void>;
  navigate(url:string):Promise<void>; send(text:string, model:string, beforeDispatch:()=>Promise<void>):Promise<void>;
  stop():Promise<void>; close():Promise<void>;
}

/** Fixed ChatGPT UI operations; no browser-task tool or arbitrary JS IPC. */
export class ChatChrome implements ChatBrowser {
  onclose?:()=>void;
  private cdp:CdpConnection|null=null; private session=''; private world=0; private document=''; private verifiedModel=''; private models:string[]=[];
  constructor(private config:BrowserConnectionConfig){}
  async connect(url:string|null=null){
    if(this.cdp)return;
    if(manualWindows.get(this.config.userDataDir)?.exitCode===null)throw Error('登录窗口仍然打开。请手动关闭这个专用窗口，再检查连接。');
    const initial=url&&isChatUrl(url)?url:'https://chatgpt.com/';
    const cdp=await launchOwnedChrome(this.config,initial);this.cdp=cdp;
    cdp.onclose=()=>{if(this.cdp===cdp){this.cdp=null;this.session='';this.world=0;this.onclose?.();}};
    try{
      let {targetInfos}=await cdp.request('Target.getTargets');
      for(let i=0;i<80&&!targetInfos.some((t:any)=>t.type==='page');i++){await new Promise(r=>setTimeout(r,100));({targetInfos}=await cdp.request('Target.getTargets'));}
      // Chrome may report its initial tab before navigation. Reuse that tab instead of making another.
      const target=targetInfos.find((t:any)=>t.type==='page'&&t.url===initial)??targetInfos.find((t:any)=>t.type==='page'&&isChatUrl(t.url))??targetInfos.find((t:any)=>t.type==='page'&&['about:blank','chrome://newtab/',''].includes(t.url));
      const targetId=target?.targetId??(await cdp.request('Target.createTarget',{url:initial})).targetId;
      this.session=(await cdp.request('Target.attachToTarget',{targetId,flatten:true})).sessionId;
      await cdp.request('Page.enable',{},this.session);
      if(target&&target.url!==initial){const existing=await this.read();if(existing.draft.trim()||existing.generating)throw Error('专用窗口有未完成内容，请先处理草稿或回复。');await this.navigate(initial);}
      const deadline=Date.now()+20000;
      while(Date.now()<deadline){const state=await this.read();if(state.loggedIn&&state.effort&&(!/\/c\//.test(initial)||state.messages.length))break;await new Promise(r=>setTimeout(r,250));}
      await this.closeExtraTabs(targetId);
    }catch(error){await this.close();throw error;}
  }
  private async closeExtraTabs(keep:string){
    const cdp=this.rpc();const {targetInfos}=await cdp.request('Target.getTargets');
    for(const target of targetInfos.filter((t:any)=>t.type==='page'&&t.targetId!==keep)){
      if(['about:blank','chrome://newtab/'].includes(target.url)){await cdp.request('Target.closeTarget',{targetId:target.targetId});continue;}
      if(!isChatUrl(target.url))continue; // Never close an authentication page.
      let session='';
      try{
        session=(await cdp.request('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
        const {frameTree}=await cdp.request('Page.getFrameTree',{},session);
        if(!isChatUrl(frameTree.frame.url))continue;
        const {executionContextId}=await cdp.request('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'dragon-chat-tab-check'},session);
        const result=await cdp.request('Runtime.evaluate',{expression:`(() => {const __name=value=>value;const state=(${readChatPage.toString()})();return {safe:state.loggedIn&&!state.draft.trim()&&!state.generating};})()`,contextId:executionContextId,returnByValue:true},session);
        if(result.result?.value?.safe)await cdp.request('Target.closeTarget',{targetId:target.targetId});
      }catch{/* Unreadable tabs are retained. */}finally{if(session)await cdp.request('Target.detachFromTarget',{sessionId:session}).catch(()=>{});}
    }
  }
  private rpc(){if(!this.cdp)throw Error('普通 Chat 已断开，请重新连接。');return this.cdp;}
  private async location(){const {frameTree}=await this.rpc().request('Page.getFrameTree',{},this.session);return frameTree.frame;}
  private async evaluate<T=any>(expression:string):Promise<T>{
    const frame=await this.location();if(!frame.url.startsWith('https://chatgpt.com/'))throw Error('请先在普通登录窗口完成登录，再返回 ChatGPT。');
    const key=frame.id+':'+frame.loaderId;
    if(key!==this.document||!this.world){this.world=(await this.rpc().request('Page.createIsolatedWorld',{frameId:frame.id,worldName:'dragon-chat-ui'} ,this.session)).executionContextId;this.document=key;}
    const result=await this.rpc().request('Runtime.evaluate',{expression,contextId:this.world,returnByValue:true,awaitPromise:true},this.session);
    if(result.exceptionDetails)throw Error('ChatGPT 页面已变化，无法核对这次操作。请显示页面检查后重试。');return result.result.value;
  }
  async read():Promise<ChatPageState>{
    const frame=await this.location();
    if(!frame.url.startsWith('https://chatgpt.com/'))return {url:frame.url?new URL(frame.url).origin:'',loggedIn:false,mode:'unknown',model:'',effort:'',draft:'',generating:false,messages:[],problem:null,controls:[]};
    const state=await this.evaluate<ChatPageState>(`(() => { const __name = value => value; return (${readChatPage.toString()})(); })()`);
    return {...state,model:state.model||this.verifiedModel,models:this.models};
  }
  async show(){await this.rpc().request('Page.bringToFront',{},this.session);}
  async navigate(url:string){
    if(!isChatUrl(url))throw Error('普通 Chat 对话地址无效。');
    const result=await this.rpc().request('Page.navigate',{url},this.session);if(result.errorText)throw Error(result.errorText);
    this.document='';this.world=0;this.verifiedModel='';
    const until=Date.now()+20000;while(Date.now()<until){const frame=await this.location();if(frame.url===url){try{const page=await this.read();if(page.loggedIn&&page.effort&&(!/\/c\//.test(url)||page.messages.length))return;}catch{}}await new Promise(r=>setTimeout(r,200));}
  }
  private async clickControl(label:string,testId=''){
    const found=await this.evaluate(`(() => {const all=Array.from(document.querySelectorAll('button,[role="menuitem"],[role="menuitemradio"],[role="option"],[role="tab"]'));const matches=all.filter(e=>{const r=e.getBoundingClientRect();return !e.closest('[inert],[aria-hidden="true"]')&&r.width&&r.height&&(${testId?`e.getAttribute('data-testid')===${JSON.stringify(testId)}`:`(e.getAttribute('aria-label')||e.innerText||e.getAttribute('title')||'').trim()===${JSON.stringify(label)}`});});if(matches.length!==1)return null;const e=matches[0];if(e.disabled)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    if(!found)throw Error('ChatGPT 控件无法唯一识别，请在专用窗口选择普通 Chat 和高档位。');
    await this.rpc().request('Input.dispatchMouseEvent',{type:'mousePressed',...found,button:'left',clickCount:1},this.session);
    await this.rpc().request('Input.dispatchMouseEvent',{type:'mouseReleased',...found,button:'left',clickCount:1},this.session);
    await new Promise(r=>setTimeout(r,400));
  }
  private async key(key:string,code=key){for(const type of ['keyDown','keyUp'])await this.rpc().request('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:key==='Escape'?27:key==='ArrowRight'?39:37},this.session);}
  async configure(model:string, retry=true):Promise<ChatPageState>{
    let state=await this.read();if(!state.loggedIn||state.generating)return state;
    if(state.mode!=='chat')return state; // Never change an existing Work conversation into Chat.
    const picker=state.controls.find(c=>/^(选择 ChatGPT 模型|Select ChatGPT model)$/.test(c.label)||/model-switcher/.test(c.testId));
    if(!picker)return {...state,model:''};
    this.verifiedModel='';
    await this.clickControl(picker.label,picker.testId);
    let changedModel=false;
    try {
      const toggle=await this.evaluate<string|null>(`(() => {const e=document.querySelector('[data-model-picker-view-toggle]');return e&&!e.closest('[inert],[aria-hidden="true"]')?e.getAttribute('aria-label'):null;})()`);
      if(toggle)await this.clickControl(toggle);
      state=await this.read();
      const models=state.controls.filter(c=>c.role==='menuitemradio'&&/^GPT-/i.test(c.label));
      this.models=models.map(c=>c.label);
      const selected=models.find(c=>c.selected);
      if(model&&selected?.label!==model){const choice=models.find(c=>c.label===model);if(!choice||!retry)return {...state,model:''};await this.clickControl(choice.label);changedModel=true;}
      else this.verifiedModel=selected?.label||'';
    }finally{await this.key('Escape');await new Promise(r=>setTimeout(r,400));}
    if(changedModel)return this.configure(model,false);
    state=await this.read();
    if(state.effort!=='high'){
      await this.clickControl(picker.label,picker.testId);
      try {
        const slider=await this.evaluate<boolean>(`(() => {const e=document.querySelector('[data-reasoning-slider]');if(!e||e.closest('[inert]'))return false;e.focus();return true;})()`);
        if(slider)for(let i=0;i<8;i++){state=await this.read();if(state.effort==='high')break;await this.key(['xhigh','max','ultra'].includes(state.effort)?'ArrowLeft':'ArrowRight');await new Promise(r=>setTimeout(r,100));}
      }finally{await this.key('Escape');}
    }
    return this.read();
  }
  async send(text:string,model:string,beforeDispatch:()=>Promise<void>){
    const before=await this.configure(model);
    if(!before.loggedIn||before.mode!=='chat'||before.effort!=='high'||!before.model||before.model!==model)throw Error('尚未确认普通 Chat 模式、所选模型和高思考档位；没有发送。');
    if(before.generating||before.draft.trim())throw Error('专用 Chat 对话正在生成或有未发送草稿，请先在窗口处理；没有覆盖或发送。');
    await this.evaluate(`(() => {const e=document.querySelector('#prompt-textarea,textarea[name="prompt-textarea"],[contenteditable="true"][role="textbox"]');if(!e||e.disabled||((e.value||e.innerText||'').trim()))throw Error('draft');e.focus();})()`);
    let dispatched=false;
    try {
    await this.rpc().request('Input.insertText',{text},this.session);
    const filled=await this.configure(model);
    if(normalizedMessage(filled.draft)!==normalizedMessage(text)||filled.mode!=='chat'||filled.effort!=='high'||filled.model!==model||filled.url!==before.url)throw Error('填入内容或模式已变化，内容保留为草稿，没有点击发送。');
    const send=filled.controls.find(c=>c.testId==='send-button'||/^(Send prompt|Send message|发送消息|发送提示词|发送)$/.test(c.label));
    if(!send)throw Error('没有找到唯一发送按钮，内容已保留为草稿。');
    await beforeDispatch();dispatched=true;await this.clickControl(send.label,send.testId);
    }catch(error){if(!dispatched)await this.discardDraft(text).catch(()=>false);throw error;}
  }
  async discardDraft(text:string):Promise<boolean>{
    const state=await this.read();if(state.generating||normalizedMessage(state.draft)!==normalizedMessage(text))return false;
    await this.evaluate(`(() => {const e=document.querySelector('[contenteditable="true"][role="textbox"],#prompt-textarea');if(!e)throw Error('composer');e.focus();if(e.select)e.select();else{const r=document.createRange();r.selectNodeContents(e);getSelection().removeAllRanges();getSelection().addRange(r);}})()`);
    for(const type of ['keyDown','keyUp'])await this.rpc().request('Input.dispatchKeyEvent',{type,key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8},this.session);
    return !(await this.read()).draft.trim();
  }
  async stop(){const state=await this.read();const button=state.controls.find(c=>/stop-button|stop-generating/.test(c.testId)||/^(Stop generating|Stop streaming|停止生成|停止回答|停止)$/.test(c.label));if(button)await this.clickControl(button.label,button.testId);}
  async close(){const cdp=this.cdp;this.cdp=null;this.session='';this.world=0;if(cdp)await cdp.close();}
}

/** Login is deliberately an ordinary Chrome launch, with no CDP/debugging flags.
 * The user closes this window; there is no success detector that can close OAuth. */
export async function openManualChatLogin(config:BrowserConnectionConfig):Promise<void>{
  if(manualWindows.get(config.userDataDir)?.exitCode===null)return;
  await mkdir(config.userDataDir,{recursive:true});
  await new Promise<void>((resolve,reject)=>{const child=spawn(config.executablePath,[`--user-data-dir=${config.userDataDir}`,'--profile-directory=Default','--no-first-run','--no-default-browser-check','https://chatgpt.com/'],{detached:true,stdio:'ignore',windowsHide:false});child.once('error',reject);child.once('spawn',()=>{manualWindows.set(config.userDataDir,child);child.once('exit',()=>{if(manualWindows.get(config.userDataDir)===child)manualWindows.delete(config.userDataDir);});child.unref();resolve();});});
}
