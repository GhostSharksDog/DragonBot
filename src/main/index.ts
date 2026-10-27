import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, screen, shell, Tray } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatService } from './chat/service';
import { ChatChrome, openManualChatLogin } from './chat/browser';
import { routeMessage, taskContext, type SendMode } from '../shared/chat';
import { ProjectService } from './projects';
import { activeProject } from './agent/project-policy';
import { realpath, stat } from 'node:fs/promises';
import { AssistantService } from './agent/service';
import { ToolHost } from './tools';
import { SettingsStore } from './settings';
import { BrowserSetupService } from './browser-setup';
import { loadSkin, validateSkinImageSize } from './skin';
import { bubbleBounds, quickBubbleBounds, clampRect, distanceToRect } from './geometry';
import { advanceHorizontalMotion, createHorizontalMotion, resetHorizontalMotion, ROAMING_TICK_MS } from './horizontal-motion';
import type { AppSnapshot, Settings, SkinData, ApprovalDecision, AnswerPayload, Activity, BubbleMode, PanelTab, QuickView, QuickLayoutRequest } from '../shared/types';
import { animationFrameAt, animationFrameCount, skinFrameLayout, pointInSpriteOutline } from '../shared/types';
import { effectiveAnimationKey, roamingAnimationMotion } from '../shared/animation-state';
import { rigFiles, rigHitTest, sampleRigPose, transitionRigPlayback, validateRigImageSize, type RigPlayback } from '../shared/rig';
import { QuickOutsideClickMonitor, rawMouseHelperPath, shouldDismissQuickClick } from './quick-outside-click';
import { createQuickBubbleShape, quickBubbleHit } from '../shared/bubble-shape';
import { petChatLauncherRect, pointInRoundedRect } from '../shared/pet-chat-launcher';
import { configurePerformanceLog, recordPerformance, flushPerformanceLog } from './performance';

protocol.registerSchemesAsPrivileged([{ scheme: 'pet-skin', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (process.env.DRAGON_PET_DATA_DIR) app.setPath('userData', path.resolve(process.env.DRAGON_PET_DATA_DIR));
if (!app.requestSingleInstanceLock()) app.quit();
let pet: BrowserWindow, bubble: BrowserWindow, tray: Tray, settings: SettingsStore, assistant: AssistantService, tools: ToolHost;
let browserSetup: BrowserSetupService;
let chat: ChatService;
let foreground: 'chat' | 'codex' = 'chat';
let sendingMessage = false;
let chatWasActive = false;
function chatChanged() {
  const state=chat?.getSnapshot();if(!state)return;
  const completed=chatWasActive&&!state.active&&state.status==='ready'&&state.messages.at(-1)?.role==='assistant';
  chatWasActive=state.active;
  if(completed&&foreground==='chat'&&!userHidden&&pet?.isVisible()&&bubbleMode==='hidden'&&!assistant.getSnapshot().pending.length){quickView='chat';showBubbleMode('quick',panelTab,false);}
  else publish();
}
function currentActivity(): Activity { const a=assistant.getActivityState(); if(a.pendingCount||a.activeTurnId)return a.activity;const c=chat?.getActivityState();return c?.active?(c.speaking?'speaking':'thinking'):a.activity; }
let projects: ProjectService;
let outsideClickMonitor: QuickOutsideClickMonitor | undefined;
let bubbleOpen = false, skin: SkinData | null = null, skinRoot = '', direction: 'left' | 'right' = 'right', motion: 'idle' | 'walking' | 'running' = 'idle';
let bubbleMode: BubbleMode = 'hidden', panelTab: PanelTab = 'chat', quickHeight = 88, userHidden = false, rigPlayback: RigPlayback | undefined;
let quickView: QuickView = 'chat', displayedQuickView: QuickView = 'chat', ignoreBubbleMouse = false, bubbleRevision = 0;
let quickWidth = 320, quickBody: QuickLayoutRequest['body'] | null = null, quickRegions: QuickLayoutRequest['regions'] = [], pendingQuickFocus = false;
let roaming = createHorizontalMotion({ x: 0, y: 0 }, performance.now()), draggingUntil = 0, timer: NodeJS.Timeout | undefined;
let shuttingDown = false, lastStateKey = '', lastActivity: Activity = 'idle', ignoreMouse = false;
let lastPendingId: string | null = null;
let quickAwaitingLayout = false;
let quickLayoutKey = '', quickOpenedAt = 0;
let lastAnimationKey = '', animationStartedAt = Date.now();
const masks = new Map<string, { bitmap: Buffer; width: number; height: number }>();

function currentRigPlayback() {
  if (!skin?.manifest.rig) return undefined;
  const control = { activity: currentActivity(), motion, direction };
  if (!rigPlayback || JSON.stringify(rigPlayback.control) !== JSON.stringify(control)) rigPlayback = transitionRigPlayback(skin.manifest.rig, rigPlayback, control, Date.now());
  return rigPlayback;
}
function quickShape() {
  const bounds = bubble.getBounds(), character = pet.getBounds();
  const body = quickBody ?? { x: 0, y: 0, width: bounds.width, height: bounds.height };
  const shape = createQuickBubbleShape(Math.min(body.width, bounds.width - body.x), Math.min(body.height, bounds.height - body.y), { x: character.x + character.width / 2 - bounds.x - body.x, y: character.y + character.height * .28 - bounds.y - body.y });
  return { ...shape, offset: { x: body.x, y: body.y } };
}
function bubbleHit(x: number, y: number) {
  const shape = quickShape();
  return quickBubbleHit(shape, x - shape.offset.x, y - shape.offset.y) || quickRegions.some(rect => pointInRoundedRect(rect, x, y));
}
function quickLayoutContext() {
  const bounds = pet.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
  const left = bounds.x - area.x, right = area.x + area.width - bounds.x - bounds.width;
  return { id: bubbleRevision, maxWidth: Math.max(left, right) >= 550 ? 550 : Math.min(320, area.width - 16), maxHeight: Math.max(88, Math.min(360, area.height - 16)), optionsSide: (right >= 550 ? 'right' : 'left') as 'left' | 'right' };
}
function snapshot(): AppSnapshot { const key = animationKey(); if (key !== lastAnimationKey) { lastAnimationKey = key; animationStartedAt = Date.now(); } return { chat: chat?.getSnapshot(), foreground, projectHandoff: projects?.getSnapshot(), settings: settings.value, assistant: { ...assistant.getSnapshot(), activity: currentActivity() }, browserSetup: browserSetup?.getSnapshot(), bubbleOpen, bubbleMode, quickView, quickLayout: quickLayoutContext(), quickShape: bubbleMode === 'quick' ? quickShape() : undefined, panelTab, skin, direction, motion, version: app.getVersion(), animationStartedAt, rigPlayback: currentRigPlayback() }; }
function publish() {
  if (!pet || pet.isDestroyed() || !assistant) return;
  const data = snapshot();
  for (const win of [pet, bubble]) if (win && !win.isDestroyed()) win.webContents.send('pet:state-change', data);
}
function positionBubble() {
  if (!pet || !bubble || bubble.isDestroyed()) return;
  const bounds = pet.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
  const next = bubbleMode === 'quick' ? quickBubbleBounds(bounds, area, quickHeight, quickWidth) : bubbleBounds(bounds, area);
  const previous = bubble.getBounds();
  if (next.x !== previous.x || next.y !== previous.y || next.width !== previous.width || next.height !== previous.height) bubble.setBounds(next);
}
function showBubble(open: boolean, focus = true) {
  showBubbleMode(open ? 'quick' : 'hidden', panelTab, focus);
}
function showBubbleMode(mode: BubbleMode, tab: PanelTab = panelTab, focus = true) {
  if (mode === 'quick' && bubbleMode === 'quick' && displayedQuickView === quickView && bubble.isVisible()) {
    if (focus) bubble.focus();
    return;
  }
  quickAwaitingLayout = mode === 'quick';
  quickLayoutKey = ''; quickOpenedAt = performance.now();
  bubbleRevision++; quickWidth = 320; quickBody = null; quickRegions = []; pendingQuickFocus = focus;
  if (mode === 'quick' && (bubbleMode !== 'quick' || displayedQuickView !== quickView)) {
    quickHeight = quickView === 'quota' ? 340 : 88;
    displayedQuickView = quickView;
  }
  bubbleMode = mode; panelTab = tab; bubbleOpen = mode !== 'hidden';
  assistant.setQuotaVisible(mode === 'quick' && quickView === 'quota');
  if (ignoreBubbleMouse) { ignoreBubbleMouse = false; bubble.setIgnoreMouseEvents(false); }
  if (bubbleOpen) { pauseRoaming(); if (mode === 'quick') bubble.hide(); positionBubble(); if (mode === 'panel') { focus ? bubble.show() : bubble.showInactive(); } } else bubble.hide();
  outsideClickMonitor?.setQuickVisible(mode === 'quick' && bubble.isVisible());
  publish();
}
function recordOpen(view: QuickView, inputAt?: number) {
  recordPerformance({ stage: 'open-request', view, id: bubbleRevision + 1, ...(typeof inputAt === 'number' && Number.isFinite(inputAt) && Math.abs(Date.now() - inputAt) < 60_000 ? { inputAt } : {}) });
}
function openQuota(inputAt?: number) {
  recordOpen('quota', inputAt);
  quickView = 'quota'; userHidden = false; pet.showInactive(); showBubbleMode('quick');
  void assistant.refreshQuota('open').catch(() => {});
}
function showReply(inputAt?: number) {
  recordOpen('chat', inputAt);
  quickView = 'chat'; userHidden = false; pet.showInactive(); showBubbleMode('quick');
}
function openComposer(inputAt?: number) {
  recordOpen('compose', inputAt);
  quickView = 'compose'; userHidden = false; pet.showInactive(); showBubbleMode('quick');
}
async function submitFromComposer(operation: () => Promise<void>) {
  const revision = bubbleRevision;
  const fromComposer = bubbleMode === 'quick' && quickView === 'compose';
  await operation(); // Failed sends keep the editor and its draft available.
  if (fromComposer && revision === bubbleRevision && bubbleMode === 'quick' && quickView === 'compose') {
    quickView = 'chat'; showBubbleMode('quick', panelTab, false);
  }
}
function pauseRoaming(position = { x: roaming.x, y: roaming.y }, waitMs = 2000) {
  roaming = resetHorizontalMotion(roaming, position, performance.now(), waitMs);
  motion = 'idle';
}
function ensureVisible() {
  if (!pet || pet.isDestroyed()) return;
  const area = screen.getDisplayMatching(pet.getBounds()).workArea;
  const bounds = pet.getBounds(), visible = clampRect(bounds, area);
  if (bounds.x !== visible.x || bounds.y !== visible.y || bounds.width !== visible.width || bounds.height !== visible.height) pet.setBounds(visible);
  pauseRoaming(visible); positionBubble(); publish();
}
async function setSkin(manifestPath: string | null) {
  if (!manifestPath) { skin = null; skinRoot = ''; lastAnimationKey = ''; masks.clear(); return; }
  const next = await loadSkin(manifestPath);
  const sizes = new Map<string, { width: number; height: number }>();
  if (next.manifest.rig) for (const file of rigFiles(next.manifest.rig)) {
    const image = nativeImage.createFromPath(path.join(path.dirname(manifestPath), file));
    if (image.isEmpty()) throw new Error(`无法读取角色部件 ${file}。`);
    validateRigImageSize(next.manifest.rig, file, image.getSize());
  }
  for (const animation of Object.values(next.manifest.animations)) {
    for (const frame of animation.frames) {
      if (!sizes.has(frame)) {
        const img = nativeImage.createFromPath(path.join(path.dirname(manifestPath), frame));
        if (img.isEmpty()) throw new Error(`无法读取动作图片 ${frame}。`);
        sizes.set(frame, img.getSize());
      }
      validateSkinImageSize(next.manifest, animation, frame, sizes.get(frame)!);
    }
  }
  skinRoot = await fs.realpath(path.dirname(manifestPath));
  next.baseUrl = `pet-skin://asset/${randomUUID()}/`;
  skin = next; rigPlayback = undefined; lastAnimationKey = ''; masks.clear();
}
function animationKey() {
  return effectiveAnimationKey(skin?.manifest, currentActivity(), motion, direction);
}
function spriteHit(x: number, y: number, width: number, height: number): boolean {
  if (pointInRoundedRect(petChatLauncherRect(width, height), x, y)) return true;
  const placeholderHit = () => {
    const s = width / 200;
    return ((x - width / 2) / (63 * s)) ** 2 + ((y - (height - 8 - 86 * s)) / (78 * s)) ** 2 <= 1;
  };
  if (!skin) return placeholderHit();
  if (skin.manifest.rig) {
    const manifest = skin.manifest, scale = Math.min(width / manifest.width, (height - 24) / manifest.height);
    const px = (x - (width / 2 - manifest.anchor.x * scale)) / scale, py = (y - (height - 8 - manifest.anchor.y * scale)) / scale;
    return rigHitTest(sampleRigPose(manifest.rig!, currentRigPlayback()!, Date.now()), px, py, (file, sourceX, sourceY) => {
      let mask = masks.get(file);
      if (!mask) { const image = nativeImage.createFromPath(path.join(skinRoot, file)); if (image.isEmpty()) return 0; const size = image.getSize(); mask = { bitmap: image.toBitmap(), width: size.width, height: size.height }; masks.set(file, mask); }
      const ix = Math.floor(sourceX), iy = Math.floor(sourceY);
      return ix < 0 || iy < 0 || ix >= mask.width || iy >= mask.height ? 0 : mask.bitmap[(iy * mask.width + ix) * 4 + 3];
    });
  }
  const manifest = skin.manifest, animation = manifest.animations[animationKey()] || manifest.animations.idle;
  const frameIndex = animationFrameAt(animation, Date.now(), animationStartedAt);
  const layout = skinFrameLayout(manifest, animation, frameIndex), { frame } = layout;
  let mask = masks.get(frame);
  if (!mask) {
    const img = nativeImage.createFromPath(path.join(skinRoot, frame));
    if (img.isEmpty()) return placeholderHit();
    const original = img.getSize(), maskScale = Math.min(1, 1024 / Math.max(original.width, original.height));
    const small = img.resize({ width: Math.max(1, Math.round(original.width * maskScale)), height: Math.max(1, Math.round(original.height * maskScale)), quality: 'good' }), size = small.getSize();
    mask = { bitmap: small.toBitmap(), width: size.width, height: size.height };
    if (masks.size >= 16) masks.delete(masks.keys().next().value!);
    masks.set(frame, mask);
  }
  const scale = Math.min(width / manifest.width, (height - 24) / manifest.height);
  const left = width / 2 - manifest.anchor.x * scale, top = height - 8 - manifest.anchor.y * scale;
  const logicalX = (x - left) / scale, logicalY = (y - top) / scale;
  if (logicalX < 0 || logicalX >= manifest.width || logicalY < 0 || logicalY >= manifest.height) return false;
  const spriteX = animation.flipX ? Math.min(manifest.width - .000001, manifest.width - logicalX) : logicalX;
  const dest = layout.destination, crop = layout.crop;
  if (spriteX < dest.x || spriteX >= dest.x + dest.width || logicalY < dest.y || logicalY >= dest.y + dest.height) return false;
  const sourceX = crop.x + (spriteX - dest.x) / dest.width * crop.width, sourceY = crop.y + (logicalY - dest.y) / dest.height * crop.height;
  if (!pointInSpriteOutline(crop, sourceX - crop.x, sourceY - crop.y)) return false;
  const pixelX = Math.min(mask.width - 1, Math.floor(sourceX / layout.source.width * mask.width)), pixelY = Math.min(mask.height - 1, Math.floor(sourceY / layout.source.height * mask.height));
  const offset = (pixelY * mask.width + pixelX) * 4 + 3;
  return mask.bitmap[offset] > 24;
}
function tick() {
  if (!pet || pet.isDestroyed()) return;
  const now = performance.now();
  const bounds = pet.getBounds(), cursor = screen.getCursorScreenPoint();
  const near = distanceToRect(cursor, bounds) < 42, state = assistant.getActivityState();
  const hit = draggingUntil > now || spriteHit(cursor.x - bounds.x, cursor.y - bounds.y, bounds.width, bounds.height);
  if (ignoreMouse === hit) { ignoreMouse = !hit; pet.setIgnoreMouseEvents(ignoreMouse, { forward: true }); }
  if (bubbleOpen && bubbleMode === 'quick') {
    const rect = bubble.getBounds(), inside = bubbleHit(cursor.x - rect.x, cursor.y - rect.y);
    if (ignoreBubbleMouse === inside) { ignoreBubbleMouse = !inside; bubble.setIgnoreMouseEvents(ignoreBubbleMouse, { forward: true }); }
  }
  const roamingMotion = roamingAnimationMotion(skin?.manifest);
  const paused = Boolean(chat?.getActivityState().active) || !roamingMotion || !pet.isVisible() || bubbleOpen || near || draggingUntil > now || !settings.value.roaming || state.activity !== 'idle' || state.activeTurnId !== null || state.pendingCount > 0;
  roaming = advanceHorizontalMotion(roaming, { now, paused, area: screen.getDisplayMatching(bounds).workArea, petWidth: bounds.width, scale: settings.value.scale });
  motion = roaming.motion === 'idle' ? 'idle' : roamingMotion ?? 'idle'; direction = roaming.direction;
  const x = Math.round(roaming.x), y = Math.round(roaming.y);
  if (x !== bounds.x || y !== bounds.y) pet.setPosition(x, y, false);
  const key = `${motion}/${direction}`;
  if (key !== lastStateKey) { lastStateKey = key; publish(); }
}
function allowedSender(sender: Electron.WebContents) { return [pet, bubble].some(w => w && !w.isDestroyed() && w.webContents.id === sender.id); }
function handle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!allowedSender(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('无效的桌宠消息来源。');
    return fn(...args);
  });
}
async function openExternal(url: string) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('只能打开有效的网页链接。');
  await shell.openExternal(parsed.toString());
}
function petMenu() {
  const openPanel = (tab: PanelTab) => { userHidden = false; pet.showInactive(); showBubbleMode('panel', tab); };
  return Menu.buildFromTemplate([
    { label: '打开小气泡', click: () => { userHidden = false; quickView = 'chat'; pet.showInactive(); showBubbleMode('quick'); } },
    { label: 'Codex 额度', click: () => openQuota() },
    { label: '完整对话', click: () => openPanel('chat') },
    { label: '设置与授权范围', click: () => openPanel('settings') },
    { label: '历史记录', click: () => openPanel('history') }, { type: 'separator' },
    { label: '暂停活动', type: 'checkbox', enabled: !!roamingAnimationMotion(skin?.manifest), checked: !settings.value.roaming || !roamingAnimationMotion(skin?.manifest), click: item => { settings.update({ roaming: !item.checked }); pauseRoaming(); publish(); } },
    { label: '停止任务', enabled: !!assistant.getSnapshot().activeTurnId || ['preparing', 'needs-response'].includes(projects?.getSnapshot()?.status ?? ''), click: () => { projects.stop(); void assistant.stop(); } },
    { label: pet.isVisible() ? '隐藏桌宠' : '显示桌宠', click: () => { userHidden = pet.isVisible(); if (userHidden) { pet.hide(); showBubbleMode('hidden'); } else pet.showInactive(); publish(); } },
    { type: 'separator' }, { label: '退出', click: () => app.quit() },
  ]);
}
function installHandlers() {
  handle('pet:state', () => snapshot());
  handle('pet:send', async (text: unknown, mode?: SendMode) => {
    if(typeof text!=='string'||!text.trim()||text.length>32000)throw Error('请输入 1–32000 字的消息。');
    if(mode!==undefined&&!['auto','chat','task'].includes(mode))throw Error('消息通道无效。');
    if(sendingMessage)throw Error('上一条消息仍在处理，请稍候。');
    if(assistant.getSnapshot().pending.length)throw Error('请先回答当前问题或处理审批。');
    sendingMessage=true;
    try { await submitFromComposer(async()=>{
      let route=routeMessage(text,mode??settings.value.chat?.mode??'auto',Boolean(assistant.getSnapshot().activeTurnId));
      if(route==='choose') { const choice=await assistant.chooseLocal('这句话是想聊一聊，还是让我操作？',['聊一聊','帮我做事']);if(!choice)throw Error('已取消发送，草稿已保留。');route=choice==='聊一聊'?'chat':'task'; }
      if(route==='chat'){foreground='chat';publish();await chat.send(text.trim());}
      else if(route==='project'){foreground='codex';publish();await projects.continueDefault(text.trim());}
      else {const context=foreground==='chat'&&!assistant.getSnapshot().activeTurnId?taskContext(chat.getSnapshot().messages,text.trim()):text.trim();foreground='codex';publish();await assistant.send(context);}
    });} finally{sendingMessage=false;}
  });
  handle('pet:chat-connect',()=>chat.connect());
  handle('pet:chat-check',()=>chat.check());
  handle('pet:chat-show',()=>chat.show());
  handle('pet:chat-login',()=>chat.login());
  handle('pet:chat-stop',()=>chat.stop());
  handle('pet:chat-new',async()=>{await chat.newConversation();foreground='chat';publish();});
  handle('pet:chat-resume',async(id:string)=>{if(typeof id!=='string'||id.length>100)throw Error('会话编号无效。');await chat.resume(id);foreground='chat';publish();});
  handle('pet:chat-not-sent',()=>chat.confirmNotSent());
  handle('pet:answer', (payload: AnswerPayload) => { if (!payload || typeof payload.id !== 'string' || !payload.answers || typeof payload.answers !== 'object') throw new Error('回答格式无效。'); return submitFromComposer(() => assistant.answer(payload)); });
  handle('pet:approve', (id: string, decision: ApprovalDecision) => { if (typeof id !== 'string' || !['allow', 'deny', 'stop', 'session'].includes(decision)) throw new Error('批准请求格式无效。'); return assistant.approve(id, decision); });
  handle('pet:stop', () => { if(foreground==='chat'&&!assistant.getSnapshot().pending.length)return chat.stop();projects.stop();return assistant.stop(); });
  handle('pet:new-thread', async () => { if (assistant.getSnapshot().activeTurnId) throw new Error('请先停止当前任务。'); settings.update({ grant: { ...settings.value.grant, folders: [] } }); await assistant.newThread(); foreground='codex'; publish(); });
  handle('pet:resume-thread', async (id: string) => { if (typeof id !== 'string' || id.length > 200) throw new Error('会话编号无效。'); if (assistant.getSnapshot().activeTurnId) throw new Error('请先停止当前任务。'); settings.update({ grant: { ...settings.value.grant, folders: [] } }); await assistant.resumeThread(id); foreground='codex'; publish(); });
  handle('pet:settings', async (patch: Partial<Settings>) => {
    if (!patch || typeof patch !== 'object') throw new Error('设置无效。');
    if (['projects', 'activeProjectId', 'projectReadAccess', 'grant', 'codexPath', 'model', 'reasoningByModel', 'chromeExecutablePath', 'chromeUserDataDir', 'chromeProfileDirectory'].some(key => key in patch) && assistant.getSnapshot().activeTurnId) throw new Error('任务执行时不能更改授权范围或助手配置；请先停止任务。');
    if (chat.getSnapshot().active && ('chat' in patch || 'chromeExecutablePath' in patch)) throw Error('普通 Chat 回复时不能更改模型或浏览器设置。');
    const safePatch = { ...patch }; delete safePatch.skinPath;
    if (safePatch.projects) for (const project of safePatch.projects) {
      if (typeof project.directory !== 'string' || !path.isAbsolute(project.directory) || !(await stat(project.directory)).isDirectory()) throw new Error('请选择存在的项目文件夹。');
      project.directory = await realpath(project.directory);
      const thread = await assistant.readProjectThread(project.threadId); if (!thread.name || thread.name !== project.threadTitle) throw new Error('原对话标题不匹配，请重新查找并关联。');
    }
    if (['chromeExecutablePath', 'chromeUserDataDir', 'chromeProfileDirectory'].some(key => key in patch && patch[key as keyof Settings] !== settings.value[key as keyof Settings])) await tools.disconnectBrowser();
    const oldReadAccess = settings.value.projectReadAccess; const oldPath = settings.value.codexPath; settings.update(safePatch);if(safePatch.chat?.mode==='chat')foreground='chat';else if(safePatch.chat?.mode==='task')foreground='codex';
    pet.setAlwaysOnTop(settings.value.alwaysOnTop, 'floating'); bubble.setAlwaysOnTop(settings.value.alwaysOnTop, 'floating');
    const width = Math.round(200 * settings.value.scale), height = Math.round(240 * settings.value.scale), bounds = pet.getBounds();
    if (bounds.width !== width || bounds.height !== height) pet.setSize(width, height);
    ensureVisible();
    if (oldPath !== settings.value.codexPath || oldReadAccess !== settings.value.projectReadAccess) await assistant.reconnect();
    if (['chromeExecutablePath', 'chromeUserDataDir', 'chromeProfileDirectory'].some(key => key in patch)) await browserSetup.detect();
    publish();
  });
  handle('pet:choose-folder', async () => { const result = await dialog.showOpenDialog(bubble, { title: '选择本次任务可访问的文件夹', properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
  handle('pet:import-skin', async () => {
    const result = await dialog.showOpenDialog(bubble, { title: '导入角色动作配置', filters: [{ name: '角色配置', extensions: ['json'] }], properties: ['openFile'] });
    if (result.canceled) return;
    await setSkin(result.filePaths[0]); settings.update({ skinPath: result.filePaths[0] }); publish();
  });
  handle('pet:bubble', (open: boolean) => { if (typeof open !== 'boolean') return; if (open) quickView = 'chat'; showBubble(open); });
  handle('pet:bubble-mode', (mode: BubbleMode, tab?: PanelTab) => {
    if (!['hidden', 'quick', 'panel'].includes(mode) || (tab !== undefined && !['chat', 'settings', 'history'].includes(tab))) throw new Error('无效的气泡模式。');
    if (mode === 'quick') quickView = 'chat'; showBubbleMode(mode, tab);
  });
  handle('pet:quota-open', openQuota);
  handle('pet:compose-open', openComposer);
  handle('pet:reply-show', showReply);
  handle('pet:quota-refresh', () => assistant.refreshQuota());
  handle('pet:context-menu', () => { petMenu().popup({ window: pet }); });
  handle('pet:quick-layout', (layout: QuickLayoutRequest) => {
    if (bubbleMode !== 'quick' || layout?.id !== bubbleRevision) return;
    const maxWidth = quickLayoutContext().maxWidth;
    if (![layout.width, layout.height, ...Object.values(layout.body ?? {})].every(Number.isFinite) || layout.width < 80 || layout.width > maxWidth || layout.height < 88 || layout.height > 360 || !Array.isArray(layout.regions) || layout.regions.length > 30) throw new Error('气泡布局无效。');
    const fits = (rect: {x: number;y: number;width: number;height: number}) => [rect.x,rect.y,rect.width,rect.height].every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.width >= 0 && rect.height >= 0 && rect.x + rect.width <= layout.width + 1 && rect.y + rect.height <= layout.height + 1;
    if (!fits(layout.body) || layout.regions.some(rect => !fits(rect) || !Number.isFinite(rect.radius))) throw new Error('气泡布局超出窗口。');
    const key = JSON.stringify(layout);
    if (key === quickLayoutKey) return;
    quickLayoutKey = key;
    recordPerformance({ stage: 'layout-commit', id: layout.id, view: quickView, elapsedMs: Math.round(performance.now() - quickOpenedAt) });
    quickWidth = layout.width; quickHeight = quickView === 'quota' ? 340 : layout.height; quickBody = layout.body; quickRegions = layout.regions;
    positionBubble(); publish();
  });
  handle('pet:quick-ready', (id: number) => {
    if (bubbleMode !== 'quick' || id !== bubbleRevision || !quickBody || userHidden) return;
    quickAwaitingLayout = false;
    if (!bubble.isVisible()) { pendingQuickFocus ? bubble.show() : bubble.showInactive(); outsideClickMonitor?.setQuickVisible(true); recordPerformance({ stage: 'window-visible', id, view: quickView, elapsedMs: Math.round(performance.now() - quickOpenedAt) }); }
  });
  handle('pet:quick-height', (height: number) => { if (bubbleMode !== 'quick' || !Number.isFinite(height)) return; const next = Math.max(88, Math.min(360, Math.ceil(height))); if (quickHeight !== next) { quickHeight = next; positionBubble(); publish(); } });
  handle('pet:drag', (dx: number, dy: number) => {
    if (![dx, dy].every(Number.isFinite) || Math.abs(dx) > 2000 || Math.abs(dy) > 2000) return;
    draggingUntil = performance.now() + 500;
    const p = pet.getBounds(), candidate = { ...p, x: p.x + dx, y: p.y + dy };
    const dropped = clampRect(candidate, screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
    pet.setBounds(dropped); pauseRoaming(dropped); if (bubbleOpen) positionBubble(); publish();
  });
  handle('pet:projects-discover', () => projects.discover());
  handle('pet:project-open', (id: string) => projects.open(id));
  handle('pet:project-continue', (id: string, prompt: string) => projects.send(id, prompt));
  handle('pet:project-refresh', () => projects.refresh());
  handle('pet:project-not-sent', () => projects.confirmNotSent());
  handle('pet:browser-show', () => tools.showBrowser());
  handle('pet:browser-reconnect', async () => { await tools.disconnectBrowser(); await tools.connectBrowser(await browserSetup.getConnectionConfig()); });
  handle('pet:browser-detect', () => browserSetup.detect());
  handle('pet:browser-profile', async (id: string) => { if (assistant.getSnapshot().activeTurnId) throw new Error('请先停止当前任务，再切换 Chrome 用户。'); if (id !== browserSetup.getSnapshot().selectedProfileId) await tools.disconnectBrowser(); return browserSetup.select(id); });
  handle('pet:browser-install', () => browserSetup.install());
  handle('pet:connect-browser', async () => {
    const config = await browserSetup.getConnectionConfig();
    try { await tools.connectBrowser(config); browserSetup.setConnectionState('connected'); }
    catch (error) { browserSetup.setConnectionState('failed', error instanceof Error ? error.message : 'Chrome 连接未完成，请重新检测后再试。'); throw error; }
  });
  handle('pet:reconnect', () => assistant.reconnect());
  handle('pet:login', () => assistant.login());
  handle('pet:cancel-login', () => assistant.cancelLogin());
  handle('pet:external', (url: string) => { if (typeof url !== 'string' || url.length > 8000) throw new Error('链接无效。'); return openExternal(url); });
}
async function main() {
  app.setAppUserModelId('local.dragonpet.desktop');
  const smoke = process.argv.includes('--smoke-test');
  const dataDir = process.env.DRAGON_PET_DATA_DIR || app.getPath('userData');
  configurePerformanceLog(dataDir);
  settings = new SettingsStore(dataDir);
  const builtInSkin = path.join(__dirname, '../assets/skins/silver-dragon-frames/skin.json');
  if (settings.value.skinPath) {
    try { await setSkin(settings.value.skinPath); }
    catch { settings.update({ skinPath: null }); await setSkin(builtInSkin); }
  } else await setSkin(builtInSkin);
  protocol.handle('pet-skin', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'asset' || !skin) return new Response('', { status: 404 });
      const prefix = new URL(skin.baseUrl).pathname;
      if (!url.pathname.startsWith(prefix)) return new Response('', { status: 404 });
      const frame = decodeURIComponent(url.pathname.slice(prefix.length));
      if (!(skin.manifest.rig && rigFiles(skin.manifest.rig).includes(frame)) && !Object.values(skin.manifest.animations).some(a => a.frames.includes(frame))) return new Response('', { status: 404 });
      const real = await fs.realpath(path.join(skinRoot, frame)), relative = path.relative(skinRoot, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('', { status: 403 });
      const bytes = await fs.readFile(real);
      return new Response(bytes, { headers: { 'Content-Type': frame.endsWith('.webp') ? 'image/webp' : 'image/png' } });
    } catch { return new Response('', { status: 404 }); }
  });
  browserSetup = new BrowserSetupService({ independentDataDir: dataDir, getSettings: () => settings.value, updateSettings: patch => { settings.update(patch); publish(); }, openExternal, onChange: () => publish() });
  tools = new ToolHost({ getGrant: () => { const project = activeProject(settings.value); return structuredClone({ ...settings.value.grant, folders: [...new Set([...settings.value.grant.folders, ...(project ? [project.directory] : [])])] }); }, getTaskId: () => assistant?.getSnapshot().activeTurnId ?? null, requestApproval: input => assistant.requestApproval(input), onBrowserChange: status => { assistant?.setBrowserStatus(status); browserSetup.setConnectionState(status); } }, { browser: { getConfig: () => browserSetup.getConnectionConfig() } });
  assistant = new AssistantService({ dataDir, getSettings: () => settings.value, toolHost: tools, openExternal });
  projects = new ProjectService({ dataDir, helperPath: path.join(app.getAppPath().replace(/\.asar$/i, '.asar.unpacked'), 'dist/native/desktop-chat.exe'), getSettings: () => settings.value, saveSettings: patch => { settings.update(patch); publish(); }, listThreads: () => assistant.listProjectThreads(), readThread: id => assistant.readProjectThread(id), uniqueTitle: (id, title) => assistant.uniqueProjectTitle(id, title), openLink: async url => { if (!/^codex:\/\/threads\/[0-9a-f-]{36}$/i.test(url)) throw new Error('对话链接无效。'); await shell.openExternal(url); }, choose: (question, choices) => assistant.chooseLocal(question, choices), notify: text => assistant.notifyLocal(text), changed: () => publish() });
  await projects.initialize();
  const chatConfig=async()=>({...await browserSetup.getConnectionConfig(),userDataDir:path.join(dataDir,'chat','browser-profile'),profileDirectory:'Default'});
  chat=new ChatService({dataDir,getSettings:()=>settings.value.chat!,saveModel:model=>settings.update({chat:{...settings.value.chat!,model}}),createBrowser:async()=>new ChatChrome(await chatConfig()),openLogin:async()=>openManualChatLogin(await chatConfig()),changed:chatChanged});
  const securePreferences = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true };
  pet = new BrowserWindow({ width: Math.round(200 * settings.value.scale), height: Math.round(240 * settings.value.scale), frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false, skipTaskbar: true, focusable: false, show: false, webPreferences: securePreferences });
  bubble = new BrowserWindow({ width: 440, height: 680, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false, skipTaskbar: true, show: false, webPreferences: { ...securePreferences, backgroundThrottling: false } });
  const pointInside = (point: { x: number; y: number }, bounds: Electron.Rectangle) => point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;
  const pointOnPet = (point: { x: number; y: number }) => { const bounds = pet.getBounds(); return pet.isVisible() && pointInside(point, bounds) && spriteHit(point.x - bounds.x, point.y - bounds.y, bounds.width, bounds.height); };
  outsideClickMonitor = new QuickOutsideClickMonitor({
    helperPath: rawMouseHelperPath(app.getAppPath()),
    onMouseDown: ({ x, y }) => {
      if (bubbleMode !== 'quick' || !bubble.isVisible()) return;
      const point = screen.screenToDipPoint({ x, y });
      const rect = bubble.getBounds();
      const target = bubbleHit(point.x - rect.x, point.y - rect.y) ? 'bubble' : pointOnPet(point) ? 'pet' : 'outside';
      if (shouldDismissQuickClick(bubbleMode, target)) showBubbleMode('hidden');
    },
    onUnavailable: message => console.warn(message),
  });
  for (const win of [pet, bubble]) {
    win.setAlwaysOnTop(settings.value.alwaysOnTop, 'floating'); win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(({ url }) => { void openExternal(url).catch(() => {}); return { action: 'deny' }; });
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  }
  const area = screen.getPrimaryDisplay().workArea;
  pet.setPosition(area.x + area.width - pet.getBounds().width - 50, area.y + area.height - pet.getBounds().height - 32);
  pauseRoaming(pet.getBounds(), 4000);
  installHandlers();
  assistant.on('change', () => {
    const current = assistant.getSnapshot(), activity = current.activity, pendingId = current.pending[0]?.id ?? null;
    if (pendingId && pendingId !== lastPendingId && !userHidden && pet.isVisible() && bubbleMode === 'quick' && quickView === 'compose') { quickView = 'chat'; showBubbleMode('quick', panelTab, false); }
    lastPendingId = pendingId;
    if (!userHidden && pet.isVisible() && bubbleMode === 'hidden' && activity !== lastActivity && ['awaiting-input', 'awaiting-approval', 'error'].includes(activity)) {
      quickView = 'chat';
      showBubbleMode('quick', panelTab, false);
    }
    lastActivity = activity; publish();
  });
  const html = path.join(__dirname, '../renderer/index.html');
  await Promise.all([pet.loadFile(html, { query: { view: 'pet' } }), bubble.loadFile(html, { query: { view: 'bubble' } })]);
  const icon = nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="2" y="2" width="28" height="28" rx="10" fill="#397b69"/><path d="M9 22L12 9l4 5 4-5 3 13z" fill="#f6efdc"/><circle cx="14" cy="19" r="1"/><circle cx="20" cy="19" r="1"/></svg>').toString('base64'));
  // Electron's native SVG decoding varies by platform; use a generated bitmap fallback.
  const trayIcon = icon.isEmpty() ? nativeImage.createFromBitmap(Buffer.from(Array.from({ length: 16 * 16 }, () => [105, 130, 55, 255]).flat()), { width: 16, height: 16 }) : icon;
  tray = new Tray(trayIcon); tray.setToolTip('龙娘桌宠');
  tray.setContextMenu(petMenu()); tray.on('right-click', () => tray.setContextMenu(petMenu())); tray.on('double-click', () => { userHidden = false; quickView = 'chat'; pet.showInactive(); showBubbleMode('quick'); });
  screen.on('display-removed', ensureVisible); screen.on('display-metrics-changed', ensureVisible);
  pet.on('move', () => { if (bubbleOpen) { positionBubble(); publish(); } });
  bubble.on('close', event => { if (!shuttingDown) { event.preventDefault(); showBubble(false); } });
  bubble.on('blur', () => { if (bubbleMode === 'quick' && !quickAwaitingLayout && !pointOnPet(screen.getCursorScreenPoint())) showBubbleMode('hidden'); });
  app.on('second-instance', () => { userHidden = false; quickView = 'chat'; pet.showInactive(); showBubbleMode('quick'); });
  if (smoke) {
    pet.showInactive();
    const state = snapshot();
    const startup = { version: state.version, bridge: await bubble.webContents.executeJavaScript('typeof window.pet.send'), skinMissing: !state.skin, skinName: state.skin?.manifest.name, skinKind: state.skin?.manifest.rig ? 'rig' : 'frames', rigViews: Object.keys(state.skin?.manifest.rig?.views ?? {}), rigLayers: Object.values(state.skin?.manifest.rig?.views ?? {}).map(view => view.layers.length), bubbleMode: state.bubbleMode, animations: Object.keys(state.skin?.manifest.animations ?? {}).length, animationFrameCounts: Object.fromEntries(Object.entries(state.skin?.manifest.animations ?? {}).map(([key, animation]) => [key, animationFrameCount(animation)])), roamingAnimation: roamingAnimationMotion(state.skin?.manifest) };
    const spriteLoaded = await pet.webContents.executeJavaScript(`new Promise(resolve => { const started = Date.now(); const check = () => { const image = document.querySelector('.pet-sprite'), canvas = document.querySelector('canvas.rig-canvas'); if ((canvas?.dataset.rigReady === 'true' && Number(canvas.dataset.rigRenderCount) > 1) || (image && image.complete && image.naturalWidth > 0)) resolve(true); else if (Date.now() - started > 8000) resolve(false); else setTimeout(check, 100); }; check(); })`);
    if (!spriteLoaded) throw new Error('内置龙娘动画未能载入。');
    await fs.writeFile(path.join(dataDir, 'smoke-result.json'), JSON.stringify({ ...startup, spriteLoaded, windows: BrowserWindow.getAllWindows().length, ok: true }));
    app.quit(); return;
  }
  pet.showInactive(); timer = setInterval(tick, ROAMING_TICK_MS);
  void browserSetup.detect();
  await assistant.initialize().catch(() => {}); publish();
}
app.whenReady().then(main).catch(error => { console.error('桌宠启动失败：', error); if (!process.argv.includes('--smoke-test')) dialog.showErrorBox('龙娘桌宠启动失败', error instanceof Error ? error.message : String(error)); app.exit(1); });
app.on('before-quit', event => {
  if (shuttingDown) return;
  event.preventDefault(); shuttingDown = true;
  if (timer) clearInterval(timer);
  outsideClickMonitor?.dispose();
  void Promise.allSettled([chat?.dispose(), projects?.dispose(), assistant?.dispose(), tools?.dispose()]).finally(async () => { await flushPerformanceLog(); app.quit(); });
  setTimeout(() => app.exit(0), 4000).unref();
});
app.on('window-all-closed', () => { if (shuttingDown) app.quit(); });
