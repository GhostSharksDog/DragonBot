import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { BrowserClient, McpResult } from './browser';
import type { BrowserConnectionConfig } from '../../shared/types';

/** A private Chrome pipe, never a discoverable TCP debugging port or a daily Chrome profile. */
export class CdpConnection {
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private closed = false;
  onclose?: () => void;
  constructor(private child: ChildProcess, private input: Writable, output: Readable) {
    output.on('data', (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > 32 * 1024 * 1024) { this.fail(new Error('浏览器响应过大。')); return; }
      let end: number;
      while ((end = this.buffer.indexOf(0)) >= 0) {
        const frame = this.buffer.subarray(0, end).toString('utf8'); this.buffer = this.buffer.subarray(end + 1);
        try {
          const message = JSON.parse(frame), request = this.pending.get(message.id);
          if (request) { this.pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
        } catch { this.fail(new Error('浏览器控制通道响应无效。')); }
      }
    });
    output.on('end', () => this.fail(new Error('独立浏览器已关闭，请重新连接并读取页面。')));
    output.on('error', error => this.fail(error)); input.on('error', error => this.fail(error));
    child.once('error', error => this.fail(error)); child.once('exit', () => this.fail(new Error('独立浏览器已退出。')));
  }
  request<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeout = 12000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('独立浏览器连接已关闭。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时。操作不会自动重试，请先检查页面。`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => { if (error) this.fail(error); });
    });
  }
  private fail(error: Error) {
    if (this.closed) return; this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); } this.pending.clear(); this.onclose?.();
  }
  async close() {
    if (!this.closed) await this.request('Browser.close', {}, undefined, 3000).catch(() => {});
    this.fail(new Error('独立浏览器连接已关闭。'));
    // This is only the process created with our private pipe, never an existing user browser.
    if (this.child.exitCode === null) await new Promise<void>(resolve => { const timeout = setTimeout(() => { this.child.kill(); resolve(); }, 2500); this.child.once('exit', () => { clearTimeout(timeout); resolve(); }); });
  }
}

const SNAPSHOT = `(() => {
  const state = globalThis.__dragonPage ??= { refs: new Map(), ids: new WeakMap(), counter: 0 };
  state.refs.clear();
  const visible = e => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none'; };
  const controls = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="tab"],[contenteditable="true"]')).filter(visible).slice(0, 300);
  const elements = controls.map(e => {
    let ref = state.ids.get(e); if (!ref) { ref = 'e' + (++state.counter); state.ids.set(e, ref); } state.refs.set(ref, e);
    const tag = e.tagName.toLowerCase(), type = e.getAttribute('type') || '';
    const role = e.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'select' ? 'combobox' : tag === 'textarea' || tag === 'input' ? 'textbox' : 'button');
    const label = (e.getAttribute('aria-label') || e.labels?.[0]?.innerText || e.innerText || e.getAttribute('placeholder') || e.getAttribute('name') || tag).slice(0, 300);
    return { ref, role: /^[a-z-]+$/.test(role) ? role : 'element', label, disabled: Boolean(e.disabled), value: type === 'password' ? '[密码已隐藏]' : 'value' in e ? String(e.value).slice(0,500) : null, href: tag === 'a' && /^https?:/.test(e.href) ? e.href : null, options: tag === 'select' ? Array.from(e.options).map(o => ({ value:o.value,label:o.label })).slice(0,50) : undefined };
  });
  return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 24000), elements, frames: document.querySelectorAll('iframe').length };
})()`;

export class OwnedChromeClient implements BrowserClient {
  targetKey = 'ref' as const;
  owned = true;
  onclose?: () => void;
  private session = '';
  private target = '';
  private world = 0;
  private frame = '';
  private documentKey = '';
  private links = new Map<string, string>();
  constructor(private cdp: CdpConnection) { cdp.onclose = () => this.onclose?.(); }
  async initialize() {
    let { targetInfos } = await this.cdp.request('Target.getTargets');
    for(let i=0;i<80&&!targetInfos.some((item:any)=>item.type==='page');i++){await new Promise(resolve=>setTimeout(resolve,100));({targetInfos}=await this.cdp.request('Target.getTargets'));}
    const target = targetInfos.find((item: any) => item.type === 'page' && /^https?:|^about:blank$/.test(item.url))??targetInfos.find((item:any)=>item.type==='page'&&item.url==='chrome://newtab/');
    this.target = target?.targetId ?? (await this.cdp.request('Target.createTarget', { url: 'about:blank' })).targetId;
    await this.attach();
    if(target?.url==='chrome://newtab/')await this.cdp.request('Page.navigate',{url:'about:blank'},this.session);
    for(const empty of targetInfos.filter((item:any)=>item.type==='page'&&item.targetId!==this.target&&['about:blank','chrome://newtab/'].includes(item.url)))await this.cdp.request('Target.closeTarget',{targetId:empty.targetId});
  }
  private async attach() {
    this.session = (await this.cdp.request('Target.attachToTarget', { targetId: this.target, flatten: true })).sessionId;
    await this.cdp.request('Page.enable', {}, this.session); this.documentKey = ''; this.world = 0;
  }
  private async evaluate(expression: string) {
    const { frameTree } = await this.cdp.request('Page.getFrameTree', {}, this.session);
    const key = frameTree.frame.id + ':' + frameTree.frame.loaderId;
    if (this.documentKey !== key || !this.world) {
      this.frame = frameTree.frame.id;
      this.world = (await this.cdp.request('Page.createIsolatedWorld', { frameId: this.frame, worldName: 'dragon-pet-controlled-dom' }, this.session)).executionContextId;
      this.documentKey = key; this.links.clear();
    }
    const value = await this.cdp.request('Runtime.evaluate', { expression, contextId: this.world, returnByValue: true, awaitPromise: true }, this.session);
    if (value.exceptionDetails) throw new Error('页面已变化或目标无法操作，请重新读取页面。');
    return value.result.value;
  }
  linkTarget(ref: string) { return this.links.get(ref); }
  async show() { await this.cdp.request('Page.bringToFront', {}, this.session); }
  async callTool({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }): Promise<McpResult> {
    if (name === 'browser_tabs') {
      const { targetInfos } = await this.cdp.request('Target.getTargets');
      return this.text(JSON.stringify(targetInfos.filter((t: any) => t.type === 'page' && /^https?:|^about:blank$/.test(t.url)).map((t: any) => ({ id: t.targetId, url: t.url, title: t.title, selected: t.targetId === this.target }))));
    }
    if (name === 'browser_select_tab') {
      const { targetInfos } = await this.cdp.request('Target.getTargets');
      if (!targetInfos.some((t: any) => t.type === 'page' && t.targetId === args.id && /^https?:|^about:blank$/.test(t.url))) throw new Error('标签页已失效。');
      await this.cdp.request('Target.detachFromTarget', { sessionId: this.session }).catch(() => {});
      this.target = String(args.id); await this.attach(); await this.show(); return this.text('已选择标签页，请重新读取快照。');
    }
    if (name === 'browser_snapshot') {
      const data = await this.evaluate(SNAPSHOT);
      this.links = new Map(data.elements.filter((e: any) => e.href).map((e: any) => [e.ref, e.href]));
      return this.text(`- Page URL: ${data.url}\n### Snapshot\n- heading ${JSON.stringify(data.title)}\n` + data.elements.map((e: any) => `- ${e.role} ${JSON.stringify(e.label)} [ref=${e.ref}]: ${JSON.stringify({ disabled: e.disabled, value: e.value, options: e.options })}`).join('\n') + `\n### Page text (untrusted)\n${JSON.stringify(data.text)}\n${data.frames ? '嵌入页面内容不在当前快照内。' : ''}`);
    }
    if (name === 'browser_navigate') {
      const before = this.documentKey;
      const response = await this.cdp.request('Page.navigate', { url: args.url }, this.session);
      if (response.errorText) throw new Error(response.errorText);
      this.documentKey = ''; this.links.clear();
      await this.waitDocument(String(args.url), before); return this.callTool({ name: 'browser_snapshot', arguments: {} });
    }
    if (name === 'browser_scroll') {
      await this.evaluate(`window.scrollBy({top:${JSON.stringify(args.deltaY)},left:0,behavior:'instant'})`);
      return this.text('已滚动，请重新读取页面。');
    }
    if (name === 'browser_screenshot') {
      const { data } = await this.cdp.request('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, this.session);
      return { content: [{ type: 'image', data, mimeType: 'image/png' }] };
    }
    if (typeof args.ref !== 'string' || !/^e\d+$/.test(args.ref)) throw new Error('元素引用无效。');
    const getElement = `const e = globalThis.__dragonPage?.refs.get(${JSON.stringify(args.ref)}); if (!e?.isConnected || e.disabled) throw Error('stale');`;
    const rect = await this.evaluate(`(() => { ${getElement} e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; const top=document.elementFromPoint(x,y); if (top!==e&&!e.contains(top)) throw Error('covered'); return {x,y,tag:e.tagName,type:e.type}; })()`);
    if (name === 'browser_click') {
      const targetUrl = this.links.get(String(args.ref)), before = this.documentKey;
      await this.cdp.request('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, this.session);
      await this.cdp.request('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, this.session);
      if (targetUrl) await this.waitDocument(targetUrl, before);
    } else if (name === 'browser_type') {
      await this.evaluate(`(() => { ${getElement} if (!['INPUT','TEXTAREA'].includes(e.tagName) && !e.isContentEditable) throw Error('not text'); if(['file','submit','button','checkbox','radio'].includes(e.type)) throw Error('not text'); e.focus(); if(e.select) e.select(); else {const r=document.createRange();r.selectNodeContents(e);getSelection().removeAllRanges();getSelection().addRange(r);} })()`);
      await this.cdp.request('Input.insertText', { text: args.text }, this.session);
    } else if (name === 'browser_select_option') {
      await this.evaluate(`(() => { ${getElement} if(e.tagName!=='SELECT')throw Error('not select'); const values=${JSON.stringify(args.values)}; for(const o of e.options)o.selected=values.includes(o.value); e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    } else throw new Error('不支持的浏览器操作。');
    this.links.clear(); return this.text('操作已发送，请重新读取页面确认结果；不会自动重试。');
  }
  private text(text: string) { return { content: [{ type: 'text', text }] }; }
  private async waitDocument(url: string, before: string) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { const state = await this.evaluate('({url:location.href,state:document.readyState})'); if (state.url !== 'about:blank' && state.state !== 'loading' && (state.url === url || Boolean(before && this.documentKey !== before))) return; } catch { this.documentKey = ''; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('网页加载超时，请读取快照确认当前页面；不会重复导航。');
  }
  close() { return this.cdp.close(); }
}

export async function launchOwnedChrome(config: BrowserConnectionConfig, initialUrl = 'about:blank'): Promise<CdpConnection> {
  if (!path.isAbsolute(config.executablePath) || !path.isAbsolute(config.userDataDir) || config.profileDirectory !== 'Default') throw new Error('独立 Chrome 配置无效。');
  await mkdir(config.userDataDir, { recursive: true });
  const profile = await realpath(config.userDataDir);
  if (!profile.toLowerCase().endsWith(`${path.sep}browser-profile`)) throw new Error('仅允许使用桌宠自己的浏览器目录。');
  if(initialUrl!=='about:blank'&&!/^https:\/\/chatgpt\.com\/(?:c\/[a-zA-Z0-9-]+)?\/?$/.test(initialUrl))throw Error('浏览器初始页面无效。');
  const startup=['--restore-last-session'];
  const child = spawn(config.executablePath, [`--user-data-dir=${profile}`, '--profile-directory=Default', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-backgrounding-occluded-windows', ...startup], { windowsHide: false, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const cdp = new CdpConnection(child, child.stdio[3] as Writable, child.stdio[4] as Readable);
  return cdp;
}

export async function connectOwnedChrome(config: BrowserConnectionConfig): Promise<OwnedChromeClient> {
  const cdp = await launchOwnedChrome(config);
  const client = new OwnedChromeClient(cdp);
  try { await client.initialize(); return client; } catch (error) { await cdp.close(); throw error; }
}
