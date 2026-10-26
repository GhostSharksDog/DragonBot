/** Only visible, bounded ChatGPT UI is read. Authentication pages are never inspected. */
export interface ChatPageMessage { id: string; role: 'user' | 'assistant'; text: string; complete?: boolean }
export interface ChatPageState {
  url: string; loggedIn: boolean; mode: 'chat' | 'work' | 'unknown'; model: string; effort: string;
  draft: string; generating: boolean; messages: ChatPageMessage[]; problem: string | null;
  controls: {label:string;testId:string;role:string;selected:boolean}[];
  models?: string[];
}

export function readChatPage(): ChatPageState {
  const visible = (e: Element) => {const r=e.getBoundingClientRect();const s=getComputedStyle(e);return !e.closest('[inert],[aria-hidden="true"]')&&r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
  const url = location.origin + location.pathname;
  if (location.origin !== 'https://chatgpt.com') return {url,loggedIn:false,mode:'unknown',model:'',effort:'',draft:'',generating:false,messages:[],problem:null,controls:[]};
  const label = (e: Element) => (e.getAttribute('aria-label') || (e as HTMLElement).innerText || e.getAttribute('title') || '').trim();
  const controls = Array.from(document.querySelectorAll('button,[role="switch"],[role="tab"],[role="menuitemradio"],[role="option"]')).filter(visible).map(e=>({label:label(e).slice(0,160),testId:e.getAttribute('data-testid')||'',role:e.getAttribute('role')||e.tagName.toLowerCase(),selected:e.getAttribute('aria-checked')==='true'||e.getAttribute('aria-pressed')==='true'||e.getAttribute('aria-selected')==='true'||e.getAttribute('data-state')==='checked'}));
  const composer = Array.from(document.querySelectorAll<HTMLElement>('#prompt-textarea,textarea[name="prompt-textarea"],[contenteditable="true"][role="textbox"]')).find(visible);
  // ProseMirror's innerText inserts layout-dependent blank lines between paragraphs.
  // Read its plain document structure so identical drafts compare identically.
  const plainNode=(node:Node):string=>node.nodeType===Node.TEXT_NODE?node.textContent||'':node instanceof HTMLBRElement?node.classList.contains('ProseMirror-trailingBreak')?'':'\n':Array.from(node.childNodes).map(plainNode).join('');
  const draft=composer?.tagName==='TEXTAREA'?(composer as HTMLTextAreaElement).value:composer?Array.from(composer.childNodes).map(plainNode).join('\n'):'';
  const profile = document.querySelector('[data-testid="accounts-profile-button"],[data-testid="profile-button"],button[aria-label="Open profile menu"],button[aria-label="打开个人资料菜单"]');
  const loggedIn=Boolean(composer&&profile&&!controls.some(c=>/^(?:登录|登入|Log in|Sign in|注册|Sign up)$/.test(c.label)));
  const workSwitch=Array.from(document.querySelectorAll('[role="switch"]')).find(e=>/Work|工作模式/.test(label(e)));
  const activeMode=controls.find(c=>c.selected&&/^(?:Chat|聊天|Work|工作)$/.test(c.label));
  const chatTranscript=Boolean(document.querySelector('[data-chatgpt-conversation-selection-target]'));
  const mode:ChatPageState['mode']=activeMode ? /Work|工作/.test(activeMode.label)?'work':'chat' : workSwitch ? workSwitch.getAttribute('aria-checked')==='false'?'chat':'work' : chatTranscript&&/^\/c\//.test(location.pathname)?'chat':'unknown';
  const modelControl=controls.find(c=>c.testId==='model-switcher-dropdown-button'||c.testId==='model-switcher-button'||/^(?:Model selector|模型选择器)/i.test(c.label));
  const model=controls.find(c=>c.role==='menuitemradio'&&c.selected&&/^GPT-/i.test(c.label))?.label||modelControl?.label.replace(/^(?:Model selector,?\s*(?:current model is\s*)?|模型选择器[，,:：]?\s*)/i,'')||'';
  const effortControl=controls.find(c=>/(?:reasoning|thinking|effort|intelligence|思考|推理|智能)/i.test(c.testId+' '+c.label)&&/(?:\bHigh\b|高(?:级)?|深度)/i.test(c.label));
  const effort=document.querySelector('[data-composer-navigation-target="reasoning"]')?.getAttribute('data-selected-reasoning-effort')||(effortControl&&!/(?:Extra High|最高|超高|Max|Ultra)/i.test(effortControl.label)?'high':'');
  const messages=Array.from(document.querySelectorAll('[data-message-author-role],[data-chatgpt-search-unit-key]')).filter(e=>['user','assistant'].includes(e.getAttribute('data-message-author-role')||e.getAttribute('data-chatgpt-search-unit-key')?.split(':').at(-1)||'')).slice(-40).map(e=>({id:e.getAttribute('data-message-id')||e.getAttribute('data-chatgpt-search-message-ids')?.split(' ')[0]||e.closest('[data-turn-id]')?.getAttribute('data-turn-id')||'',role:(e.getAttribute('data-message-author-role')||e.getAttribute('data-chatgpt-search-unit-key')?.split(':').at(-1)) as 'user'|'assistant',complete:e.closest('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state')==='complete',text:((e.querySelector('[data-user-message-bubble], [data-markdown-text-style="assistant-message"],.markdown,.whitespace-pre-wrap')||e) as HTMLElement).innerText?.slice(0,50000)||''}));
  const problem=Array.from(document.querySelectorAll('[role="alert"]')).filter(visible).map(e=>(e as HTMLElement).innerText).find(t=>/limit|too many|出了点|出错|上限|限制|try again|something went wrong/i.test(t))?.slice(0,600)||null;
  return {url,loggedIn,mode,model,effort,draft,generating:controls.some(c=>/stop-button|stop-generating/.test(c.testId)||/^(?:Stop generating|Stop streaming|停止生成|停止回答|停止)$/.test(c.label)),messages,problem,controls};
}

export function isChatUrl(value: string): boolean {try{const u=new URL(value);return u.origin==='https://chatgpt.com'&&/^\/(?:c\/[a-zA-Z0-9-]+)?\/?$/.test(u.pathname)&&!u.username&&!u.password;}catch{return false;}}
export const normalizedMessage=(text:string)=>text.replace(/\r\n/g,'\n').trim();
