import type { AppSnapshot } from '../shared/types';
import type { SendMode } from '../shared/chat';

export function SendModePicker({value,disabled,change}:{value:SendMode;disabled?:boolean;change(value:SendMode):void}){
  return <select className="chat-mode-picker" aria-label="消息通道" title="自动：闲聊走 Chat，操作任务走 Codex" value={value} disabled={disabled} onChange={e=>change(e.target.value as SendMode)}><option value="auto">自动</option><option value="chat">聊天</option><option value="task">做事</option></select>;
}
export function ChatActions({snapshot,perform,compact=false}:{snapshot:AppSnapshot;perform(key:string,operation:()=>Promise<unknown>):Promise<boolean>;compact?:boolean}){
  const chat=snapshot.chat;if(!chat)return null;
  if(compact&&chat.status==='disconnected'&&!chat.error)return null;
  const blocked=['login-required','setup-required','uncertain','error','disconnected'].includes(chat.status);
  const act=(name:string,fn:()=>Promise<void>)=>{void perform('chat:'+name,fn);};
  return <div className={compact?'chat-actions compact':'chat-actions'}>
    {(!compact||blocked)&&<p className="field-hint" role="status">{chat.message}</p>}
    {chat.active?<button className="text-button" onClick={()=>act('stop',()=>window.pet.stopChat())}>停止回复</button>:<>
      {(!compact||blocked)&&<button className="text-button" disabled={chat.status==='connecting'} onClick={()=>act('check',()=>window.pet.checkChat())}>{chat.status==='uncertain'?'核对结果':'检查连接'}</button>}
      {(!compact||blocked)&&<button className="text-button" onClick={()=>act('show',()=>window.pet.showChat())}>显示聊天窗口</button>}
      {(!compact||chat.status==='login-required')&&<button className="text-button" onClick={()=>act('login',()=>window.pet.loginChat())}>登录 ChatGPT</button>}
      {chat.status==='uncertain'&&<button className="text-button" onClick={()=>act('not-sent',()=>window.pet.confirmChatNotSent())}>我已核对，确实未发送</button>}
    </>}
  </div>;
}
