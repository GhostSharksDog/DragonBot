import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { createQuickBubbleShape, quickBubbleHit, pointInRoundedRect } from '../src/shared/bubble-shape.ts';

// An isolated headless browser, a fake preload bridge, and no access to daily Chrome.
const root = path.resolve(process.env.DRAGON_PET_RENDERER_DIR || 'dist/renderer');
const exists = async file => fs.access(file).then(() => true, () => false);
const skinName = process.env.DRAGON_PET_SKIN_NAME || (await exists('assets/skins/silver-dragon-frames/skin.json') || await exists('dist/assets/skins/silver-dragon-frames/skin.json') ? 'silver-dragon-frames' : await exists('assets/skins/silver-dragon-rig/skin.json') || await exists('dist/assets/skins/silver-dragon-rig/skin.json') ? 'silver-dragon-rig' : 'silver-dragon');
const findSkinRoot = async name => path.resolve(await exists(`dist/assets/skins/${name}/skin.json`) ? `dist/assets/skins/${name}` : `assets/skins/${name}`);
const skinRoot = await findSkinRoot(skinName);
const legacySkinRoot = await findSkinRoot('silver-dragon');
const bundledManifest = JSON.parse(await fs.readFile(path.join(skinRoot, 'skin.json'), 'utf8'));
const legacyManifest = JSON.parse(await fs.readFile(path.join(legacySkinRoot, 'skin.json'), 'utf8'));
const appVersion = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8')).version;
const artifactDir = path.resolve('.local/ui-check');
await fs.mkdir(artifactDir, { recursive: true });
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const assetRequests = new Map();
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (/^\/atlas-source-[ab]\.svg$/.test(pathname)) {
      const [width, height, fill] = pathname.includes('-a.') ? [400, 400, '#9366b4'] : [600, 300, '#6f94b3'];
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path fill="${fill}" d="M0 0H${width}V${height}H0Z"/></svg>`); return;
    }
    if (/^\/(?:frame-[012]|atlas-test)\.png$/.test(pathname)) { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(pixel); return; }
    const skinPrefix = pathname.startsWith('/builtin-skin/') ? '/builtin-skin' : pathname.startsWith('/legacy-skin/') ? '/legacy-skin' : null;
    if (skinPrefix) assetRequests.set(pathname, (assetRequests.get(pathname) ?? 0) + 1);
    const base = skinPrefix === '/builtin-skin' ? skinRoot : skinPrefix === '/legacy-skin' ? legacySkinRoot : root;
    const requestedPath = skinPrefix ? pathname.slice(skinPrefix.length) : pathname === '/' ? '/index.html' : pathname;
    const target = path.resolve(base, '.' + requestedPath);
    if (path.relative(base, target).startsWith('..')) { response.writeHead(403).end(); return; }
    const type = ({ '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' })[path.extname(target)] ?? 'text/html';
    const bytes = await fs.readFile(target);
    response.writeHead(200, { 'Content-Type': type });
    response.end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const bundledSkin = { baseUrl: address + '/builtin-skin/', manifest: bundledManifest };
const legacySkin = { baseUrl: address + '/legacy-skin/', manifest: legacyManifest };
const executablePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let browser;
const errors = [];
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'] });
  const context = await browser.newContext({ viewport: { width: 440, height: 680 }, locale: 'zh-CN' });
  await context.addInitScript(version => {
    let state = {
      settings: { scale: 1, roaming: true, alwaysOnTop: true, model: '', reasoningByModel: {}, codexPath: '', chromeExecutablePath: '', chromeUserDataDir: '', chromeProfileDirectory: '', grant: { folders: [], origins: [] }, skinPath: null },
      assistant: { connected: true, connection: 'ready', login: 'signed-in', diagnostic: null, account: '本地测试账号', models: [{ id: 'test-model', label: '测试模型', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '快速处理' }, { reasoningEffort: 'high', description: '仔细处理' }, { reasoningEffort: 'xhigh', description: '更多推理' }], defaultReasoningEffort: 'low' }, { id: 'other-model', label: '另一模型', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '适中' }, { reasoningEffort: 'max', description: '最大' }, { reasoningEffort: 'ultra', description: '极致' }], defaultReasoningEffort: 'medium' }], quota: { status: 'ready', stale: false, updatedAt: Date.now(), error: null, buckets: [{ id: 'other', name: '其他额度', primary: { usedPercent: 75, windowDurationMins: 60, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: null, credits: null, planType: null }, { id: 'codex', name: 'Codex', primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 18000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 }, credits: null, planType: 'test' }, { id: 'unknown', name: '未返回窗口', primary: null, secondary: null, credits: null, planType: null }] }, threadId: 'thread-test', activeTurnId: null, activity: 'idle', messages: [], pending: [], threads: [], browser: 'disconnected', error: null },
      browserSetup: { status: 'idle', message: '先检测 Chrome，再安装或启用官方扩展。', profiles: [], selectedProfileId: null, chromeFound: false, canConnect: false },
      bubbleOpen: true, bubbleMode: 'panel', quickView: 'chat', panelTab: 'chat', skin: null, direction: 'right', motion: 'idle', version,
    };
    const listeners = new Set();
    window.__calls = [];
    const emit = () => { for (const listener of listeners) listener(structuredClone(state)); };
    window.__patch = patch => { state = { ...state, ...patch, assistant: { ...state.assistant, ...patch.assistant }, settings: { ...state.settings, ...patch.settings } }; emit(); };
    const wait = () => new Promise(resolve => setTimeout(resolve, 100));
    const record = (name, payload) => { window.__calls.push({ name, payload }); };
    let rejectNext = false, rejectNextSend = false;
    let rejectNextQuota = false;
    window.__rejectNextQuota = () => { rejectNextQuota = true; };
    let nextInteractionWait = null;
    window.__rejectNext = () => { rejectNext = true; };
    window.__rejectNextSend = () => { rejectNextSend = true; };
    window.__holdNextInteraction = () => { nextInteractionWait = new Promise(resolve => { window.__releaseInteraction = resolve; }); };
    const waitForInteraction = async () => { const held = nextInteractionWait; nextInteractionWait = null; if (held) await held; await wait(); };
    window.pet = {
      getState: async () => structuredClone(state), onState: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      send: async text => { record('send', text); await wait(); if (rejectNextSend) { rejectNextSend = false; throw new Error('模拟消息发送失败'); } if (state.bubbleMode === 'quick' && state.quickView === 'compose') state.quickView = 'chat'; emit(); },
      answer: async payload => { record('answer', payload); await waitForInteraction(); state.assistant.pending = state.assistant.pending.filter(item => item.id !== payload.id); if (state.bubbleMode === 'quick' && state.quickView === 'compose') state.quickView = 'chat'; emit(); },
      approve: async (id, decision) => { record('approve', { id, decision }); await waitForInteraction(); if (rejectNext) { rejectNext = false; throw new Error('模拟过期审批请求'); } state.assistant.pending = state.assistant.pending.filter(item => item.id !== id); emit(); },
      stop: async () => { record('stop'); state.assistant.activeTurnId = null; state.assistant.pending = []; emit(); },
      newThread: async () => { record('new'); }, resumeThread: async id => { record('resume', id); },
      updateSettings: async patch => { record('settings', patch); state.settings = { ...state.settings, ...patch }; emit(); },
      chooseFolder: async () => 'E:\\桌宠测试', importSkin: async () => { record('skin'); },
      setBubble: async value => { record('bubble', value); state.bubbleOpen = value; state.bubbleMode = value ? 'quick' : 'hidden'; emit(); },
      setBubbleMode: async (mode, tab) => { record('bubble-mode', { mode, tab }); state.bubbleMode = mode; state.bubbleOpen = mode !== 'hidden'; if (mode === 'quick') state.quickView = 'chat'; if (tab) state.panelTab = tab; emit(); },
      showReply: async () => { record('show-reply'); state.bubbleMode = 'quick'; state.bubbleOpen = true; state.quickView = 'chat'; emit(); },
      openComposer: async () => { record('open-composer'); state.bubbleMode = 'quick'; state.bubbleOpen = true; state.quickView = 'compose'; emit(); },
      openQuota: async () => { record('open-quota'); state.bubbleMode = 'quick'; state.bubbleOpen = true; state.quickView = 'quota'; emit(); },
      refreshQuota: async () => { record('refresh-quota'); state.assistant.quota = { ...state.assistant.quota, status: 'loading', error: null }; emit(); await wait(); state.assistant.quota = rejectNextQuota ? { ...state.assistant.quota, status: 'error', error: '模拟额度刷新失败', stale: true } : { ...state.assistant.quota, status: 'ready', error: null, stale: false, updatedAt: Date.now() }; rejectNextQuota = false; emit(); },
      showContextMenu: async () => { record('context-menu'); },
      resizeQuickBubble: async height => { record('quick-height', height); },
      layoutQuickBubble: async layout => { record('quick-layout', layout); }, confirmQuickLayout: async id => { record('quick-ready', id); },
      drag: async (...args) => { record('drag', args); },
      detectBrowser: async () => { record('browser-detect'); state.browserSetup.status = 'detecting'; emit(); await wait(); state.browserSetup = { status: 'ready', message: '已找到日常 Chrome，可以连接并选择标签页。', profiles: [{ id: 'Default', name: '个人', extension: 'enabled', lastUsed: true }, { id: 'Profile 1', name: '工作', extension: 'enabled', lastUsed: false }], selectedProfileId: state.settings.chromeProfileDirectory || 'Default', chromeFound: true, canConnect: true }; emit(); return structuredClone(state.browserSetup); },
      selectBrowserProfile: async id => { record('browser-profile', id); state.settings.chromeProfileDirectory = id; state.browserSetup.selectedProfileId = id; emit(); return structuredClone(state.browserSetup); },
      installBrowserExtension: async () => { record('browser-install'); },
      showBrowser: async () => { record('browser-show'); state.assistant.browser='connected'; emit(); }, reconnectBrowser: async () => { record('browser-reconnect'); state.assistant.browser='connected'; emit(); },
      discoverProjects: async () => [],
      connectBrowser: async () => { record('browser'); state.assistant.browser = 'connecting'; state.browserSetup.status = 'awaiting-confirmation'; state.browserSetup.message = '请切换到 Chrome，批准连接并选择标签页。'; emit(); await new Promise(resolve => { window.__confirmBrowserConnection = resolve; }); state.assistant.browser = 'connected'; state.browserSetup.status = 'connected'; state.browserSetup.message = '已连接你选择的 Chrome 标签页，可以返回聊天交代任务。'; emit(); },
      reconnect: async () => { record('reconnect'); state.assistant.connection = 'reconnecting'; emit(); await wait(); state.assistant.connection = 'ready'; emit(); }, login: async () => { record('login'); state.assistant.login = 'opening-browser'; emit(); await wait(); state.assistant.login = 'waiting-browser'; emit(); }, openExternal: async url => { record('external', url); },
      cancelLogin: async () => { record('cancel-login'); state.assistant.login = 'signed-out'; state.assistant.diagnostic = { phase: 'account/login/canceled', message: '已取消这次登录。' }; emit(); },
    };
  }, appVersion);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(address + '/?view=bubble');
  await page.getByText('有事，叫我一声。').waitFor();
  const setMode = async (mode, tab) => {
    await page.evaluate(({ mode, tab }) => window.pet.setBubbleMode(mode, tab), { mode, tab });
    if (mode === 'quick') await page.locator('.quick-shell').waitFor({ state: 'visible' });
  };
  const waitForBundledPreview = async selector => {
    await page.waitForFunction(({ selector, rig }) => {
      const preview = document.querySelector(selector);
      if (rig) return preview?.querySelector('canvas.rig-canvas')?.dataset.rigReady === 'true';
      const image = preview?.querySelector('img'); return image?.complete && image.naturalWidth > 0;
    }, { selector, rig: Boolean(bundledManifest.rig) });
  };
  const quick = page.locator('.quick-shell');
  const quickComposer = quick.getByRole('textbox', { name: '对龙娘说点什么' });
  const openComposer = async () => { await page.evaluate(() => window.pet.openComposer()); await quick.locator('.quick-composer, .question-card').waitFor(); assert.equal(await page.locator('.reply-shell, .quota-shell').count(), 0, 'Input replaces every other quick view.'); };
  await page.setViewportSize({ width: 300, height: 340 });
  await setMode('quick');
  await quick.getByText('我在，点旁边的聊天图标和我说话吧。', { exact: true }).waitFor();
  assert.equal(await quick.locator('textarea, input').count(), 0, 'Reply bubble must have no embedded input.');
  await page.setViewportSize({ width: 320, height: 180 });
  await page.screenshot({ path: path.join(artifactDir, 'quick-greeting.png') });
  for (const [side, theme] of [['left', 'light'], ['right', 'light'], ['left', 'dark'], ['right', 'dark']]) {
    const shape = createQuickBubbleShape(320, 180, { x: side === 'left' ? -20 : 340, y: 135 });
    await page.evaluate(({ shape, theme }) => { document.body.style.background = theme === 'dark' ? '#252232' : '#f4f3f8'; window.__patch({ quickShape: shape }); }, { shape, theme });
    await page.waitForFunction(path => document.querySelector('.quick-surface path')?.getAttribute('d') === path, shape.path);
    assert.equal(await page.locator('.quick-surface path').count(), 1, 'Rounded rectangle and tail must share one seamless outline.');
    assert.equal(quickBubbleHit(shape, 1, 1), false);
    assert.equal(quickBubbleHit(shape, 319, 179), false);
    assert.equal(quickBubbleHit(shape, 160, 90), true);
    const tailCenter = { x: shape.tail.reduce((sum, point) => sum + point.x, 0) / 3, y: shape.tail.reduce((sum, point) => sum + point.y, 0) / 3 };
    assert.equal(quickBubbleHit(shape, tailCenter.x, tailCenter.y), true, 'The visible speech tip must belong to the native hit region.');
    const safe = await page.locator('.quick-inner').boundingBox();
    for (const [key, value] of Object.entries({ x: shape.content.x, y: shape.content.y, width: shape.content.width, height: shape.content.height })) assert(Math.abs(safe[key] - value) < .05, 'Text must occupy the shared inscribed rectangle.');
    const headerDrag = await page.locator('.quick-inner').evaluate(element => getComputedStyle(element).webkitAppRegion);
    assert.notEqual(headerDrag, 'drag');
    const controls = await page.locator('.quick-header, .quick-composer').evaluateAll(elements => elements.map(element => { const bounds = element.getBoundingClientRect(); return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }; }));
    for (const bounds of controls) for (const x of [bounds.x + 1, bounds.x + bounds.width - 1]) for (const y of [bounds.y + 1, bounds.y + bounds.height - 1]) assert(quickBubbleHit(shape, x, y), 'Greeting controls must not be clipped by the rounded corners.');
    await page.screenshot({ path: path.join(artifactDir, `rounded-${side}-${theme}.png`) });
  }
  await page.evaluate(() => { document.body.style.background = 'transparent'; window.__patch({ quickShape: undefined }); });
  await page.setViewportSize({ width: 300, height: 340 });
  assert.equal(await page.locator('.app-nav:visible').count(), 0, 'Quick bubble must omit panel navigation');
  assert.equal(await page.getByText('有事，叫我一声。', { exact: true }).isVisible(), false, 'Quick bubble must not show the panel welcome page');
  await openComposer();
  await page.screenshot({ path: path.join(artifactDir, 'quick-input.png') });
  await quickComposer.fill('小气泡中文输入检查');
  await quickComposer.dispatchEvent('compositionstart');
  await quickComposer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.name === 'send').length), 0, 'Quick IME Enter must not send');
  await quickComposer.dispatchEvent('compositionend');
  await quickComposer.press('Shift+Enter');
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.name === 'send').length), 0, 'Quick Shift Enter must not send');
  await quickComposer.press('Enter');
  await page.waitForFunction(() => window.__calls.filter(call => call.name === 'send').length === 1);
  await page.waitForFunction(() => document.querySelector('.reply-shell') && !document.querySelector('.quick-shell textarea'));
  assert.equal(await page.evaluate(() => window.__calls.find(call => call.name === 'send').payload), '小气泡中文输入检查');
  await openComposer();
  assert.equal(await quickComposer.inputValue(), '', 'Successful send clears only its submitted draft.');
  await quickComposer.fill('收起和切换时保留这份草稿');
  await quick.getByRole('button', { name: '收起气泡', exact: true }).click();
  await page.waitForFunction(() => window.__calls.some(call => call.name === 'bubble-mode' && call.payload.mode === 'hidden') || window.__calls.some(call => call.name === 'bubble' && call.payload === false));
  await openComposer();
  assert.equal(await quickComposer.inputValue(), '收起和切换时保留这份草稿', 'Closing quick bubble must preserve its unsent draft');
  const chatBeforeQuota = await page.evaluate(async () => { const state = await window.pet.getState(); return { threadId: state.assistant.threadId, messages: state.assistant.messages }; });
  await page.evaluate(() => window.pet.openQuota());
  await page.getByRole('main', { name: 'Codex 额度小气泡' }).waitFor();
  assert.equal(await page.locator('#quota-bucket').inputValue(), 'codex', 'Codex must be the initial bucket even when the server list has a different order.');
  assert.equal(Number(await page.getByRole('progressbar', { name: '5 小时额度剩余额度' }).getAttribute('value')), 87.5);
  assert.equal(Number(await page.getByRole('progressbar', { name: '7 天额度剩余额度' }).getAttribute('value')), 60);
  await page.locator('#quota-bucket').selectOption('other');
  assert.equal(Number(await page.getByRole('progressbar', { name: '1 小时额度剩余额度' }).getAttribute('value')), 25);
  await page.evaluate(() => { window.__rejectNextQuota(); });
  await page.getByRole('button', { name: '刷新额度', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '模拟额度刷新失败' }).waitFor();
  await page.getByText('上次记录，尚未更新。').waitFor();
  assert.equal(await page.locator('#quota-bucket').inputValue(), 'other', 'Refreshing cached data must retain a still-valid bucket selection.');
  assert.equal(Number(await page.getByRole('progressbar').getAttribute('value')), 25, 'A refresh error must keep the last real value.');
  await page.getByRole('button', { name: '刷新额度', exact: true }).click();
  await page.getByRole('alert').waitFor({ state: 'detached' });
  await page.waitForFunction(async () => { const quota = (await window.pet.getState()).assistant.quota; return quota.status === 'ready' && !quota.stale; });
  await page.locator('#quota-bucket').selectOption('unknown');
  await page.getByText('暂未返回此窗口额度。').waitFor();
  assert.equal(await page.getByRole('progressbar').count(), 0, 'Unknown quota must not render as zero percent.');
  await page.locator('#quota-bucket').selectOption('codex');
  await page.screenshot({ path: path.join(artifactDir, 'quota-ready.png') });
  assert.deepEqual(await page.evaluate(async () => { const state = await window.pet.getState(); return { threadId: state.assistant.threadId, messages: state.assistant.messages }; }), chatBeforeQuota, 'Opening and refreshing quota must not add chat messages or change thread.');
  await page.getByRole('button', { name: '返回聊天', exact: true }).click();
  assert.equal(await quickComposer.count(), 0, 'Returning from quota shows the reply, not the input.');
  await openComposer();
  assert.equal(await quickComposer.inputValue(), '收起和切换时保留这份草稿', 'Quota must preserve the unsent chat draft.');
  await setMode('panel', 'chat');
  assert.equal(await page.getByRole('textbox', { name: '对龙娘说点什么' }).inputValue(), '收起和切换时保留这份草稿', 'Panel and quick bubble must share one draft');
  await page.getByRole('textbox', { name: '对龙娘说点什么' }).fill('在完整对话修改后的草稿');
  await openComposer();
  assert.equal(await quickComposer.inputValue(), '在完整对话修改后的草稿');
  await page.evaluate(() => window.__rejectNextSend());
  await quick.getByRole('button', { name: '发送消息', exact: true }).click();
  await quick.getByRole('alert').filter({ hasText: '模拟消息发送失败' }).waitFor();
  assert.equal(await quickComposer.inputValue(), '在完整对话修改后的草稿', 'Failed quick sends must retain the draft');
  await quick.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.reply-shell') && !document.querySelector('.quick-shell textarea'));
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.name === 'send').length), 3, 'Each explicit quick send must call the bridge once');

  const longReply = '长回复正文。'.repeat(100) + '\n\n最后一句仍留在小气泡里。';
  const modeCallsBeforeReply = await page.evaluate(() => window.__calls.filter(call => call.name === 'bubble-mode').length);
  await page.evaluate(text => window.__patch({ assistant: { messages: [{ id: 'quick-long-reply', role: 'assistant', text, createdAt: Date.now() }] } }), longReply);
  assert.equal(await quick.locator('textarea, input').count(), 0, 'Incoming text must never bring an input into the reply bubble.');
  await quick.getByRole('button', { name: '展开回复', exact: true }).click();
  await quick.getByRole('button', { name: '收起回复', exact: true }).waitFor();
  assert.equal(await page.locator('.app-nav:visible').count(), 0, 'Expanding a long reply must stay inside quick mode');
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.name === 'bubble-mode').length), modeCallsBeforeReply, 'Incoming and expanded replies must not open a panel');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Quick bubble must fit its 300 pixel window');
  await page.screenshot({ path: path.join(artifactDir, 'quick-long-reply.png') });
  await quick.getByRole('button', { name: '收起回复', exact: true }).click();
  await page.evaluate(() => window.__patch({ assistant: { messages: [{ id: 'quick-short-reply', role: 'assistant', text: '整理好了，图片和文档已经分别放好。', createdAt: Date.now() }] } }));
  await page.setViewportSize({ width: 320, height: 118 });
  await page.screenshot({ path: path.join(artifactDir, 'quick-text-reply.png') });
  await page.setViewportSize({ width: 320, height: 340 });

  const quickQuestion = { id: 'quick-question', kind: 'question', threadId: 'thread-test', turnId: 'quick-turn', title: '确认两件事', questions: [{ id: 'style', header: '整理方式', question: '你希望按什么分类？', options: [{ label: '按类型', description: '图片和文档分别整理。' }, { label: '按日期' }] }, { id: 'folder-name', header: '文件夹名称', question: '新建的文件夹叫什么？' }] };
  await page.evaluate(request => window.__patch({ assistant: { pending: [request], activity: 'awaiting-input', activeTurnId: 'quick-turn' } }), quickQuestion);
  await quick.locator('.quick-question-prompt').waitFor();
  assert.equal(await quick.locator('textarea, input').count(), 0, 'Automatic questions show text until the chat logo opens the answer input.');
  await page.screenshot({ path: path.join(artifactDir, 'quick-question-text.png') });
  await openComposer();
  await quick.getByRole('button', { name: '下一题', exact: true }).waitFor();
  assert.equal(await quick.getByRole('button', { name: '下一题', exact: true }).isDisabled(), true, 'Step one needs an answer before advancing');
  await quick.getByRole('button', { name: '按类型' }).click();
  await quick.getByRole('button', { name: '下一题', exact: true }).click();
  await quick.getByRole('textbox', { name: '文件夹名称的文字回答' }).fill('小气泡中的答案');
  await quick.getByRole('button', { name: '上一题', exact: true }).click();
  assert.equal(await quick.getByRole('button', { name: '按类型' }).getAttribute('aria-pressed'), 'true', 'Going back must retain the first answer');
  await setMode('panel', 'chat');
  assert.equal(await page.getByRole('button', { name: '按类型' }).getAttribute('aria-pressed'), 'true', 'Question choices must survive quick to panel switching');
  assert.equal(await page.getByRole('textbox', { name: '文件夹名称的文字回答' }).inputValue(), '小气泡中的答案');
  await page.getByRole('textbox', { name: '文件夹名称的文字回答' }).fill('面板中补全的答案');
  await openComposer();
  if (await quick.getByRole('button', { name: '下一题', exact: true }).isVisible()) await quick.getByRole('button', { name: '下一题', exact: true }).click();
  assert.equal(await quick.getByRole('textbox', { name: '文件夹名称的文字回答' }).inputValue(), '面板中补全的答案', 'Panel edits must flow back into the stepped quick question');
  await page.evaluate(() => window.pet.openQuota());
  await page.getByText('有 1 项待回答', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '文件夹名称的文字回答' }).count(), 0);
  await page.screenshot({ path: path.join(artifactDir, 'quota-pending-question.png') });
  await page.getByRole('button', { name: '返回处理待办', exact: true }).click();
  await quick.locator('.quick-question-prompt').waitFor();
  assert.equal(await quick.locator('textarea, input').count(), 0);
  await openComposer();
  assert.equal(await quick.getByRole('textbox', { name: '文件夹名称的文字回答' }).inputValue(), '面板中补全的答案', 'Quota round-trip must preserve question step and answer draft.');
  await page.screenshot({ path: path.join(artifactDir, 'quick-question.png') });
  await quick.getByRole('button', { name: '回答并继续', exact: true }).click();
  await page.waitForFunction(() => window.__calls.some(call => call.name === 'answer' && call.payload.id === 'quick-question'));
  assert.deepEqual(await page.evaluate(() => window.__calls.find(call => call.name === 'answer' && call.payload.id === 'quick-question').payload), { id: 'quick-question', answers: { style: ['按类型'], 'folder-name': ['面板中补全的答案'] } }, 'Stepped questions must submit every answer in one response');
  await quick.getByRole('button', { name: '回答并继续', exact: true }).waitFor({ state: 'detached' });

  const quickApproval = { id: 'quick-approval', kind: 'approval', threadId: 'thread-test', turnId: 'quick-turn', title: '覆盖文件前需要确认', description: '请先阅读完整操作和目标。', details: ['目标：E:\\桌宠测试\\示例.txt', '操作详情：' + '这段内容必须在小气泡内完整展开后阅读。'.repeat(45)], supportsSession: false };
  await page.evaluate(request => window.__patch({ assistant: { pending: [request], activity: 'awaiting-approval' } }), quickApproval);
  const quickApprovalCard = quick.locator('.approval-card');
  await quickApprovalCard.waitFor();
  assert.equal(await quickApprovalCard.locator('.request-details').textContent(), quickApproval.details.join(''), 'Quick approval must retain the complete operation details inside its scrollable content');
  assert.equal(await quickApprovalCard.getByRole('button', { name: '拒绝', exact: true }).isDisabled(), false, 'Deny must remain available for long approval details');
  assert.equal(await quickApprovalCard.getByRole('button', { name: '停止任务', exact: true }).isDisabled(), false, 'Stop must remain available for long approval details');
  assert.equal(await quickApprovalCard.getByRole('button', { name: '允许本次', exact: true }).isDisabled(), false);
  await page.screenshot({ path: path.join(artifactDir, 'quick-approval.png') });
  await page.evaluate(() => window.__holdNextInteraction());
  await quickApprovalCard.getByRole('button', { name: '允许本次', exact: true }).dblclick();
  await page.waitForFunction(() => window.__calls.filter(call => call.name === 'approve' && call.payload.id === 'quick-approval').length === 1);
  await page.evaluate(() => window.pet.openQuota());
  await page.getByText('有 1 项待回答或批准', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回处理待办', exact: true }).click();
  assert.equal(await quickApprovalCard.getByRole('button', { name: '允许本次', exact: true }).isDisabled(), true, 'Quota must retain an in-flight approval lock.');
  await setMode('panel', 'chat');
  assert.equal(await page.getByRole('button', { name: '允许本次', exact: true }).isDisabled(), true, 'Approval lock must survive switching into the panel');
  await setMode('quick');
  assert.equal(await quickApprovalCard.getByRole('button', { name: '允许本次', exact: true }).isDisabled(), true, 'Approval lock must survive switching back into quick mode');
  await page.evaluate(() => window.__releaseInteraction());
  await quickApprovalCard.getByRole('button', { name: '允许本次', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.name === 'approve' && call.payload.id === 'quick-approval').length), 1, 'Quick and panel must not approve the same request twice');
  await page.waitForFunction(() => window.__calls.some(call => call.name === 'quick-height'));
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.name === 'quick-height').every(call => Number.isFinite(call.payload) && call.payload >= 80 && call.payload <= 360)), true, 'Measured quick-window heights must remain bounded');

  await setMode('panel', 'settings');
  await page.getByRole('heading', { name: '桌宠与任务设置', exact: true }).waitFor();
  await page.evaluate(request => window.__patch({ assistant: { pending: [request], error: '测试任务提示', activity: 'awaiting-input' } }), { ...quickQuestion, id: 'panel-stays-settings' });
  await page.getByRole('heading', { name: '桌宠与任务设置', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '对龙娘说点什么' }).count(), 0, 'Incoming questions must not replace an open settings panel');
  await page.evaluate(() => {
    window.__calls.length = 0;
    window.__patch({ bubbleMode: 'panel', panelTab: 'chat', assistant: { pending: [], messages: [], activeTurnId: null, activity: 'idle', error: null }, browserSetup: { status: 'idle', message: '先检测 Chrome，再安装或启用官方扩展。', profiles: [], selectedProfileId: null, chromeFound: false, canConnect: false } });
  });
  await page.setViewportSize({ width: 440, height: 680 });
  await page.getByText('有事，叫我一声。').waitFor();
  await page.getByText('尚未载入角色动画', { exact: true }).waitFor();
  await page.evaluate(skin => window.__patch({ skin }), bundledSkin);
  await waitForBundledPreview('.welcome .skin-thumbnail');
  assert.equal(await page.locator('.art-notice').count(), 0, 'Loaded character must replace the missing-art notice');
  assert.equal(await page.getByRole('img', { name: `角色预览：${bundledManifest.name}` }).count(), 1, 'Welcome must show the loaded character');
  await page.screenshot({ path: path.join(artifactDir, 'bubble.png') });
  const previewFixture = { baseUrl: address + '/', manifest: { name: '预览图集检查', width: 200, height: 100, anchor: { x: 100, y: 100 }, animations: { idle: { frames: ['atlas-test.png'], fps: 1, atlas: { columns: 4, rows: 4, indices: [5] } } } } };
  await page.evaluate(skin => window.__patch({ skin }), previewFixture);
  await page.waitForFunction(() => document.querySelector('.welcome .thumbnail-cell img')?.style.left === '-100%');
  const previewGeometry = await page.locator('.welcome .thumbnail-cell').evaluate(cell => {
    const crop = cell.getBoundingClientRect(), image = cell.querySelector('img').getBoundingClientRect();
    return { ratio: crop.width / crop.height, columns: image.width / crop.width, rows: image.height / crop.height, column: (crop.x - image.x) / crop.width, row: (crop.y - image.y) / crop.height };
  });
  assert.deepEqual(previewGeometry, { ratio: 2, columns: 4, rows: 4, column: 1, row: 1 }, 'Thumbnail must crop the declared cell and keep its proportions');
  const regionPreview = { baseUrl: address + '/', manifest: { name: '不等距裁切检查', width: 200, height: 200, anchor: { x: 100, y: 200 }, animations: { idle: { frames: ['atlas-test.png'], fps: 1, atlas: { columns: 1, rows: 1, indices: [0], sourceWidth: 400, sourceHeight: 400, regions: [{ x: 40, y: 30, width: 120, height: 240 }] } } } } };
  const multiSourceSkin = { baseUrl: address + '/', manifest: { name: '多源轮廓裁切检查', width: 200, height: 200, anchor: { x: 100, y: 200 }, animations: { idle: { frames: ['atlas-source-a.svg', 'atlas-source-b.svg'], fps: 4, loop: false, atlas: { columns: 2, rows: 1, indices: [0, 1], sourceWidth: 400, sourceHeight: 400, frameSources: [0, 1], sourceSizes: [{ width: 400, height: 400 }, { width: 600, height: 300 }], regions: [{ x: 40, y: 30, width: 120, height: 240, outline: [[60, 0], [120, 120], [60, 240], [0, 120]] }, { x: 300, y: 30, width: 160, height: 200, outline: [[80, 0], [160, 100], [80, 200], [0, 100]] }] } } } } };
  await page.evaluate(skin => window.__patch({ skin }), regionPreview);
  await page.getByRole('img', { name: `角色预览：${regionPreview.manifest.name}` }).waitFor();
  const regionPreviewGeometry = await page.locator('.welcome .thumbnail-crop').evaluate(crop => {
    const bounds = crop.getBoundingClientRect(), cell = crop.parentElement.getBoundingClientRect();
    return { ratio: bounds.width / bounds.height, bottom: Math.abs(cell.bottom - bounds.bottom), center: Math.abs((bounds.left + bounds.right) / 2 - (cell.left + cell.right) / 2) };
  });
  assert.deepEqual(regionPreviewGeometry, { ratio: 0.5, bottom: 0, center: 0 }, 'Irregular atlas thumbnail must keep the full crop aspect ratio, centered and grounded');
  await page.evaluate(skin => window.__patch({ skin }), multiSourceSkin);
  await page.waitForFunction(() => document.querySelector('.welcome .thumbnail-crop img')?.getAttribute('src')?.endsWith('atlas-source-a.svg'));
  const assertDiamondClip = async (locator, label) => {
    const result = await locator.evaluate(crop => {
      const image = crop.querySelector('img'), bounds = crop.getBoundingClientRect();
      const original = crop.style.pointerEvents, imageOriginal = image.style.pointerEvents;
      crop.style.pointerEvents = 'auto'; image.style.pointerEvents = 'none';
      const centerKept = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === crop;
      const cornerClipped = document.elementFromPoint(bounds.x + 2, bounds.y + 2) !== crop;
      const clipPath = getComputedStyle(crop).clipPath.replace(/^polygon\(evenodd,\s*/, 'polygon(');
      crop.style.pointerEvents = original; image.style.pointerEvents = imageOriginal;
      return { centerKept, cornerClipped, clipPath };
    });
    assert.deepEqual(result, { centerKept: true, cornerClipped: true, clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' }, label);
  };
  await assertDiamondClip(page.locator('.welcome .thumbnail-crop'), 'Thumbnail outline must clip neighboring pixels without changing its destination box');
  const firstThumbnailBox = await page.locator('.welcome .thumbnail-cell').boundingBox();
  await page.evaluate(skin => { skin.manifest.animations.idle.atlas.indices = [1]; window.__patch({ skin }); }, structuredClone(multiSourceSkin));
  await page.waitForFunction(() => { const image = document.querySelector('.welcome .thumbnail-crop img'); return image?.getAttribute('src')?.endsWith('atlas-source-b.svg') && image.complete && image.naturalWidth === 600; });
  assert.deepEqual(await page.locator('.welcome .thumbnail-cell').boundingBox(), firstThumbnailBox, 'Changing thumbnail source size must preserve its outer anchor and logical bounds');
  await assertDiamondClip(page.locator('.welcome .thumbnail-crop'), 'Thumbnail must scale the second source outline using that crop dimensions');
  await page.evaluate(skin => { skin.manifest.animations.idle.frames = ['missing-preview.png']; window.__patch({ skin }); }, previewFixture);
  await page.getByRole('img', { name: '临时龙蛋（角色预览无法加载）' }).waitFor();
  await page.evaluate(skin => window.__patch({ skin }), bundledSkin);
  await waitForBundledPreview('.welcome .skin-thumbnail');
  const composer = page.getByRole('textbox', { name: '对龙娘说点什么' });
  await composer.fill('中文输入检查');
  await composer.dispatchEvent('compositionstart');
  await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.name === 'send').length), 0, 'IME Enter must not send');
  await composer.dispatchEvent('compositionend');
  await composer.press('Shift+Enter');
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.name === 'send').length), 0, 'Shift Enter must not send');
  await composer.press('Enter');
  await page.waitForFunction(() => window.__calls.some(call => call.name === 'send'));
  assert.equal(await page.evaluate(() => window.__calls.find(call => call.name === 'send').payload), '中文输入检查');
  await composer.fill('任务进行中时补充要求');
  await page.evaluate(() => window.__patch({ assistant: { activeTurnId: 'turn-test', activity: 'thinking' } }));
  await page.getByRole('button', { name: '补充任务要求', exact: true }).waitFor();
  await page.getByRole('button', { name: '补充任务要求', exact: true }).click();
  await page.waitForFunction(() => window.__calls.filter(call => call.name === 'send').length === 2);
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.name === 'send').at(-1).payload), '任务进行中时补充要求');
  await page.getByRole('button', { name: '桌宠与任务设置' }).click();
  await page.getByText('已载入角色动画', { exact: true }).waitFor();
  await waitForBundledPreview('.settings-character');
  assert.equal(await page.getByRole('button', { name: '添加', exact: true }).first().isDisabled(), true, 'Scope must be locked during an active task');
  await page.evaluate(() => window.__patch({ assistant: { activeTurnId: null, activity: 'idle' } }));
  await page.getByRole('button', { name: '添加', exact: true }).first().click();
  await page.getByText('E:\\桌宠测试', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: '允许访问的网站地址' }).fill('https://example.com/a-path');
  await page.getByRole('button', { name: '添加', exact: true }).last().click();
  await page.getByText('https://example.com', { exact: true }).waitFor();
  await page.getByRole('switch', { name: '允许网页输入与选择（可能自动保存）' }).check();
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.name === 'settings').at(-1).payload.grant.browserInput), true);
  const chromeSetup = page.locator('.chrome-setup');
  await chromeSetup.getByRole('heading', { name: '独立 Chrome' }).waitFor();
  assert.equal(await chromeSetup.getByRole('button', { name: '安装官方扩展' }).count(), 0);
  await chromeSetup.getByRole('button', { name: '显示浏览器' }).click();
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.name === 'browser-show').length), 1);
  await chromeSetup.getByRole('button', { name: '重新连接', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.name === 'browser-reconnect').length), 1);
  await page.screenshot({ path: path.join(artifactDir, 'chrome-setup.png') });
  const codexSettings = page.locator('.codex-settings');
  await codexSettings.locator('#model').selectOption('test-model');
  await codexSettings.locator('#reasoning-effort').selectOption('high');
  await page.waitForFunction(async () => (await window.pet.getState()).settings.reasoningByModel['test-model'] === 'high');
  await codexSettings.locator('#model').selectOption('other-model');
  assert.deepEqual(await codexSettings.locator('#reasoning-effort option').evaluateAll(options => options.map(option => option.value)), ['', 'medium', 'max', 'ultra'], 'Reasoning choices must come only from this model catalog.');
  await codexSettings.locator('#reasoning-effort').selectOption('ultra');
  await codexSettings.locator('#model').selectOption('test-model');
  assert.equal(await codexSettings.locator('#reasoning-effort').inputValue(), 'high', 'Switching models must recover that model’s saved effort.');
  await codexSettings.locator('#reasoning-effort').selectOption('');
  await page.waitForFunction(async () => !Object.hasOwn((await window.pet.getState()).settings.reasoningByModel, 'test-model'));
  assert.equal(await page.evaluate(async () => (await window.pet.getState()).settings.reasoningByModel['other-model']), 'ultra', 'Restoring a model default must preserve other model records.');
  await page.evaluate(() => window.__patch({ settings: { reasoningByModel: { 'test-model': 'removed-effort', 'other-model': 'ultra' } } }));
  await codexSettings.getByText('已保存的档位不可用，请改用默认。').waitFor();
  await codexSettings.getByRole('button', { name: '恢复默认', exact: true }).click();
  await page.waitForFunction(async () => !Object.hasOwn((await window.pet.getState()).settings.reasoningByModel, 'test-model'));
  await codexSettings.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifactDir, 'model-reasoning.png') });
  await page.evaluate(() => window.__patch({ assistant: { connection: 'reconnecting', login: 'checking' } }));
  await codexSettings.getByText('正在检查这台电脑上的 Codex 登录状态…').waitFor();
  assert.equal(await codexSettings.getByRole('button', { name: '正在连接…' }).isDisabled(), true);
  assert.equal(await codexSettings.getByRole('button', { name: '登录 Codex' }).isDisabled(), true, 'Login and reconnect must be mutually disabled during connection');
  await page.evaluate(() => window.__patch({ assistant: { connection: 'ready', login: 'waiting-browser' } }));
  await codexSettings.getByText('已打开登录页，等待你在浏览器中完成登录。').waitFor();
  assert.equal(await codexSettings.getByRole('button', { name: '等待浏览器登录…' }).isDisabled(), true);
  await codexSettings.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifactDir, 'codex-login.png') });
  await codexSettings.getByRole('button', { name: '取消登录', exact: true }).click();
  await codexSettings.getByText('还没有登录 Codex，点击下方“登录 Codex”继续。').waitFor();
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.name === 'cancel-login').length), 1);
  await page.evaluate(() => window.__patch({ assistant: { connection: 'ready', login: 'signed-in', diagnostic: null } }));
  await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(artifactDir, 'settings.png') });
  await page.getByRole('button', { name: '聊一聊', exact: true }).click();
  const approval = { id: 'approval-one', kind: 'approval', threadId: 'thread-test', turnId: 'turn-test', title: '覆盖文件前需要确认', description: '将写入测试文件。', details: ['目标：E:\\桌宠测试\\示例.txt'], supportsSession: false };
  await page.evaluate(request => window.__patch({ assistant: { activeTurnId: 'turn-test', pending: [request], activity: 'awaiting-approval', messages: [{ id: 'm1', role: 'user', text: '帮我把测试文件夹里的资料整理一下。', createdAt: Date.now() - 30000 }, { id: 'm2', role: 'assistant', text: '我已经确认了文件类型，准备按**图片、文档、其他**分类。\n\n有一份同名文件需要你确认后才能覆盖。', createdAt: Date.now() }] } }), approval);
  assert.equal(await page.getByText('对此请求允许到本会话结束').count(), 0, 'Session grant must be hidden when unsupported');
  await page.screenshot({ path: path.join(artifactDir, 'approval.png') });
  await page.getByRole('button', { name: '允许本次', exact: true }).dblclick();
  await page.waitForFunction(() => window.__calls.filter(call => call.name === 'approve').length === 1);
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.name === 'approve').length), 1, 'Duplicate approval clicks must produce one call');
  await page.getByRole('button', { name: '允许本次', exact: true }).waitFor({ state: 'detached' });
  const rejected = { ...approval, id: 'approval-rejected', supportsSession: true };
  await page.evaluate(request => { window.__rejectNext(); window.__patch({ assistant: { pending: [request] } }); }, rejected);
  await page.getByRole('button', { name: '对此请求允许到本会话结束' }).waitFor();
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '模拟过期审批请求' }).waitFor();
  await page.getByRole('button', { name: '拒绝', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '拒绝', exact: true }).isDisabled(), false, 'Failed request should unlock after returning the error');
  const question = { id: 'question-one', kind: 'question', threadId: 'thread-test', turnId: 'turn-test', title: '想怎么整理？', questions: [{ id: 'style', header: '整理方式', question: '你希望按什么分类？', options: [{ label: '按类型', description: '图片和文档分别整理。' }, { label: '按日期' }] }, { id: 'folder-name', header: '文件夹名称', question: '新建的文件夹叫什么？' }] };
  await page.evaluate(request => window.__patch({ assistant: { pending: [request], activity: 'awaiting-input' } }), question);
  await page.getByRole('button', { name: '回答并继续' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '回答并继续' }).isDisabled(), true);
  await page.getByRole('button', { name: '按类型' }).click();
  await page.getByRole('textbox', { name: '文件夹名称的文字回答' }).fill('十月资料');
  await page.screenshot({ path: path.join(artifactDir, 'question.png') });
  await page.getByRole('button', { name: '回答并继续' }).click();
  await page.waitForFunction(() => window.__calls.some(call => call.name === 'answer'));
  assert.deepEqual(await page.evaluate(() => window.__calls.find(call => call.name === 'answer').payload), { id: 'question-one', answers: { style: ['按类型'], 'folder-name': ['十月资料'] } });
  await page.getByRole('button', { name: '回答并继续' }).waitFor({ state: 'detached' });
  await page.screenshot({ path: path.join(artifactDir, 'conversation.png') });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() => window.__calls.some(call => call.name === 'stop'));
  await page.setViewportSize({ width: 360, height: 480 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Compact bubble must not overflow horizontally');
  await page.screenshot({ path: path.join(artifactDir, 'compact.png') });
  // Independent option bubbles: both sides, narrow displays, and one-click
  // multistep answers share the same draft and actual request lock.
  const optionQuestion = { id: 'side-options', kind: 'question', threadId: 'thread-test', turnId: 'turn-test', title: '项目选择', questions: [
    { id: 'next', header: '下一步', question: '接下来先做哪一项？', options: [{label:'先修复界面',description:'调整气泡与输入布局。'},{label:'先运行测试',description:'检查已有功能。'}] },
    { id: 'check', header: '验证方式', question: '使用哪种验证方式？', options: [{label:'本地验证',description:'在项目目录运行测试。'},{label:'稍后验证'}] }
  ] };
  for (const [maxWidth,optionsSide] of [[550,'right'],[550,'left'],[320,'right']]) {
    await page.setViewportSize({width:maxWidth,height:360});
    await page.evaluate(({maxWidth,optionsSide,question}) => window.__patch({bubbleMode:'quick',quickView:'chat',quickShape:undefined,quickLayout:{id:100+maxWidth+(optionsSide==='left'?1:0),maxWidth,optionsSide},assistant:{activeTurnId:'turn-test',pending:[question],error:null}}),{maxWidth,optionsSide,question:optionQuestion});
    await page.locator('.choice-bubble').first().waitFor(); await page.waitForTimeout(150);
    const layout = await page.evaluate(() => window.__calls.filter(c=>c.name==='quick-layout').at(-1).payload);
    const buttons = await page.locator('.choice-bubble').evaluateAll(elements=>elements.map(element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}));
    assert.equal(buttons.length,2);assert.equal(await page.locator('input[type=radio]').count(),0);
    const body=createQuickBubbleShape(layout.body.width,layout.body.height,{x:optionsSide==='right'?-20:900,y:50});
    for(const button of buttons) {
      const x=button.x+button.width/2,y=button.y+button.height/2;
      assert(!quickBubbleHit(body,x-layout.body.x,y),'Options must be outside the main question outline.');
      assert(layout.regions.some(region=>pointInRoundedRect(region,x,y)),'Visible options have native hit regions.');
    }
    const between=buttons[0].y+buttons[0].height+4;
    assert(!layout.regions.some(region=>pointInRoundedRect(region,buttons[0].x+50,between)),'Transparent option gaps must pass through.');
    assert(Math.abs(buttons[1].y-buttons[0].y-buttons[0].height-8)<1);
    await page.locator('.choice-bubble').first().focus();
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.choice-bubble').first().evaluate(e=>getComputedStyle(e).outlineOffset),'-4px');
    await page.screenshot({path:path.join(artifactDir,`choices-${maxWidth}-${optionsSide}.png`),omitBackground:true,clip:{x:0,y:0,width:maxWidth,height:layout.height}});
  }
  await page.evaluate(()=>{window.__calls.length=0;});
  await page.locator('.choice-bubble').first().dblclick({delay:50});
  await page.getByText('使用哪种验证方式？',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.name==='answer').length),0,'Double click cannot answer the following question.');
  await page.getByRole('button',{name:'上一题',exact:true}).click();
  assert.equal(await page.locator('.choice-bubble').first().getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>window.pet.openComposer());
  assert.equal(await page.locator('.choice-bubbles').count(),0,'Input replaces external choices.');
  await page.evaluate(()=>window.pet.showReply());
  assert.equal(await page.locator('.choice-bubble').first().getAttribute('aria-pressed'),'true','Answer survives compose view.');
  await page.locator('.choice-bubble').first().click();
  await page.getByText('使用哪种验证方式？',{exact:true}).waitFor();
  await page.evaluate(()=>window.__holdNextInteraction());
  await page.locator('.choice-bubble').first().press('Enter');
  await page.waitForFunction(()=>window.__calls.some(c=>c.name==='answer'));
  await page.locator('.choice-bubble').first().dispatchEvent('click',{detail:1});
  assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.name==='answer').length),1);
  assert.deepEqual(await page.evaluate(()=>window.__calls.find(c=>c.name==='answer').payload),{id:'side-options',answers:{next:['先修复界面'],check:['本地验证']}});
  await page.evaluate(()=>window.__releaseInteraction());await page.locator('.choice-bubbles').waitFor({state:'detached'});
  await page.evaluate(()=>window.__patch({quickLayout:undefined,assistant:{activeTurnId:null,pending:[]}}));
  const pet = await context.newPage();
  await pet.setViewportSize({ width: 200, height: 240 });
  pet.on('pageerror', error => errors.push(error.message));
  await pet.goto(address + '/?view=pet');
  await pet.locator('.pet-button').waitFor();
  await pet.getByRole('button', { name: '输入消息', exact: true }).waitFor();
  await pet.screenshot({ path: path.join(artifactDir, 'pet-fallback.png') });
  const skin = { baseUrl: address + '/', manifest: { name: '测试动画', width: 200, height: 200, anchor: { x: 100, y: 200 }, animations: { idle: { frames: ['frame-0.png', 'frame-1.png'], fps: 4 }, 'awaiting-input': { frames: ['frame-2.png'], fps: 1 }, speaking: { frames: ['frame-1.png', 'frame-2.png'], fps: 8, loop: false } } } };
  await pet.evaluate(skin => window.__patch({ skin }), skin);
  await pet.locator('.pet-sprite').waitFor();
  const bounds = await pet.locator('.pet-sprite').boundingBox();
  assert.deepEqual(bounds, { x: 0, y: 32, width: 200, height: 200 }, 'Anchor must fix the foot to bottom center');
  await pet.evaluate(() => window.__patch({ assistant: { activity: 'awaiting-input' } }));
  await pet.waitForFunction(() => document.querySelector('.pet-sprite')?.getAttribute('src')?.endsWith('frame-2.png'));
  await pet.evaluate(() => window.__patch({ assistant: { activity: 'speaking' } }));
  for (let index = 0; index < 5; index++) {
    await pet.evaluate(skin => window.__patch({ skin: structuredClone(skin) }), skin);
    await new Promise(resolve => setTimeout(resolve, 45));
  }
  await pet.waitForFunction(() => document.querySelector('.pet-sprite')?.getAttribute('src')?.endsWith('frame-2.png'));
  assert.deepEqual(await pet.locator('.pet-sprite').boundingBox(), bounds, 'Animation must not shift the anchor');
  const atlasSkin = { ...skin, manifest: { ...skin.manifest, name: '图集测试动画', animations: { idle: { frames: ['atlas-test.png'], fps: 8, loop: false, atlas: { columns: 4, rows: 4, indices: [4, 5, 6, 7] } }, 'walking-left': { frames: ['atlas-test.png'], fps: 1, flipX: true, atlas: { columns: 4, rows: 4, indices: [0] } } } } };
  await pet.evaluate(skin => window.__patch({ skin, animationStartedAt: Date.now(), assistant: { activity: 'idle' } }), atlasSkin);
  await pet.waitForFunction(() => { const image = document.querySelector('.pet-sprite'); return image?.style.left === '-600px' && image.style.top === '-200px'; });
  assert.deepEqual(await pet.locator('.sprite-canvas > div').boundingBox(), bounds, 'Atlas cell must keep the same anchor as separate frames');
  assert.equal(await pet.locator('.pet-sprite').evaluate(image => getComputedStyle(image.parentElement).overflow), 'hidden', 'Atlas must show one cropped cell');
  await pet.evaluate(() => window.__patch({ motion: 'walking', direction: 'left' }));
  await pet.waitForFunction(() => getComputedStyle(document.querySelector('.sprite-canvas > div')).transform === 'matrix(-1, 0, 0, 1, 0, 0)');
  assert.equal(await pet.locator('.sprite-canvas > div').evaluate(cell => getComputedStyle(cell).transform), 'matrix(-1, 0, 0, 1, 0, 0)', 'Left-facing animations can mirror the cell');
  await pet.evaluate(skin => window.__patch({ skin, motion: 'idle' }), regionPreview);
  await pet.getByAltText(regionPreview.manifest.name, { exact: true }).waitFor();
  const regionBounds = await pet.locator('.pet-sprite').locator('..').boundingBox();
  assert.deepEqual(regionBounds, { x: 50, y: 32, width: 100, height: 200 }, 'Irregular atlas regions must fit whole, preserve proportions, and share the foot baseline');
  assert.deepEqual(await pet.locator('.sprite-canvas > div').boundingBox(), bounds, 'Irregular regions must not move the logical character anchor');
  await pet.evaluate(skin => window.__patch({ skin, animationStartedAt: Date.now() + 60000 }), multiSourceSkin);
  await pet.waitForFunction(() => { const image = document.querySelector('.pet-sprite'); return image?.getAttribute('src')?.endsWith('atlas-source-a.svg') && image.complete && image.naturalWidth === 400; });
  await assertDiamondClip(pet.locator('.pet-sprite').locator('..'), 'Desktop outline must exclude the rectangular corner and retain its center');
  assert.deepEqual(await pet.locator('.sprite-canvas > div').boundingBox(), bounds, 'Outline clipping must leave the outer character anchor unchanged');
  assert.deepEqual(await pet.locator('.pet-sprite').locator('..').boundingBox(), { x: 50, y: 32, width: 100, height: 200 });
  await pet.evaluate(() => window.__patch({ animationStartedAt: Date.now() - 300 }));
  await pet.waitForFunction(() => { const image = document.querySelector('.pet-sprite'); return image?.getAttribute('src')?.endsWith('atlas-source-b.svg') && image.complete && image.naturalWidth === 600; });
  assert.deepEqual(await pet.locator('.pet-sprite').locator('..').boundingBox(), { x: 20, y: 32, width: 160, height: 200 }, 'Different crop sizes must stay grounded across source-image changes');
  assert.deepEqual(await pet.locator('.pet-sprite').evaluate(image => ({ width: image.style.width, height: image.style.height })), { width: '600px', height: '300px' }, 'Second source must use its own declared image dimensions');
  assert.deepEqual(await pet.locator('.sprite-canvas > div').boundingBox(), bounds, 'Multi-source animation must preserve outer anchor');
  await assertDiamondClip(pet.locator('.pet-sprite').locator('..'), 'Second atlas must apply its own crop outline');
  if (bundledManifest.rig) {
    await pet.evaluate(skin => window.__patch({ skin, motion: 'idle', direction: 'right', assistant: { activity: 'idle' } }), bundledSkin);
    await pet.waitForFunction(() => document.querySelector('canvas.rig-canvas')?.dataset.rigReady === 'true');
    assert.equal(await pet.locator('.pet-sprite').count(), 0, 'Rig skin must use the canvas renderer instead of a legacy frame image');
    const rigBounds = await pet.locator('canvas.rig-canvas').boundingBox();
    const continuous = await pet.evaluate(async skin => {
      const canvas = document.querySelector('canvas.rig-canvas');
      const before = { time: Number(canvas.dataset.rigTime), count: Number(canvas.dataset.rigRenderCount), image: canvas.toDataURL() };
      const samples = [before.time]; let readyMutations = 0, generation = 0;
      const observer = new MutationObserver(records => {
        if (records.some(record => record.attributeName === 'data-rig-ready' && (record.oldValue !== 'true' || canvas.dataset.rigReady !== 'true'))) readyMutations++;
        samples.push(Number(canvas.dataset.rigTime));
      });
      observer.observe(canvas, { attributes: true, attributeOldValue: true });
      const republish = setInterval(() => window.__patch({ skin: structuredClone(skin), assistant: { activity: 'idle', messages: [{ id: 'rig-snapshot', role: 'assistant', text: `流式状态 ${++generation}`, createdAt: Date.now() }] } }), 35);
      await new Promise(resolve => setTimeout(resolve, 500));
      clearInterval(republish); observer.disconnect();
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let visible = 0, transparent = 0;
      for (let index = 3; index < pixels.length; index += 4) { if (pixels[index]) visible++; else transparent++; }
      return { sameCanvas: canvas === document.querySelector('canvas.rig-canvas'), timeDelta: Number(canvas.dataset.rigTime) - before.time, renderDelta: Number(canvas.dataset.rigRenderCount) - before.count, timeRegressed: samples.some((time, index) => index > 0 && time < samples[index - 1]), readyMutations, changed: canvas.toDataURL() !== before.image, visible, transparent };
    }, bundledSkin);
    assert.equal(continuous.sameCanvas, true, 'Streaming snapshots must preserve the same rig canvas');
    assert.equal(continuous.readyMutations, 0, 'Streaming snapshots must not reload rig textures');
    assert.equal(continuous.timeRegressed, false, 'The continuous rig clock must not restart while state streams');
    assert.ok(continuous.timeDelta >= 350 && continuous.renderDelta >= 5, 'Rig rendering and time must advance continuously');
    assert.equal(continuous.changed, true, 'Idle breathing must actually change rendered pixels');
    assert.ok(continuous.visible > 0 && continuous.transparent > 0, 'Rig canvas must show a character with transparent surroundings');
    await pet.screenshot({ path: path.join(artifactDir, 'rig-idle.png') });
    const rigStates = [
      { animation: 'walking-left', motion: 'walking', direction: 'left', activity: 'idle', facing: 'left' },
      { animation: 'running-right', motion: 'running', direction: 'right', activity: 'idle', facing: 'right' },
      ...['thinking', 'speaking', 'awaiting-input', 'awaiting-approval', 'success', 'error', 'idle'].map(activity => ({ animation: activity, motion: 'idle', direction: 'right', activity, facing: 'front' })),
    ];
    for (const state of rigStates) {
      await pet.evaluate(({ motion, direction, activity }) => window.__patch({ motion, direction, assistant: { activity } }), state);
      await pet.waitForFunction(({ animation, facing }) => { const canvas = document.querySelector('canvas.rig-canvas'); return canvas?.dataset.rigAnimation === animation && canvas.dataset.rigFacing === facing && Number(canvas.dataset.rigTime) >= 280; }, state);
      assert.deepEqual(await pet.locator('canvas.rig-canvas').boundingBox(), rigBounds, 'Changing rig activity or facing must preserve the canvas placement');
      const layers = Number(await pet.locator('canvas.rig-canvas').getAttribute('data-rig-layers'));
      assert.equal(layers, bundledManifest.rig.views[state.facing].layers.length, 'After transition, rig must draw the selected fixed template only');
      await pet.screenshot({ path: path.join(artifactDir, `rig-${state.animation}.png`) });
    }
    await pet.evaluate(skin => window.__patch({ skin: { ...skin, baseUrl: skin.baseUrl + 'missing/' } }), bundledSkin);
    await pet.getByText('素材加载失败', { exact: true }).waitFor();
    await pet.locator('.pet-egg').waitFor();
    await fs.writeFile(path.join(artifactDir, 'rig-progress.json'), JSON.stringify({ skin: bundledManifest.name, continuous, states: rigStates }, null, 2));
  } else if (skinName === 'silver-dragon-frames') {
    assert.deepEqual(Object.keys(bundledManifest.animations).sort(), ['idle', 'thinking']);
    for (const animation of Object.values(bundledManifest.animations)) {
      assert.equal(animation.atlas?.indices.length ?? animation.frames.length, 24);
      assert.equal(animation.fps, 12, 'The new stationary skin uses one two-second cycle.');
    }
    await pet.evaluate(skin => window.__patch({ skin, motion: 'idle', direction: 'right', animationStartedAt: Date.now(), assistant: { activity: 'idle' } }), bundledSkin);
    await pet.waitForFunction(() => document.querySelector('.sprite-canvas')?.dataset.ready === 'true' && document.querySelector('.pet-sprite')?.complete);
    const expectedSources = new Set(Object.values(bundledManifest.animations).flatMap(animation => animation.frames)).size;
    const bounds = await pet.locator('.sprite-canvas > div').boundingBox();
    const baseline = await pet.locator('.sprite-canvas').evaluate(element => ({ decodes: element.dataset.decodeCount, generation: element.dataset.preloadGeneration, sourceCount: Number(element.dataset.sourceCount) }));
    assert.equal(baseline.sourceCount, expectedSources, 'Both actions must be decoded before their first switch.');
    const requestsBefore = [...assetRequests].filter(([url]) => url.startsWith('/builtin-skin/'));
    const progression = [];
    for (const activity of ['idle', 'thinking']) {
      const result = await pet.evaluate(async ({ skin, activity }) => {
        const host = document.querySelector('.sprite-canvas'), epoch = Date.now() + 80, events = [];
        let blank = 0, last = -1, scheduled = 0, generation = 0;
        const probe = document.createElement('canvas'); probe.width = innerWidth; probe.height = innerHeight;
        const ctx = probe.getContext('2d', { willReadFrequently: true });
        const sample = () => {
          const image = document.querySelector('.pet-sprite');
          if (!image?.complete || !image.naturalWidth || image.dataset.ready !== 'true' || !image.parentElement) ++blank;
          if (image?.dataset.animation === activity && Date.now() >= epoch) {
            const frame = Number(image.dataset.frame);
            if (frame !== last) {
              last = frame;
              const rect = image.getBoundingClientRect(), crop = image.parentElement.getBoundingClientRect();
              ctx.clearRect(0, 0, probe.width, probe.height); ctx.save(); ctx.beginPath(); ctx.rect(crop.x, crop.y, crop.width, crop.height); ctx.clip(); ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height); ctx.restore();
              const rgba = ctx.getImageData(0, 0, probe.width, probe.height).data;
              let visible = 0, transparent = 0;
              for (let index = 3; index < rgba.length; index += 4) { if (rgba[index] > 24) ++visible; if (rgba[index] === 0) ++transparent; }
              events.push({ frame, elapsed: Date.now() - epoch, visible, transparent, epoch: Number(image.dataset.epoch), source: image.dataset.source, render: probe.toDataURL() });
            }
          }
          scheduled = requestAnimationFrame(sample);
        };
        const state = { skin, motion: 'idle', animationStartedAt: epoch, assistant: { activity } };
        window.__patch(state); sample();
        const stream = setInterval(() => window.__patch({ ...state, skin: structuredClone(skin), assistant: { activity, messages: [{ id: 'frames-stream', role: 'assistant', text: `状态流 ${++generation}`, createdAt: Date.now() }] } }), 35);
        await new Promise(resolve => setTimeout(resolve, 2450));
        clearInterval(stream); cancelAnimationFrame(scheduled);
        const image = document.querySelector('.pet-sprite');
        return { events, blank, sameHost: host === document.querySelector('.sprite-canvas'), visibleImages: document.querySelectorAll('.pet-sprite').length, decodes: host.dataset.decodeCount, preloadGeneration: host.dataset.preloadGeneration, actualAnimation: image.dataset.animation, epoch };
      }, { skin: bundledSkin, activity });
      assert.equal(result.blank, 0, 'Decoded-image swaps must never expose an empty/loading frame.');
      assert.equal(result.sameHost, true);
      assert.equal(result.visibleImages, 1, 'Only the actual visible frame may be mounted.');
      assert.equal(result.decodes, baseline.decodes, 'Streaming and action switches must reuse decoded sources.');
      assert.equal(result.preloadGeneration, baseline.generation, 'Cloned snapshots must not reload the skin.');
      const indices = [...new Set(result.events.map(event => event.frame))].sort((a, b) => a - b);
      assert.deepEqual(indices, Array.from({ length: 24 }, (_, index) => index), 'The real playback clock must visit every index in the two-second loop.');
      const cycleIndex = result.events.findIndex((event, index) => { const cycle = result.events.slice(index, index + 24); return cycle.length === 24 && cycle.slice(1).every((item, offset) => item.frame === (cycle[offset].frame + 1) % 24) && cycle.at(-1).elapsed - event.elapsed >= 1750 && cycle.at(-1).elapsed - event.elapsed <= 2100; });
      assert(cycleIndex >= 0, `${activity} must render a sequential 24-index cycle at 12 fps.`);
      assert(result.events.every(event => event.visible > 200 && event.transparent > 200 && event.epoch === result.epoch), 'Actual displayed pixels and epoch must remain valid while streaming.');
      assert(new Set(result.events.map(event => event.render)).size >= 2, 'The displayed artwork must actually animate; holds may repeat poses.');
      assert.deepEqual(await pet.locator('.sprite-canvas > div').boundingBox(), bounds, 'Idle/thinking must preserve the shared anchor.');
      await pet.screenshot({ path: path.join(artifactDir, `frames-${activity}.png`) });
      progression.push({ ...result, events: result.events.map(({ render, ...event }) => event), indices });
    }
    const fallbackEpoch = Date.now() - 300;
    await pet.evaluate(epoch => window.__patch({ animationStartedAt: epoch, assistant: { activity: 'idle' } }), fallbackEpoch);
    await pet.waitForFunction(epoch => document.querySelector('.pet-sprite')?.dataset.animation === 'idle' && document.querySelector('.pet-sprite')?.dataset.epoch === String(epoch), fallbackEpoch);
    for (const activity of ['speaking', 'awaiting-input', 'awaiting-approval', 'success', 'error']) {
      await pet.evaluate(activity => window.__patch({ assistant: { activity } }), activity);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual(await pet.locator('.pet-sprite').evaluate(image => ({ animation: image.dataset.animation, epoch: Number(image.dataset.epoch) })), { animation: 'idle', epoch: fallbackEpoch }, 'Unsupported activities must keep the actual idle clock.');
    }
    assert.deepEqual([...assetRequests].filter(([url]) => url.startsWith('/builtin-skin/')), requestsBefore, 'No picture requests may be added by streaming or switching actions after preload.');
    await fs.writeFile(path.join(artifactDir, 'frames-progress.json'), JSON.stringify({ skin: bundledManifest.name, baseline, progression, fallbackEpoch, sourceRequests: requestsBefore }, null, 2));
  }
  // The legacy sprite contract remains supported; its exact frame tests use the
  // preserved sprite skin even when the application's built-in character is a rig.
  await pet.evaluate(skin => window.__patch({ skin, motion: 'idle', assistant: { activity: 'idle' } }), legacySkin);
  await pet.waitForFunction(base => { const image = document.querySelector('.pet-sprite'); return image?.complete && image.naturalWidth > 0 && image.dataset.source?.startsWith(base) && document.querySelector('.sprite-canvas')?.dataset.ready === 'true'; }, legacySkin.baseUrl);
  await pet.screenshot({ path: path.join(artifactDir, 'pet.png') });
  const frameProgress = [];
  const fullCycle = events => events.findIndex((event, index) => { const cycle = events.slice(index, index + 24); return cycle.length === 24 && cycle.slice(1).every((item, offset) => item.frame === (cycle[offset].frame + 1) % 24) && cycle.at(-1).elapsed - event.elapsed >= 850 && cycle.at(-1).elapsed - event.elapsed <= 1100; });
  for (const name of Object.keys(legacyManifest.animations)) {
    let observed, attempts = 0;
    // A real-time renderer may drop a frame during an OS stall; require a complete measured cycle,
    // with up to two fresh samples rather than weakening the 24-frame/timing assertions.
    for (; attempts < 3; attempts++) {
    observed = await pet.evaluate(async ({ skin, name }) => {
      const animation = skin.manifest.animations[name];
      await Promise.all(animation.frames.map(frame => new Promise(resolve => { const image = new Image(); image.onload = resolve; image.onerror = resolve; image.src = new URL(frame, skin.baseUrl).href; })));
      const epoch = Date.now() + 80, events = []; let latest = -1, sampling = 0;
      const collect = () => {
        const image = document.querySelector('.pet-sprite');
        if (Date.now() < epoch || image?.dataset.animation !== name || !image.dataset.source?.startsWith(skin.baseUrl)) return;
        const frame = Number(image.dataset.frame);
        if (frame === latest || !Number.isInteger(frame)) return;
        latest = frame;
        events.push({ frame, elapsed: Date.now() - epoch, render: [image.getAttribute('src'), image.style.left, image.style.top, image.style.width, image.style.height, image.parentElement.style.clipPath].join('|') });
      };
      const observer = new MutationObserver(collect); observer.observe(document.body, { subtree: true, attributes: true });
      const sample = () => { collect(); sampling = requestAnimationFrame(sample); }; sampling = requestAnimationFrame(sample);
      const activity = name.startsWith('walking-') || name.startsWith('running-') || name === 'idle-back' ? 'idle' : name;
      const motion = name.startsWith('walking-') ? 'walking' : name.startsWith('running-') ? 'running' : 'idle';
      // idle-back is a valid skin animation but is not an exposed app activity: use its actual frames as idle.
      const displaySkin = name === 'idle-back' ? { ...skin, manifest: { ...skin.manifest, animations: { ...skin.manifest.animations, idle: animation } } } : skin;
      const expectedName = name === 'idle-back' ? 'idle' : name;
      if (expectedName !== name) name = expectedName;
      const state = { skin: displaySkin, animationStartedAt: epoch, motion, direction: name.endsWith('-left') ? 'left' : 'right', assistant: { activity } };
      window.__patch(state);
      const republish = setInterval(() => window.__patch({ ...state, skin: structuredClone(displaySkin) }), 35);
      await new Promise(resolve => setTimeout(resolve, animation.loop === false ? 1230 : 2180));
      clearInterval(republish); cancelAnimationFrame(sampling); observer.disconnect(); collect();
      return events;
    }, { skin: legacySkin, name });
    if (new Set(observed.map(event => event.frame)).size === 24 && fullCycle(observed) >= 0) break;
    }
    const indices = [...new Set(observed.map(event => event.frame))].sort((a, b) => a - b);
    assert.deepEqual(indices, Array.from({ length: 24 }, (_, index) => index), `${name} must actually render all 24 indices in approximately one second`);
    assert.equal(new Set(observed.map(event => event.render)).size, 24, `${name} must render 24 independent crop/image states`);
    const cycleIndex = fullCycle(observed);
    assert.ok(cycleIndex >= 0, `${name} must display a continuous 24-frame sequence spanning approximately one second`);
    const synchronized = observed.every(event => { const expected = legacyManifest.animations[name].loop === false ? Math.min(23, Math.floor(event.elapsed * 24 / 1000)) : Math.floor(event.elapsed * 24 / 1000) % 24; return Math.min((event.frame - expected + 24) % 24, (expected - event.frame + 24) % 24) <= 1; });
    assert.equal(synchronized, true, `${name} frame progression must follow one stable 24 fps epoch despite repeated snapshots`);
    frameProgress.push({ action: name, indices, transitions: observed.length, elapsedMs: observed.at(-1)?.elapsed, cycleDurationMs: observed[cycleIndex + 23].elapsed - observed[cycleIndex].elapsed, samples: attempts + 1 });
  }
  await fs.writeFile(path.join(artifactDir, 'animation-progress.json'), JSON.stringify(frameProgress, null, 2));
  for (const name of ['walking-right', 'walking-left', 'running-right', 'running-left', 'awaiting-approval']) {
    const animation = legacyManifest.animations[name];
    const cells = animation.atlas ? [...new Set(animation.atlas.indices)] : animation.frames.map((_, index) => index);
    for (const [index, cell] of cells.entries()) {
      const singleFrame = animation.atlas ? { ...animation, loop: false, atlas: { ...animation.atlas, indices: [cell] } } : { ...animation, loop: false, frames: [animation.frames[cell]] };
      const skin = { ...legacySkin, manifest: { ...legacyManifest, animations: { ...legacyManifest.animations, [name]: singleFrame } } };
      const motion = name.startsWith('walking-') ? 'walking' : name.startsWith('running-') ? 'running' : 'idle';
      const activity = name === 'awaiting-approval' ? 'awaiting-approval' : 'idle';
      const previousGeneration = await pet.locator('.sprite-canvas').getAttribute('data-preload-generation');
      await pet.evaluate(({ skin, motion, activity, direction }) => window.__patch({ skin, motion, direction, assistant: { activity } }), { skin, motion, activity, direction: name.endsWith('-left') ? 'left' : 'right' });
      await pet.waitForFunction(previous => { const image = document.querySelector('.pet-sprite'), host = document.querySelector('.sprite-canvas'); return image?.complete && image.naturalWidth > 0 && host?.dataset.ready === 'true' && Number(host.dataset.preloadGeneration) > Number(previous); }, previousGeneration);
      await pet.screenshot({ path: path.join(artifactDir, `pet-${name}-${index + 1}.png`) });
    }
  }
  await pet.locator('.pet-button').press('ArrowLeft');
  assert.deepEqual(await pet.evaluate(() => window.__calls.find(call => call.name === 'drag').payload), [-12, 0]);
  await pet.evaluate(() => window.__patch({ bubbleMode: 'hidden', bubbleOpen: false }));
  await pet.locator('.pet-button').click();
  await pet.waitForFunction(() => window.__calls.some(call => call.name === 'show-reply'));
  await pet.locator('.pet-button').click();
  await pet.waitForFunction(() => window.__calls.some(call => call.name === 'bubble-mode' && call.payload.mode === 'hidden'));
  await pet.locator('.pet-button').click({ button: 'right' });
  await pet.waitForFunction(() => window.__calls.some(call => call.name === 'context-menu'));
  assert.equal(await pet.evaluate(() => window.__calls.filter(call => call.name === 'bubble-mode' && call.payload.mode === 'panel').length), 0, 'Pet left clicks must only toggle the quick bubble; right click must open its native menu');
  await pet.evaluate(() => { window.__calls.length = 0; window.__patch({ bubbleMode: 'hidden', quickView: 'chat', bubbleOpen: false }); });
  await pet.locator('.pet-button').dblclick({ delay: 70 });
  await pet.waitForFunction(() => window.__calls.filter(call => call.name === 'open-quota').length === 1);
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.equal(await pet.evaluate(() => window.__calls.filter(call => call.name === 'bubble-mode' || call.name === 'show-reply').length), 0, 'A double click must not flash a single-click chat toggle.');
  await pet.evaluate(() => { window.__calls.length = 0; });
  await pet.locator('.pet-button').click({ clickCount: 3, delay: 55 });
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.equal(await pet.evaluate(() => window.__calls.filter(call => call.name === 'open-quota').length), 1, 'A triple click opens quota once.');
  assert.equal(await pet.evaluate(() => window.__calls.filter(call => call.name === 'bubble-mode' || call.name === 'show-reply').length), 0, 'Third click must not queue an extra chat toggle.');
  await pet.evaluate(() => { window.__calls.length = 0; });
  await pet.locator('.pet-button').click();
  await new Promise(resolve => setTimeout(resolve, 70));
  await pet.mouse.move(100, 120); await pet.mouse.down(); await pet.mouse.move(115, 128, { steps: 3 }); await pet.mouse.up();
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.equal(await pet.evaluate(() => window.__calls.filter(call => call.name === 'open-quota' || call.name === 'bubble-mode' || call.name === 'show-reply').length), 0, 'A second press that becomes a drag must cancel both click actions.');
  assert(await pet.evaluate(() => window.__calls.some(call => call.name === 'drag')), 'Real pointer movement must still drag.');
  await pet.evaluate(() => { window.__calls.length = 0; });
  await pet.locator('.pet-button').click(); await pet.locator('.pet-button').click({ button: 'right' });
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.equal(await pet.evaluate(() => window.__calls.filter(call => call.name === 'context-menu').length), 1);
  assert.equal(await pet.evaluate(() => window.__calls.filter(call => call.name === 'open-quota' || call.name === 'bubble-mode' || call.name === 'show-reply').length), 0, 'Right click must cancel the pending single click.');
  await pet.evaluate(() => { window.__calls.length = 0; });
  await pet.locator('.pet-button').click(); await pet.locator('.pet-button').press('ArrowRight');
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.equal(await pet.evaluate(() => window.__calls.filter(call => call.name === 'open-quota' || call.name === 'bubble-mode' || call.name === 'show-reply').length), 0, 'Keyboard movement must cancel the pending click.');
  await pet.evaluate(() => { window.__calls.length = 0; });
  await pet.locator('.pet-button').click();
  await pet.getByRole('button', { name: '输入消息', exact: true }).click();
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.equal(await pet.evaluate(() => window.__calls.filter(call => call.name === 'open-composer').length), 1, 'The chat logo must open the one input bubble.');
  assert.equal(await pet.evaluate(() => window.__calls.filter(call => call.name === 'open-quota' || call.name === 'bubble-mode' || call.name === 'show-reply' || call.name === 'drag').length), 0, 'Clicking the logo must cancel a pending character click without dragging or opening another bubble.');
  assert.equal(await pet.evaluate(async () => (await window.pet.getState()).quickView), 'compose');
  await pet.evaluate(skin => window.__patch({ skin, bubbleMode: 'hidden', bubbleOpen: false, quickView: 'chat', motion: 'idle', assistant: { activity: 'idle' } }), bundledSkin);
  await pet.waitForFunction(() => document.querySelector('.sprite-canvas')?.dataset.ready === 'true' && document.querySelector('.pet-sprite')?.complete);
  await pet.screenshot({ path: path.join(artifactDir, 'pet-chat-launcher.png'), omitBackground: true });
  // Ordinary Chat works even if Codex is disconnected; its compact controls keep the same input geometry.
  await page.setViewportSize({width:320,height:88});
  await page.evaluate(()=>{
    window.__calls.length=0;
    window.__patch({foreground:'chat',bubbleMode:'quick',quickView:'compose',settings:{chat:{mode:'auto',model:'GPT-test',effort:'high'}},assistant:{connected:false,pending:[],activeTurnId:null,error:null},chat:{status:'ready',message:'普通 Chat · High',model:'GPT-test',effort:'high',active:false,error:null,conversationId:'chat-test',messages:[{id:'chat-reply',role:'assistant',channel:'chat',text:'我在，慢慢说。',createdAt:Date.now()}],conversations:[]}});
  });
  await page.locator('.quick-composer textarea').fill('你好');
  assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isEnabled(),true);
  await page.getByRole('combobox',{name:'消息通道'}).selectOption('chat');
  assert.equal(await page.evaluate(async()=> (await window.pet.getState()).settings.chat.mode),'chat');
  await page.screenshot({path:path.join(artifactDir,'chat-070-input.png'),omitBackground:true});
  await page.evaluate(()=>window.pet.showReply());await page.getByText('我在，慢慢说。',{exact:true}).waitFor();
  assert.equal(await page.locator('.quick-shell textarea').count(),0);
  await page.screenshot({path:path.join(artifactDir,'chat-070-reply.png'),omitBackground:true});
  assert.deepEqual(errors, [], 'Renderer should have no uncaught exceptions');
  console.log('Renderer checks passed: rounded rectangle/tail safe layout, logo-only input, text-only replies, mutually exclusive bubble views, quota buckets/cache/pending coexistence, per-model reasoning choices, delayed single/double/triple/drag gestures, quick/panel drafts and approval locks, default/legacy animation clocks, cropping/anchors, Chrome setup, login phases, IME and task scope.');
  console.log('Screenshots: ' + artifactDir);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
