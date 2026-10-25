import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => { const index = process.argv.indexOf(name); if (index === -1) return null; const value = process.argv[index + 1]; if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`); return value; };
const manifestPath = path.resolve(argument('--manifest') ?? path.join(project, 'assets/skins/silver-dragon-rig/skin.json'));
const output = path.resolve(argument('--out') ?? path.join(project, 'release/previews-0.4.0'));
const chrome = argument('--chrome') ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const contains = (base, target) => { const relative = path.relative(base, target); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert(contains(path.join(project, 'release'), output) || contains(path.join(project, '.local'), output), 'Output must stay in project release/ or .local/.');

// This runs only in the generated page. The bridge is an in-memory demonstration:
// no Node, Electron IPC, file writes, account access or network calls are exposed.
function startPreview(manifest, images, appScript, appCss) {
  const clone = value => structuredClone(value);
  const sources = new Map();
  for (const [name, encoded] of Object.entries(images)) {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    sources.set(name, URL.createObjectURL(new Blob([bytes], { type: 'image/png' })));
  }
  for (const view of Object.values(manifest.rig.views)) for (const layer of view.layers) layer.file = sources.get(layer.file);
  for (const animation of Object.values(manifest.animations)) animation.frames = animation.frames.map(file => sources.get(file) ?? file);
  const epoch = Date.now(), listeners = new Set(); let sequence = 0, timers = [], jogging = false, direction = 'right';
  const state = {
    settings: { scale: 1, roaming: true, alwaysOnTop: true, model: 'demo', codexPath: '', chromeExecutablePath: '', chromeUserDataDir: '', chromeProfileDirectory: '', grant: { folders: ['演示文件夹（不访问本机）'], origins: ['https://demo.invalid'], browserInput: false }, skinPath: null },
    assistant: { connected: true, connection: 'ready', login: 'signed-in', diagnostic: null, account: '离线交互演示', models: [{ id: 'demo', label: '演示模型（无网络请求）', isDefault: true }], threadId: 'demo-current', activeTurnId: null, activity: 'idle', messages: [{ id: 'hello', role: 'assistant', text: '我在这里。点我打开小气泡，右键可以打开完整对话、设置和历史。\n这是离线演示，我不会读取文件或连接网络。', createdAt: epoch }], pending: [], threads: [{ id: 'demo-current', title: '今天的桌面小搭档', updatedAt: epoch }, { id: 'demo-history', title: '上次的演示对话', updatedAt: epoch - 86400000 }], browser: 'disconnected', error: null },
    browserSetup: { status: 'idle', message: '离线演示不连接 Chrome。', profiles: [], selectedProfileId: null, chromeFound: false, canConnect: false },
    bubbleOpen: false, bubbleMode: 'hidden', panelTab: 'chat', skin: { manifest, baseUrl: 'file:///' }, direction, motion: 'idle', version: '0.4.0 · 演示', animationStartedAt: epoch,
    rigPlayback: { control: { activity: 'idle', motion: 'idle', direction }, startedAt: epoch },
  };
  const frame = document.querySelector('#bubble'), canvas = document.querySelector('#character'), ctx = canvas.getContext('2d', { alpha: true }), menu = document.querySelector('#context-menu');
  canvas.width = 352; canvas.height = Math.round(352 * manifest.height / manifest.width);
  const textures = new Map();
  const clearTimers = () => { for (const timer of timers) clearTimeout(timer); timers = []; };
  const later = (fn, delay) => { const timer = setTimeout(fn, delay); timers.push(timer); };
  const message = (role, text) => state.assistant.messages.push({ id: 'm-' + ++sequence, role, text, createdAt: Date.now() });
  function publish() {
    const control = { activity: state.assistant.activity, motion: state.assistant.activeTurnId ? 'idle' : jogging ? 'running' : 'idle', direction };
    if (JSON.stringify(control) !== JSON.stringify(state.rigPlayback.control)) state.rigPlayback = transitionRigPlayback(manifest.rig, state.rigPlayback, control, Date.now());
    state.motion = control.motion; state.direction = direction; state.bubbleOpen = state.bubbleMode !== 'hidden';
    frame.hidden = !state.bubbleOpen;
    frame.className = state.bubbleMode === 'panel' ? 'panel' : 'quick';
    if (state.bubbleMode === 'panel') frame.style.height = '690px';
    document.querySelector('#motion').textContent = jogging ? `慢跑中 · 向${direction === 'left' ? '左' : '右'}` : '待机 · 呼吸与眨眼';
    document.querySelector('#jog').setAttribute('aria-pressed', String(jogging));
    canvas.dataset.motion = control.motion; canvas.dataset.activity = control.activity;
    for (const listener of listeners) listener(clone(state));
  }
  function mode(next, tab) { state.bubbleMode = next; if (tab) state.panelTab = tab; publish(); }
  function finish(text, activity = 'success') { state.assistant.pending = []; state.assistant.activeTurnId = null; state.assistant.activity = activity; message('assistant', text); publish(); later(() => { if (!state.assistant.activeTurnId) { state.assistant.activity = 'idle'; publish(); } }, 2800); }
  function beginDemo() {
    clearTimers(); state.assistant.activeTurnId = 'demo-turn-' + ++sequence; state.assistant.activity = 'awaiting-input';
    message('user', '请先确认两件事，再演示一次需要我批准的操作。');
    state.assistant.pending = [{ id: 'question-' + sequence, kind: 'question', title: '开始前，我想确认两件事', threadId: state.assistant.threadId, turnId: state.assistant.activeTurnId, questions: [
      { id: 'style', header: '整理方式', question: '这次按哪种方式整理？', options: [{ label: '按类型', description: '图片、文档分开放。' }, { label: '按日期', description: '按创建时间分组。' }], isOther: true },
      { id: 'name', header: '文件夹名称', question: '演示文件夹叫什么？', options: [{ label: '桌面资料', description: '使用这个示例名称。' }, { label: '我的收藏', description: '使用另一个示例名称。' }], isOther: true },
    ] }]; mode('quick', 'chat');
  }
  const bridge = {
    async getState() { return clone(state); }, onState(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async send(text) {
      if (state.assistant.activeTurnId) { message('user', text); message('assistant', '收到这条补充要求；当前演示会等你回答或批准后继续。'); publish(); return; }
      clearTimers(); message('user', text); state.assistant.activeTurnId = 'chat-' + ++sequence; state.assistant.activity = 'thinking'; publish();
      later(() => { state.assistant.activity = 'speaking'; message('assistant', `收到啦：${text}\n\n这是本地模拟回复。正式桌宠会将你的话交给 Codex；这张预览不会执行任何文件或网络操作。`); publish(); }, 650);
      later(() => finish('还有什么想一起做的？也可以点击「问答与审批示例」体验两题追问。'), 1500);
    },
    async answer(payload) {
      const pending = state.assistant.pending[0]; if (!pending || pending.kind !== 'question' || pending.id !== payload.id) throw new Error('这个演示问题已经处理过。');
      const answers = Object.values(payload.answers).flat(); message('user', answers.join('；'));
      state.assistant.activity = 'awaiting-approval'; state.assistant.pending = [{ id: 'approval-' + ++sequence, kind: 'approval', threadId: state.assistant.threadId, turnId: state.assistant.activeTurnId, title: '覆盖演示文件', description: '将演示文件内容替换为新的整理结果。这里只展示批准流程，不会读取或修改任何真实文件。', details: ['目标：演示文件夹 / example.txt（仅内存示例）', '影响：替换示例内容；真实桌宠会在你批准后执行。', '你的回答：' + answers.join('；')], supportsSession: false }]; publish();
    },
    async approve(id, decision) {
      if (state.assistant.pending[0]?.id !== id || state.assistant.pending[0]?.kind !== 'approval') throw new Error('这项演示批准已处理。');
      clearTimers(); finish(decision === 'allow' ? '已收到「允许本次」。演示已完成，没有写入任何真实文件。' : decision === 'deny' ? '已拒绝这次操作。演示已结束，没有执行覆盖。' : '已停止演示任务。', decision === 'allow' ? 'success' : 'idle');
    },
    async stop() { clearTimers(); finish('任务已停止。演示不会继续执行。', 'idle'); },
    async newThread() { if (state.assistant.activeTurnId) throw new Error('请先结束演示任务。'); state.assistant.threadId = 'demo-new-' + ++sequence; state.assistant.messages = []; state.assistant.pending = []; state.assistant.activity = 'idle'; mode('panel', 'chat'); },
    async resumeThread(id) { if (state.assistant.activeTurnId) throw new Error('请先结束演示任务。'); state.assistant.threadId = id; state.assistant.messages = [{ id: 'past-' + ++sequence, role: 'assistant', text: '这是保存在预览内存中的历史示例。可以继续输入，看看气泡如何回复。', createdAt: epoch - 86400000 }]; mode('panel', 'chat'); },
    async updateSettings(patch) { Object.assign(state.settings, clone(patch)); publish(); }, async chooseFolder() { return '演示文件夹（不访问本机）'; },
    async importSkin() { message('system', '离线预览已固定使用这套龙娘素材，不会打开本机文件。'); publish(); },
    async setBubble(open) { mode(open ? 'quick' : 'hidden'); }, async setBubbleMode(next, tab) { mode(next, tab); },
    async resizeQuickBubble(height) { if (state.bubbleMode === 'quick') frame.style.height = Math.min(360, Math.max(180, height)) + 'px'; },
    async showContextMenu() { showMenu(canvas.getBoundingClientRect().right - 50, canvas.getBoundingClientRect().top + 70); }, async drag() {},
    async connectBrowser() { message('system', '离线演示不连接浏览器，正式版会在你选择的范围内工作。'); publish(); },
    async detectBrowser() { return clone(state.browserSetup); }, async selectBrowserProfile() { return clone(state.browserSetup); }, async installBrowserExtension() {},
    async reconnect() { message('system', '这是离线模拟连接，无需登录。'); publish(); }, async login() { message('system', '演示不读取你的账号，也不会打开登录页面。'); publish(); }, async cancelLogin() {},
    async openExternal() { message('system', '预览中的链接不会打开外部网页。'); publish(); },
  };
  window.__preview = { bridge, state, beginDemo };
  const safeScript = appScript.replaceAll('</script', '<\\/script');
  frame.srcdoc = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>' + appCss + '</style></head><body><div id="root"></div><script>' + safeScript + '<' + '/script></body></html>';
  function showMenu(x, y) { menu.hidden = false; menu.style.left = Math.min(innerWidth - 220, x) + 'px'; menu.style.top = Math.min(innerHeight - 275, y) + 'px'; }
  canvas.addEventListener('click', () => mode(state.bubbleMode === 'hidden' ? 'quick' : 'hidden'));
  canvas.addEventListener('contextmenu', event => { event.preventDefault(); showMenu(event.clientX, event.clientY); });
  canvas.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); mode(state.bubbleMode === 'hidden' ? 'quick' : 'hidden'); } });
  document.addEventListener('click', event => { if (!menu.contains(event.target)) menu.hidden = true; });
  menu.addEventListener('click', event => { const item = event.target.closest('button[data-mode]'); if (item) { mode(item.dataset.mode, item.dataset.tab); menu.hidden = true; } });
  document.querySelector('#theme').addEventListener('click', () => { const dark = document.documentElement.classList.toggle('dark'); document.querySelector('#theme').textContent = dark ? '浅色桌面' : '深色桌面'; document.querySelector('#theme').setAttribute('aria-pressed', String(dark)); });
  document.querySelector('#jog').addEventListener('click', () => { jogging = !jogging; publish(); });
  document.querySelector('#direction').addEventListener('click', () => { direction = direction === 'left' ? 'right' : 'left'; publish(); });
  document.querySelector('#demo').addEventListener('click', beginDemo);
  document.querySelector('#panel').addEventListener('click', () => mode('panel', 'chat'));
  document.querySelector('#reset').addEventListener('click', () => { clearTimers(); state.assistant.activeTurnId = null; state.assistant.pending = []; state.assistant.activity = 'idle'; state.assistant.messages = [{ id: 'reset-' + ++sequence, role: 'assistant', text: '我在，想聊点什么？这是不执行真实操作的离线演示。', createdAt: Date.now() }]; mode('quick', 'chat'); });
  Promise.all([...sources.values()].map(async url => { const image = new Image(); image.src = url; await image.decode(); textures.set(url, image); })).then(() => {
    canvas.dataset.ready = 'true';
    const draw = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); drawRigPose(ctx, sampleRigPose(manifest.rig, state.rigPlayback, Date.now()), textures, { scale: canvas.width / manifest.width, x: 0, y: 0 }); canvas.dataset.time = String(Date.now()); requestAnimationFrame(draw); };
    requestAnimationFrame(draw); publish();
  }).catch(error => { document.querySelector('#motion').textContent = error.message; });
  window.addEventListener('beforeunload', () => { clearTimers(); for (const url of sources.values()) URL.revokeObjectURL(url); });
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); assert(manifest.rig?.version === 1, 'A completed v1 rig manifest is required.');
  const root = await fs.realpath(path.dirname(manifestPath)); assert(!contains(root, output) && !contains(output, root), 'Output must not overlap drawing sources.');
  const images = {}, hashes = {};
  for (const file of new Set(Object.values(manifest.rig.views).flatMap(view => view.layers.map(layer => layer.file)))) {
    assert(typeof file === 'string' && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..') && /\.png$/i.test(file), 'Only local fixed PNG textures are allowed.');
    const real = await fs.realpath(path.join(root, file)); assert(contains(root, real), 'Texture escapes skin directory.'); const bytes = await fs.readFile(real); images[file] = bytes.toString('base64'); hashes[file] = sha(bytes);
  }
  const appCss = await fs.readFile(path.join(project, 'src/renderer/styles.css'), 'utf8');
  const app = await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{App}from './src/renderer/App';window.pet=parent.__preview.bridge;createRoot(document.getElementById('root')).render(React.createElement(App,{view:'bubble'}));`, resolveDir: project, sourcefile: 'interaction-bubble.tsx', loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, target: 'chrome120', jsx: 'automatic' });
  const runtime = await build({ stdin: { contents: `import{sampleRigPose,transitionRigPlayback}from './src/shared/rig';import{drawRigPose}from './src/shared/render-rig';(${startPreview.toString()})(${JSON.stringify(manifest)},${JSON.stringify(images)},${JSON.stringify(app.outputFiles[0].text)},${JSON.stringify(appCss)});`, resolveDir: project, sourcefile: 'offline-interaction.ts', loader: 'ts' }, bundle: true, write: false, platform: 'browser', format: 'iife', minify: true, target: 'chrome120' });
  const css = `*{box-sizing:border-box}html{background:#eae6f0;color:#40354c;font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 26% 68%,#fff9 0,transparent 58%)}header{max-width:1260px;margin:auto;padding:28px 38px 14px}h1{font-size:28px;letter-spacing:1px;font-weight:600;margin:0 0 6px}p{margin:5px 0;color:#7c7187}.badge{display:inline-block;background:#f9f5df;color:#8b7346;padding:4px 10px;border-radius:7px;font-size:12px}.toolbar{display:flex;gap:9px;flex-wrap:wrap;margin-top:17px}button{font:inherit;border:1px solid #cfc5db;background:#fdfbff;border-radius:10px;color:inherit;padding:8px 13px;cursor:pointer}button:hover{background:#f2ecf8}button[aria-pressed=true]{background:#dcd0ec;border-color:#ac98c4}button:focus-visible,canvas:focus-visible{outline:3px solid #a38bc4;outline-offset:4px}.desktop{height:780px;max-width:1260px;margin:0 auto;position:relative;overflow:hidden;border-top:1px solid #cfc5db66}.floor{position:absolute;bottom:85px;left:42px;right:42px;border-top:1px solid #a49bad55;box-shadow:0 0 40px 8px #a99bb51c}.character-wrap{position:absolute;left:65px;bottom:80px;width:352px;height:440px}.shadow{position:absolute;bottom:16px;left:90px;width:175px;height:24px;background:#72658320;filter:blur(8px);border-radius:50%}canvas{position:relative;display:block;cursor:pointer;filter:drop-shadow(0 3px 2px #66517810)}.hint{position:absolute;bottom:30px;left:65px;color:#8d8099;font-size:12px}iframe{position:absolute;border:0;background:transparent;right:85px;bottom:82px;width:320px;height:260px;transition:width .15s}.panel{width:454px}.quick{width:320px}iframe[hidden]{display:none}#context-menu{position:fixed;z-index:10;min-width:205px;padding:7px;background:#f9f6fc;border:1px solid #cfc4dc;border-radius:13px;box-shadow:0 9px 36px #40304e2c}#context-menu[hidden]{display:none}#context-menu small{display:block;font-size:10px;color:#9c8ba9;padding:5px 10px}#context-menu button{display:block;border:0;background:transparent;text-align:left;width:100%;padding:7px 10px;border-radius:6px}#context-menu button:hover{background:#e7deef}.dark{background:#272430;color:#e2d8ed}.dark body{background:radial-gradient(ellipse at 26% 68%,#594b6633 0,transparent 58%)}.dark p,.dark .hint{color:#b8aac7}.dark button{background:#42394e;color:#e5dbef;border-color:#665674}.dark button:hover{background:#534360}.dark .badge{background:#52472c;color:#f4e0a7}.dark #context-menu{background:#392f45;border-color:#675676}.dark #context-menu button:hover{background:#54425f}.dark .floor{border-color:#9e8dac66}@media(max-width:900px){header{padding:20px}.desktop{height:840px}.character-wrap{left:10px;bottom:40px}iframe{right:14px;bottom:340px}.hint{left:25px;bottom:15px}.panel{width:min(454px,calc(100vw - 28px))}}`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; frame-src 'self' blob: data:; connect-src 'none'; font-src data:"><title>龙娘桌宠 · 离线交互预览</title><style>${css}</style></head><body><header><h1>银白龙娘 · 桌面小搭档</h1><p>左键呼唤小气泡，右键打开菜单。角色与正式桌宠使用同一套连续动画。</p><span class="badge">离线交互演示 · 不执行文件或网络操作 · 不读取账号</span><div class="toolbar"><button id="demo">问答与审批示例</button><button id="panel">完整对话</button><button id="jog" aria-pressed="false">切换慢跑</button><button id="direction">换个方向</button><button id="theme" aria-pressed="false">深色桌面</button><button id="reset">重新开始</button></div></header><main class="desktop"><div class="floor"></div><div class="character-wrap"><div class="shadow"></div><canvas id="character" tabindex="0" role="button" aria-label="龙娘角色，点击打开或收起小气泡"></canvas></div><iframe id="bubble" title="真实龙娘气泡界面（离线演示）" hidden></iframe><div class="hint"><span id="motion">正在加载固定角色素材…</span><br>点击角色 · 右键菜单 · 输入中文 · 问答草稿跨窗口模式保留</div></main><nav id="context-menu" aria-label="演示右键菜单" hidden><small>演示菜单</small><button data-mode="quick">打开小气泡</button><button data-mode="panel" data-tab="chat">完整对话</button><button data-mode="panel" data-tab="settings">设置与授权范围</button><button data-mode="panel" data-tab="history">历史记录</button><button data-mode="hidden">收起气泡</button></nav><script>${runtime.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
  await fs.mkdir(output, { recursive: true }); const realOutput = await fs.realpath(output); assert(!contains(root, realOutput) && !contains(realOutput, root), 'Output links into drawing sources.');
  const destination = path.join(output, 'interaction.html'); await fs.writeFile(destination, html);
  const evidence = { version: '0.4.0', renderer: 'actual App + QuickBubble + sampleRigPose + drawRigPose', offline: true, noExecutionBridge: true, checks: [], pageErrors: [], networkRequests: [], sourceHashes: hashes, sourcePngUnchanged: false };
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1320, height: 1020 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => evidence.pageErrors.push(error.message));
    await page.route(/^https?:\/\//, route => { evidence.networkRequests.push(route.request().url()); return route.abort(); });
    await page.goto(pathToFileURL(destination).href); await page.locator('#character[data-ready=true]').waitFor();
    const alpha = await page.locator('canvas').evaluate(element => { const data = element.getContext('2d').getImageData(0, 0, element.width, element.height).data; return data.some((value, index) => index % 4 === 3 && value > 0); }); assert(alpha, 'Rig did not render.');
    const bubble = page.frameLocator('#bubble');
    await page.locator('#character').click(); await bubble.getByRole('main', { name: '龙娘小气泡' }).waitFor(); evidence.checks.push('left click opens real QuickBubble');
    const draft = '保留这份中文草稿'; await bubble.getByRole('textbox', { name: '对龙娘说点什么' }).fill(draft);
    await bubble.getByRole('button', { name: '收起气泡' }).click(); await page.locator('#character').click(); assert.equal(await bubble.getByRole('textbox', { name: '对龙娘说点什么' }).inputValue(), draft); evidence.checks.push('draft survives close/reopen');
    await page.getByRole('button', { name: '完整对话', exact: true }).first().click(); await bubble.getByRole('navigation', { name: '气泡导航' }).waitFor(); assert.equal(await bubble.getByRole('textbox', { name: '对龙娘说点什么' }).inputValue(), draft); evidence.checks.push('actual panel and quick share draft');
    await page.getByRole('button', { name: '问答与审批示例' }).click(); await bubble.getByRole('group').first().getByRole('radio').first().check();
    await bubble.getByRole('button', { name: '下一题' }).click(); await bubble.getByRole('group').first().getByRole('radio').first().check();
    await bubble.getByRole('button', { name: '收起气泡' }).click(); await page.locator('#character').click(); await bubble.getByRole('group', { name: /文件夹名称/ }).waitFor(); assert(await bubble.getByRole('radio').first().isChecked()); evidence.checks.push('question step and selection survive collapse');
    await bubble.getByRole('button', { name: '回答并继续' }).click(); await bubble.getByRole('region', { name: '等待批准' }).waitFor(); await page.screenshot({ path: path.join(output, 'interaction-approval.png'), fullPage: true });
    await bubble.getByRole('button', { name: '允许本次', exact: true }).click(); await bubble.getByText(/没有写入任何真实文件/).waitFor(); evidence.checks.push('two real question steps -> approval -> result');
    await page.locator('#character').click({ button: 'right' }); await page.locator('#context-menu').getByRole('button', { name: '设置与授权范围' }).click(); await bubble.getByRole('heading', { name: '桌宠与任务设置' }).waitFor(); evidence.checks.push('right click opens actual settings panel');
    await page.locator('#character').click({ button: 'right' }); await page.locator('#context-menu').getByRole('button', { name: '历史记录' }).click(); await bubble.getByRole('heading', { name: '过去的对话' }).waitFor(); evidence.checks.push('right click opens actual history');
    await page.getByRole('button', { name: '深色桌面' }).click(); await page.getByRole('button', { name: '切换慢跑' }).click(); await page.locator('#character[data-motion=running]').waitFor(); evidence.checks.push('dark/light and rig jogging toggle');
    await page.screenshot({ path: path.join(output, 'interaction-history-dark.png'), fullPage: true });
    await page.getByRole('button', { name: '浅色桌面' }).click(); await page.getByRole('button', { name: '重新开始' }).click();
    await bubble.getByRole('textbox', { name: '对龙娘说点什么' }).fill('你好，龙娘'); await bubble.getByRole('button', { name: '发送消息' }).click(); await bubble.getByText(/本地模拟回复/).waitFor(); evidence.checks.push('typed Chinese message receives simulated reply');
    await page.screenshot({ path: path.join(output, 'interaction-preview.png'), fullPage: true });
    assert.deepEqual(evidence.pageErrors, [], 'Offline preview has JavaScript errors.'); assert.deepEqual(evidence.networkRequests, [], 'Offline preview attempted network access.');
  } finally { await browser.close(); }
  for (const [file, hash] of Object.entries(hashes)) assert.equal(sha(await fs.readFile(path.join(root, file))), hash, 'Source drawing changed.'); evidence.sourcePngUnchanged = true;
  await fs.writeFile(path.join(output, 'interaction-verification.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ file: destination, bytes: Buffer.byteLength(html), checks: evidence.checks, sourcePngUnchanged: true }, null, 2));
}
await main();
