import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatConversation, ChatSettings, ChatSnapshot } from '../../shared/chat';
import type { ChatMessage } from '../../shared/types';
import type { ChatBrowser } from './browser';
import { isChatUrl, normalizedMessage, type ChatPageState } from './page';

interface Outbox {
  id:string; conversationId:string; text:string; wire:string; beforeIds:string[];
  url:string; dispatched:boolean; userId?:string; responseId?:string; createdAt:number;
}
interface Options {
  dataDir:string; getSettings():ChatSettings; saveModel(model:string):void;
  createBrowser():Promise<ChatBrowser>; openLogin():Promise<void>; changed():void;
  pollMs?:number; timeoutMs?:number;
}
const INITIAL:ChatSnapshot={status:'disconnected',message:'普通 Chat 尚未连接',model:'',effort:'',conversationId:null,messages:[],conversations:[],error:null,active:false,models:[]};
const concise='请作为桌宠陪我聊天：默认用简短中文回答，通常 1–3 句；需要详细解释时再展开。只做文字对话，不使用工具。\n\n';

/** Separate browser, outbox and history. This class has no Codex or task tools. */
export class ChatService {
  private state:ChatSnapshot=structuredClone(INITIAL);
  private conversations:ChatConversation[]=[];
  private current:ChatConversation|null=null;
  private outbox:Outbox|null=null;
  private browser:ChatBrowser|null=null;
  private connecting:Promise<void>|null=null;
  private timer:NodeJS.Timeout|undefined;
  private polling=false; private disposed=false; private busy=false; private generation=0;
  private file:string; private lastText=''; private stableSince=0;
  private unavailableSince=0;
  private reconcileStarted=0;
  private loggingIn=false;
  constructor(private options:Options){
    this.file=path.join(options.dataDir,'chat','history.json');
    try {
      const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));
      this.conversations=Array.isArray(saved.conversations)?saved.conversations.filter((c:any)=>typeof c.id==='string'&&typeof c.title==='string'&&Array.isArray(c.messages)&&(!c.url||isChatUrl(c.url))).slice(-100):[];
      this.current=this.conversations.find(c=>c.id===saved.currentId)||null;
      if(saved.outbox&&this.current&&saved.outbox.conversationId===this.current.id&&Array.isArray(saved.outbox.beforeIds)&&typeof saved.outbox.wire==='string'&&isChatUrl(saved.outbox.url)){
        this.outbox=saved.outbox;this.state.status='uncertain';this.state.message='上次聊天尚未核对，请检查结果；不会自动重发。';
      }
    }catch{/* First launch has no Chat history. */}
  }
  getSnapshot():ChatSnapshot{return structuredClone({...this.state,conversationId:this.current?.id??null,messages:this.current?.messages??[],conversations:this.conversations.map(c=>({id:c.id,title:c.title,updatedAt:c.updatedAt})).reverse()});}
  private publish(patch:Partial<ChatSnapshot>={}){this.state={...this.state,...patch};this.options.changed();}
  private save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify({currentId:this.current?.id??null,conversations:this.conversations,outbox:this.outbox}));fs.renameSync(this.file+'.tmp',this.file);}
  private assertIdle(){if(this.busy||this.state.active||this.outbox)throw Error('先停止或核对当前普通聊天，再进行这个操作。');}
  private schedule(){clearTimeout(this.timer);if(this.outbox&&!this.disposed)this.timer=setTimeout(()=>{void this.poll();},this.options.pollMs??400);}
  private issue(error:unknown){const message=error instanceof Error?error.message:'普通 Chat 暂不可用。';this.publish({status:this.outbox?'uncertain':'error',active:false,error:message,message});}
  async connect(){
    if(this.loggingIn)throw Error('正在打开登录窗口，请完成登录并手动关闭窗口后再检查。');
    if(this.connecting)return this.connecting;
    if(this.busy||this.state.active)return;
    this.connecting=this.establish();try{await this.connecting;}finally{this.connecting=null;}
  }
  private async establish(){
    this.publish({status:'connecting',message:'正在检查普通 Chat…',error:null});
    try {
      if(!this.browser){
        const browser=await this.options.createBrowser();this.browser=browser;
        browser.onclose=()=>{if(this.browser!==browser)return;this.browser=null;++this.generation;clearTimeout(this.timer);this.publish({status:this.outbox?'uncertain':'disconnected',active:false,message:this.outbox?'连接中断，请核对消息结果，不会自动重发。':'普通 Chat 窗口已关闭',error:null});};
        try{await browser.connect(this.current?.url);}catch(error){this.browser=null;await browser.close();throw error;}
      }
      if(this.outbox){
        let page=await this.browser.read();
        if(!page.messages.some(m=>m.role==='user'&&normalizedMessage(m.text)===normalizedMessage(this.outbox!.wire))&&this.browser.recover){
          const recovered=await this.browser.recover(this.outbox.wire);if(recovered){page=recovered;this.current!.url=page.url;this.save();}
        }
        this.reconcileStarted=Date.now();await this.reconcile(page);if(this.outbox)return;
      }
      if(this.current?.lastWire&&this.browser.recover){
        const page=await this.browser.read(),lastUser=[...this.current.messages].reverse().find(m=>m.role==='user');
        if(lastUser&&!page.messages.some(m=>m.id===lastUser.id)){
          const recovered=await this.browser.recover(this.current.lastWire);
          if(!recovered){this.publish({status:'setup-required',active:false,message:'暂时无法找到已保存的普通聊天，请显示窗口核对，或明确开始新聊天。'});return;}
          this.current.url=recovered.url;this.save();
        }
      }
      const page=await this.browser.configure(this.options.getSettings().model);
      this.applySetup(page);
    }catch(error){this.issue(error);throw error;}
  }
  private applySetup(page:ChatPageState){
    if(!page.loggedIn){this.publish({status:'login-required',message:'请打开登录窗口。登录后手动关闭该窗口，再点击“检查连接”。',active:false,error:null});return;}
    if(page.mode!=='chat'||!page.model||page.effort!=='high'){
      this.publish({status:'setup-required',message:'请在专用窗口选择普通“聊天”、可用模型和 High，再检查连接。',model:page.model,effort:page.effort,models:page.models,active:false,error:null});return;
    }
    if(!this.options.getSettings().model)this.options.saveModel(page.model);
    this.publish({status:'ready',message:`普通 Chat · ${page.model} · High`,model:page.model,effort:page.effort,models:page.models,active:false,error:null});
  }
  async login(){
    if(this.loggingIn)return;
    if(this.busy||this.state.active||this.connecting)throw Error('请先停止当前回复，再打开登录窗口。');
    this.loggingIn=true;
    try{
    const browser=this.browser;this.browser=null;++this.generation;await browser?.close();
    await this.options.openLogin();
    this.publish({status:'login-required',message:'请在普通 Chrome 窗口登录；完成后手动关闭这个窗口，再点“检查连接”。',error:null});
    }finally{this.loggingIn=false;}
  }
  async show(){if(!this.browser)await this.connect();await this.browser?.show();}
  async check(){if(this.state.active){await this.poll();return;}await this.connect();}
  async newConversation(){this.assertIdle();if(this.connecting)throw Error('正在连接，请稍候。');if(this.browser)await this.browser.navigate('https://chatgpt.com/');this.current=null;this.save();this.publish({error:null,status:this.browser?'setup-required':'disconnected',message:'新的普通聊天'});}
  async resume(id:string){
    this.assertIdle();if(this.connecting)throw Error('正在连接，请稍候。');
    const conversation=this.conversations.find(c=>c.id===id);if(!conversation)throw Error('普通聊天记录不存在。');
    if(this.browser)await this.browser.navigate(conversation.url||'https://chatgpt.com/');
    this.current=conversation;this.save();this.publish({error:null,status:this.browser?'setup-required':'disconnected',message:'已恢复普通聊天，请发送或检查连接。'});
  }
  async send(text:string){
    if(typeof text!=='string'||!text.trim()||text.length>32000)throw Error('请输入 1–32000 字。');
    this.assertIdle();await this.connect();this.assertIdle();
    if(this.state.status!=='ready'||!this.browser)throw Error(this.state.message);
    this.busy=true;const browser=this.browser;let prepared:Outbox|null=null;
    try {
      this.publish({status:'sending',active:true,error:null,message:'正在发送普通聊天…'});
      const before=await browser.read();
      if(this.current?.url&&this.current.url!==before.url){
        const lastUser=[...this.current.messages].reverse().find(m=>m.role==='user');
        if(/local-chatgpt/.test(this.current.url)&&lastUser&&before.messages.some(m=>m.id===lastUser.id)&&isChatUrl(before.url)){this.current.url=before.url;this.save();}
        else throw Error('专用窗口切换了对话，请检查连接后再发送。');
      }
      if(!this.current&&before.messages.length)throw Error('专用窗口有其他对话，请点击“新聊天”，不会写入原有对话。');
      if(before.draft.trim()||before.generating)throw Error('专用窗口有草稿或正在生成，请先处理；没有覆盖内容。');
      if(before.messages.some(m=>!m.id))throw Error('网页消息编号无法识别，请检查页面；没有发送。');
      if(!this.current){this.current={id:randomUUID(),title:text.trim().slice(0,40),url:null,messages:[],updatedAt:Date.now()};this.conversations.push(this.current);}
      const id=randomUUID();
      const wire=(this.current.messages.length?'':concise)+text.trim()+`\n\n[桌宠消息编号：${id}。此编号仅用于核对，请勿在回复中复述。]`;
      prepared={id,conversationId:this.current.id,text:text.trim(),wire,beforeIds:before.messages.map(m=>m.id),url:before.url,dispatched:false,createdAt:Date.now()};
      this.outbox=prepared;this.reconcileStarted=Date.now();this.save();
      await browser.send(wire,this.state.model,async()=>{prepared!.dispatched=true;this.save();});
      // Dispatch completed; only reads follow. Sending is never retried automatically.
      this.publish({status:'streaming',message:'正在等待普通 Chat 回复…'});this.schedule();
    }catch(error){
      if(prepared&&!prepared.dispatched){this.outbox=null;this.save();}
      this.issue(error);throw error;
    }finally{this.busy=false;}
  }
  private async reconcile(page:ChatPageState){
    const box=this.outbox,conversation=this.current;if(!box||!conversation)return;
    if(!conversation.url&&isChatUrl(page.url)&&/\/c\//.test(page.url)){conversation.url=page.url;this.save();}
    if(!page.loggedIn||!isChatUrl(page.url)){
      this.unavailableSince ||= Date.now();
      if(isChatUrl(page.url)&&Date.now()-this.unavailableSince<20000){this.publish({status:'streaming',active:true,message:'正在等待聊天页面加载…'});this.schedule();return;}
      throw Error('普通 Chat 登录失效或页面未能加载。请核对专用窗口，消息不会重发。');
    }
    this.unavailableSince=0;
    if(conversation.url&&conversation.url!==page.url){
      if(/local-chatgpt/.test(conversation.url)&&page.messages.some(m=>m.role==='user'&&(m.id===box.userId||normalizedMessage(m.text)===normalizedMessage(box.wire)))){conversation.url=page.url;this.save();}
      else throw Error('专用窗口已切换对话；请回到这次聊天核对结果。');
    }
    const matches=page.messages.filter(m=>m.role==='user'&&!box.beforeIds.includes(m.id)&&normalizedMessage(m.text)===normalizedMessage(box.wire));
    const user=box.userId?page.messages.find(m=>m.id===box.userId&&m.role==='user'):matches.length===1?matches[0]:null;
    if(!user?.id){
      if(Date.now()-this.reconcileStarted<15000){this.publish({status:'sending',active:true,message:'正在核对普通 Chat 是否已发送…'});this.schedule();return;}
      this.publish({status:'uncertain',active:false,message:'暂时无法确认发送结果。请检查专用窗口后核对；不会自动重发。',error:null});return;
    }
    box.userId=user.id;if(/\/c\//.test(page.url))conversation.url=page.url;
    if(!conversation.messages.some(m=>m.id===user.id))conversation.messages.push({id:user.id,role:'user',text:box.text,channel:'chat',createdAt:box.createdAt});
    const at=page.messages.findIndex(m=>m.id===user.id),after=page.messages.slice(at+1);
    if(after.some(m=>m.role==='user'))throw Error('这次消息后出现了其他输入，请在专用窗口核对；不会把别的回复当作结果。');
    const response=after.filter(m=>m.role==='assistant'&&m.id&&!box.beforeIds.includes(m.id)).at(-1);
    if(response?.text){
      box.responseId=response.id;const existing=conversation.messages.find(m=>m.id===response.id);
      if(existing)existing.text=response.text;else conversation.messages.push({id:response.id,role:'assistant',text:response.text,channel:'chat',createdAt:Date.now()});
      if(this.lastText!==response.text){this.lastText=response.text;this.stableSince=Date.now();}
      // An explicit completed turn is preferred; legacy pages require a stable reply and its action bar.
      const complete=!page.generating&&(response.complete===true||(Date.now()-this.stableSince>1800&&page.controls.some(c=>/^(重新生成回复|Regenerate response)$/.test(c.label))));
      if(complete){conversation.lastWire=box.wire;this.outbox=null;conversation.updatedAt=Date.now();this.save();this.publish({status:'ready',active:false,message:'普通 Chat 已回复',error:null});return;}
    }
    if(page.problem)throw Error(page.problem);
    if(Date.now()-box.createdAt>(this.options.timeoutMs??180000)&&Date.now()-this.reconcileStarted>15000)throw Error('等待普通 Chat 回复超时。请核对结果；不会重发或改用 Codex。');
    this.save();this.publish({status:'streaming',active:true,message:'普通 Chat 正在回复…',error:null});this.schedule();
  }
  private async poll(){
    if(this.polling||!this.outbox||!this.browser||this.disposed)return;
    this.polling=true;const browser=this.browser,generation=this.generation;
    try{const page=await browser.read();if(generation===this.generation&&browser===this.browser)await this.reconcile(page);}catch(error){if(generation===this.generation)this.issue(error);}finally{this.polling=false;}
  }
  async stop(){
    if(this.busy)throw Error('正在确认发送，请稍后停止。');
    clearTimeout(this.timer);await this.browser?.stop();
    if(this.outbox){await this.poll();if(this.outbox?.userId&&this.browser){const page=await this.browser.read();if(!page.generating&&page.messages.some(m=>m.id===this.outbox?.userId)){this.outbox=null;this.save();this.publish({status:'ready',active:false,message:'已停止普通 Chat 回复。'});}}
      if(this.outbox)this.publish({status:'uncertain',active:false,message:'已请求停止，请核对页面结果；不会自动重发。'});}
    clearTimeout(this.timer);
  }
  async confirmNotSent(){
    if(this.busy||this.state.active)throw Error('请先停止普通 Chat。');
    if(!this.outbox)return;if(this.outbox.userId)throw Error('已经确认发出，请检查回复，不能标记为未发送。');
    this.outbox=null;this.save();this.publish({status:'disconnected',active:false,error:null,message:'已记录你确认未发送；可重新输入。网页草稿不会被覆盖。'});
  }
  async dispose(){this.disposed=true;++this.generation;clearTimeout(this.timer);this.save();const browser=this.browser;this.browser=null;await browser?.close();}
}
