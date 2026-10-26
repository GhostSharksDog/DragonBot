import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { AppSnapshot, ApprovalDecision, ApprovalRequest, ModelInfo, PendingInteraction, QuestionRequest, Settings, SkinData } from '../shared/types';
import { skinFrameLayout, skinRegionClipPath } from '../shared/types';
import { Egg, Icon, type IconName } from './icons';
import { activityLabels, Pet } from './Pet';
import { QuickBubble, QuickBubbleFrame } from './QuickBubble';
import { QuotaBubble } from './QuotaBubble';
import { ProjectSettings } from './ProjectSettings';
import { RigCanvas } from './RigCanvas';
import type { RigPlayback } from '../shared/rig';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function useSnapshot() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!window.pet) { setError('请从桌面应用打开龙娘桌宠。'); return; }
    const unsubscribe = window.pet.onState(state => { if (alive) { setSnapshot(state); setError(null); } });
    void window.pet.getState().then(state => { if (alive) setSnapshot(previous => previous ?? state); }).catch(reason => { if (alive) setError(errorText(reason)); });
    return () => { alive = false; unsubscribe(); };
  }, []);
  return { snapshot, error };
}

export function App({ view }: { view: 'pet' | 'bubble' }) {
  const { snapshot, error } = useSnapshot();
  if (view === 'pet') return <Pet snapshot={snapshot} />;
  if (!snapshot) return <main className="bubble-shell loading-shell"><Egg className="loading-egg" /><h1>龙娘桌宠</h1><p>{error ?? '正在连接你的桌面小搭档…'}</p>{error && window.pet && <button className="button primary" onClick={() => { void window.pet.reconnect().catch(() => undefined); }}>重新连接</button>}</main>;
  return <Bubble snapshot={snapshot} />;
}

function IconButton({ icon, title, onClick, disabled = false, active = false }: { icon: IconName; title: string; onClick(): void; disabled?: boolean; active?: boolean }) {
  return <button type="button" className={`icon-button${active ? ' selected' : ''}`} title={title} aria-label={title} aria-pressed={active || undefined} onClick={onClick} disabled={disabled}><Icon name={icon} /></button>;
}

function SkinThumbnail({ skin, className = '' }: { skin: SkinData | null; className?: string }) {
  const container = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ width: 74, height: 83 });
  const playback = useRef<RigPlayback>({ control: { activity: 'idle', motion: 'idle', direction: 'right' }, startedAt: Date.now() });
  const idle = skin?.manifest.animations.idle;
  const layout = skin && idle ? skinFrameLayout(skin.manifest, idle, 0) : null;
  const framePath = layout?.frame;
  const src = framePath && skin ? new URL(framePath, skin.baseUrl.endsWith('/') ? skin.baseUrl : `${skin.baseUrl}/`).href : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const rigKey = `${skin?.baseUrl ?? ''}#rig`;
  const loaded = skin?.manifest.rig ? failedSource !== rigKey : Boolean(src && src !== failedSource && skin);
  useEffect(() => {
    const element = container.current;
    if (!element || !skin?.manifest.rig) return;
    const measure = () => { const bounds = element.getBoundingClientRect(); setSize(previous => previous.width === bounds.width && previous.height === bounds.height ? previous : { width: bounds.width, height: bounds.height }); };
    const observer = new ResizeObserver(measure); observer.observe(element); measure(); return () => observer.disconnect();
  }, [skin?.baseUrl, Boolean(skin?.manifest.rig)]);
  return <span ref={container} className={`skin-thumbnail ${className}${loaded ? ' has-character' : ''}`} role="img" aria-label={loaded ? `角色预览：${skin!.manifest.name}` : skin ? '临时龙蛋（角色预览无法加载）' : '临时龙蛋'}>
    {loaded && skin?.manifest.rig ? <RigCanvas className="rig-thumbnail" skin={skin} playback={playback.current} width={size.width} height={size.height} onError={() => setFailedSource(rigKey)} /> : loaded && skin && layout ? <span className="thumbnail-cell" style={{ width: `min(100%, calc(var(--preview-height) * ${skin.manifest.width / skin.manifest.height}))`, height: `min(100%, calc(var(--preview-width) * ${skin.manifest.height / skin.manifest.width}))`, transform: idle?.flipX ? 'scaleX(-1)' : undefined }}><span className="thumbnail-crop" style={{ left: `${layout.destination.x / skin.manifest.width * 100}%`, top: `${layout.destination.y / skin.manifest.height * 100}%`, width: `${layout.destination.width / skin.manifest.width * 100}%`, height: `${layout.destination.height / skin.manifest.height * 100}%`, clipPath: skinRegionClipPath(layout.crop) }}><img src={src!} alt="" draggable={false} onError={() => setFailedSource(src)} style={{ width: `${layout.image.width / layout.destination.width * 100}%`, height: `${layout.image.height / layout.destination.height * 100}%`, left: `${layout.image.left / layout.destination.width * 100}%`, top: `${layout.image.top / layout.destination.height * 100}%` }} /></span></span> : <Egg className="thumbnail-egg" />}
  </span>;
}

function Bubble({ snapshot }: { snapshot: AppSnapshot }) {
  const [tab, setTab] = useState<'chat' | 'settings' | 'history'>('chat');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionDraft>>({});
  const [expandedReply, setExpandedReply] = useState(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const pendingActions = useRef(new Set<string>());
  const resolved = useRef(new Set<string>());
  const composing = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lastInteractionKey = useRef('');
  const lastChatElement = useRef<HTMLDivElement | null>(null);
  const { assistant, settings } = snapshot;
  const mode = snapshot.bubbleMode ?? 'panel';
  const active = Boolean(assistant.activeTurnId);
  const codexConnecting = busy.has('reconnect') || busy.has('login') || ['connecting', 'reconnecting'].includes(assistant.connection ?? '') || ['checking', 'opening-browser', 'waiting-browser'].includes(assistant.login ?? '');

  const perform = useCallback(async (key: string, operation: () => Promise<unknown>) => {
    if (pendingActions.current.has(key)) return false;
    pendingActions.current.add(key);
    setBusy(new Set(pendingActions.current));
    setError(null);
    try { await operation(); return true; }
    catch (reason) { setError(errorText(reason)); return false; }
    finally { pendingActions.current.delete(key); setBusy(new Set(pendingActions.current)); }
  }, []);
  const update = (patch: Partial<Settings>) => perform('settings', () => window.pet.updateSettings(patch));
  useEffect(() => {
    const ids = new Set(snapshot.assistant.pending.map(item => item.id));
    for (const id of resolved.current) if (!ids.has(id)) resolved.current.delete(id);
    setDone(new Set(resolved.current));
    setQuestionDrafts(current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
  }, [snapshot.assistant.pending]);
  useEffect(() => {
    const element = chatScroll.current;
    if (!element) return;
    const key = assistant.pending.map(item => item.id).join('|');
    const focusRequest = assistant.pending.length > 0 && (key !== lastInteractionKey.current || element !== lastChatElement.current);
    if (key !== lastInteractionKey.current) setError(null);
    lastInteractionKey.current = key;
    lastChatElement.current = element;
    if (focusRequest) {
      const card = element.querySelector<HTMLElement>('.interaction-card');
      if (card) element.scrollTo({ top: card.offsetTop - element.offsetTop - 12, behavior: 'instant' });
    } else if (nearBottom.current && !assistant.pending.length) {
      element.scrollTo({ top: assistant.messages.length ? element.scrollHeight : 0, behavior: 'instant' });
    }
  }, [assistant.messages, assistant.pending, tab]);
  useEffect(() => { if (mode === 'panel') setTab(snapshot.panelTab ?? 'chat'); }, [mode, snapshot.panelTab]);
  useEffect(() => { composing.current = false; }, [mode, snapshot.quickView]);
  useEffect(() => {
    if (mode !== 'panel') return;
    const input = composer.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(108, input.scrollHeight)}px`;
  }, [draft, mode]);

  const assistantReply = [...assistant.messages].reverse().find(message => message.role === 'assistant') ?? null;
  const handoff = snapshot.projectHandoff;
  const lastMessageAt = [...assistant.messages].reverse().find(message => message.role === 'user')?.createdAt ?? 0;
  const reply = handoff?.message && !active && (handoff.startedAt ?? handoff.updatedAt) >= lastMessageAt
    ? { id: handoff.id, role: 'assistant' as const, text: handoff.message, createdAt: handoff.updatedAt }
    : assistantReply;
  useEffect(() => { setExpandedReply(false); }, [reply?.id]);
  const lastThread = useRef(assistant.threadId);
  useEffect(() => {
    if (lastThread.current !== assistant.threadId) {
      // The first send creates its thread; preserve anything typed while that send is starting.
      if (lastThread.current !== null) { setDraft(''); setQuestionDrafts({}); setExpandedReply(false); }
      lastThread.current = assistant.threadId;
    }
  }, [assistant.threadId]);

  async function send() {
    const text = draft.trim();
    if (!text || !latest.current.assistant.connected || pendingActions.current.has('send')) return;
    const succeeded = await perform('send', () => window.pet.send(text));
    if (succeeded) { setDraft(current => current.trim() === text ? '' : current); nearBottom.current = true; }
  }
  async function respond(id: string, operation: () => Promise<void>) {
    if (resolved.current.has(id) || !latest.current.assistant.pending.some(item => item.id === id)) return false;
    const succeeded = await perform(`request:${id}`, operation);
    if (succeeded) { resolved.current.add(id); setDone(new Set(resolved.current)); nearBottom.current = true; }
    return succeeded;
  }
  const openExternal = (url: string) => { void perform('external', () => window.pet.openExternal(url)); };
  const connectionStatus = assistant.login === 'waiting-browser' ? '等待你在浏览器中完成登录' : assistant.login === 'opening-browser' ? '正在打开登录页面' : assistant.login === 'checking' ? '正在检查登录状态' : '正在连接 Codex';
  const status = assistant.pending.length ? (assistant.pending[0].kind === 'approval' ? '有一件事，需要你批准' : '我想再确认一下') : codexConnecting ? connectionStatus : assistant.connected ? activityLabels[assistant.activity] : '还没连接到 Codex';
  const footerStatus = active ? '任务进行中 · 可以继续补充要求' : 'Enter 发送 · Shift + Enter 换行';
  const chooseTab = (next: 'chat' | 'settings' | 'history') => { setTab(next); void window.pet.setBubbleMode('panel', next).catch(reason => setError(errorText(reason))); };
  const interaction = (request: PendingInteraction, compact: boolean) => <Interaction key={request.id} request={request} compact={compact} draft={questionDrafts[request.id] ?? { values: {}, custom: {}, step: 0 }} onDraft={next => setQuestionDrafts(current => ({ ...current, [request.id]: next }))} locked={busy.has(`request:${request.id}`) || done.has(request.id)} onApprove={decision => respond(request.id, () => window.pet.approve(request.id, decision))} onAnswer={answers => respond(request.id, () => window.pet.answer({ id: request.id, answers }))} />;
  async function refreshQuota() {
    if (pendingActions.current.has('quota')) return;
    pendingActions.current.add('quota'); setBusy(new Set(pendingActions.current)); setQuotaError(null);
    try { await window.pet.refreshQuota(); } catch (reason) { setQuotaError(errorText(reason)); }
    finally { pendingActions.current.delete('quota'); setBusy(new Set(pendingActions.current)); }
  }
  if (mode === 'hidden') return null;
  if (mode === 'quick' && snapshot.quickView === 'quota') return <QuotaBubble snapshot={snapshot} refreshing={busy.has('quota')} refresh={() => { void refreshQuota(); }} error={quotaError} back={() => { void window.pet.showReply().catch(reason => setQuotaError(errorText(reason))); }} close={() => { void window.pet.setBubbleMode('hidden').catch(reason => setQuotaError(errorText(reason))); }} />;
  if (mode === 'quick') {
    const pending = assistant.pending[0];
    const questionStep = pending?.kind === 'question' ? Math.max(0, Math.min(questionDrafts[pending.id]?.step ?? 0, pending.questions.length - 1)) : 0;
    const question = pending?.kind === 'question' ? pending.questions[questionStep] : null;
    if (pending?.kind === 'question' && snapshot.quickView !== 'compose') return <QuestionBubbles snapshot={snapshot} request={pending} draft={questionDrafts[pending.id] ?? { values: {}, custom: {}, step: 0 }} onDraft={next => setQuestionDrafts(current => ({ ...current, [pending.id]: next }))} locked={busy.has(`request:${pending.id}`) || done.has(pending.id)} answer={answers => respond(pending.id, () => window.pet.answer({ id: pending.id, answers }))} />;
    const questionPrompt = question ? <div className="quick-question-prompt"><p className="quick-reply-text">{question.question}</p><p className="quick-status">点击旁边的聊天图标回答。{pending?.kind === 'question' && pending.questions.length > 1 ? `（${questionStep + 1}/${pending.questions.length}）` : ''}</p></div> : null;
    return <QuickBubble layout={snapshot.quickLayout} shape={snapshot.quickShape} compose={snapshot.quickView === 'compose'} draft={draft} setDraft={setDraft} inputRef={composer} reply={reply} expanded={expandedReply} setExpanded={setExpandedReply} interaction={pending ? interaction(pending, true) : null} questionPrompt={questionPrompt} interactionCount={assistant.pending.length} approval={pending?.kind === 'approval'} connected={assistant.connected} active={active} thinking={active && assistant.activity === 'thinking'} sending={busy.has('send')} error={error || assistant.error} status={status} send={send} close={() => { void perform('collapse', () => window.pet.setBubbleMode('hidden')); }} />;
  }

  return <main className="bubble-shell">
    <header className="app-header">
      <div className="brand-mark"><Icon name="spark" size={21} /></div>
      <div className="brand"><h1>龙娘桌宠 <span>桌面小搭档</span></h1><p><i className={`connection-dot ${assistant.connected ? 'online' : ''}`} />{status}</p></div>
      <IconButton icon="minus" title="收起气泡" onClick={() => { void perform('collapse', () => window.pet.setBubbleMode('hidden')); }} />
    </header>
    <nav className="app-nav" aria-label="气泡导航">
      <button className={tab === 'chat' ? 'active' : ''} onClick={() => chooseTab('chat')}>聊一聊{assistant.pending.length > 0 && <span className="count">{assistant.pending.length}</span>}</button>
      <button className={tab === 'history' ? 'active' : ''} onClick={() => chooseTab('history')}>过去的对话</button>
      <div className="nav-spacer" />
      <IconButton icon="plus" title="开始新对话" disabled={active || busy.has('new')} onClick={() => { void perform('new', () => window.pet.newThread()).then(ok => { if (ok) { chooseTab('chat'); setDraft(''); } }); }} />
      <IconButton icon="settings" title="桌宠与任务设置" active={tab === 'settings'} onClick={() => chooseTab(tab === 'settings' ? 'chat' : 'settings')} />
    </nav>

    {(error || assistant.error) && <div className="error-banner" role="alert"><span>{error || assistant.error}</span>{error && <button aria-label="关闭错误提示" onClick={() => setError(null)}><Icon name="close" size={14} /></button>}</div>}

    {tab === 'chat' && <>
      {!assistant.connected && <div className="connection-banner"><div><strong>{codexConnecting ? connectionStatus : '连接你的 Codex'}</strong><span>{assistant.login === 'waiting-browser' ? '完成登录后，我会在这里继续。' : '使用这台电脑上的账号继续。'}</span></div><button className="button small" disabled={codexConnecting} onClick={() => { void perform('reconnect', () => window.pet.reconnect()); }}>{assistant.connection === 'connecting' || assistant.connection === 'reconnecting' || busy.has('reconnect') ? '正在连接…' : '重新连接'}</button>{assistant.login === 'waiting-browser' ? <button className="text-button" disabled={busy.has('cancel-login')} onClick={() => { void perform('cancel-login', () => window.pet.cancelLogin()); }}>{busy.has('cancel-login') ? '正在取消…' : '取消登录'}</button> : <button className="text-button" disabled={codexConnecting} onClick={() => { void perform('login', () => window.pet.login()); }}>登录</button>}</div>}
      <div className="chat-scroll" ref={chatScroll} onScroll={event => { const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop < 72; }}>
        {!assistant.messages.length && <div className={`welcome${snapshot.skin ? ' has-skin' : ''}`}>
          <div className={`welcome-orbit${snapshot.skin ? ' is-character' : ''}`}><SkinThumbnail skin={snapshot.skin} className="welcome-character" /><span className="orbit-dot" /></div>
          <span className="eyebrow">你的桌面小搭档</span>
          <h2>有事，叫我一声。</h2>
          <p>陪你聊聊，也帮你做事。<br />需要确认的地方，我会停下来问你。</p>
          <div className="suggestions"><button onClick={() => { setDraft('帮我整理一个文件夹，先和我确认整理方式。'); composer.current?.focus(); }}><Icon name="folder" size={16} /><span>一起整理文件</span><Icon name="arrow" size={15} /></button><button onClick={() => { setDraft('帮我看看我选择的 Chrome 网页，总结重点。'); composer.current?.focus(); }}><Icon name="globe" size={16} /><span>帮我看看网页</span><Icon name="arrow" size={15} /></button></div>
          {!snapshot.skin && <div className="art-notice"><Icon name="image" size={16} /><span><strong>尚未载入角色动画</strong>现在由临时龙蛋陪你。可在设置里导入可用的角色素材。</span></div>}
        </div>}
        <div className="message-list" aria-live="polite" aria-relevant="additions text">
          {assistant.messages.map(message => <article className={`message ${message.role}`} key={message.id}><div className="message-byline">{message.role === 'assistant' ? <><Icon name="spark" size={12} /> 龙娘</> : message.role === 'user' ? '你' : '任务提示'}<time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><MessageBody text={message.text} openExternal={openExternal} /></article>)}
          {active && assistant.activity === 'thinking' && <div className="thinking"><span><i /><i /><i /></span>正在想办法</div>}
        </div>
        {assistant.pending.map(request => interaction(request, false))}
      </div>
      <div className="composer-area">
        <div className="scope-line"><button onClick={() => chooseTab('settings')} title="查看本次任务可用范围"><Icon name="shield" size={13} />任务范围<span>{settings.grant.folders.length} 个文件夹 · {settings.grant.origins.length} 个网站</span></button><button className={assistant.browser === 'connected' ? 'browser-ready' : ''} disabled={assistant.browser === 'connecting' || busy.has('browser')} onClick={() => { void perform('browser', () => window.pet.connectBrowser()); }} title="打开桌宠的独立 Chrome；首次使用需在独立窗口登录"><Icon name="globe" size={13} />{assistant.browser === 'connected' ? 'Chrome 已连接' : assistant.browser === 'connecting' ? '连接中…' : '连接 Chrome'}</button></div>
        <div className="composer"><textarea ref={composer} value={draft} rows={2} aria-label="对龙娘说点什么" placeholder={active ? '还想补充什么？' : '对龙娘说点什么，或交给我一件事…'} maxLength={50000} onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
        }} />
          <div className="composer-bottom"><span>{active ? '正在做事' : '随时听你说'}<i /></span><div>{active && <button className="stop-button" disabled={busy.has('stop')} onClick={() => { void perform('stop', () => window.pet.stop()); }}><Icon name="stop" size={12} />停止</button>}<button className="send-button" disabled={!draft.trim() || !assistant.connected || busy.has('send')} title={active ? '补充任务要求' : '发送消息'} aria-label={active ? '补充任务要求' : '发送消息'} onClick={() => { void send(); }}><Icon name="arrow" size={19} /></button></div></div>
        </div><p className="composer-hint">{footerStatus}</p>
      </div>
    </>}
    {tab === 'settings' && <SettingsView snapshot={snapshot} busy={busy} update={update} perform={perform} openExternal={openExternal} />}
    {tab === 'history' && <section className="settings-scroll history-view"><div className="section-heading"><span className="eyebrow">留在本机的记忆</span><h2>过去的对话</h2><p>选择一段对话，接着聊下去。</p></div>{assistant.threads.length ? <div className="thread-list">{assistant.threads.map(thread => <button key={thread.id} disabled={active || busy.has('resume') || thread.id === assistant.threadId} className={thread.id === assistant.threadId ? 'current' : ''} onClick={() => { void perform('resume', () => window.pet.resumeThread(thread.id)).then(ok => { if (ok) { chooseTab('chat'); nearBottom.current = true; } }); }}><div><strong>{thread.title || '新的对话'}</strong><span>{new Date(thread.updatedAt).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>{thread.id === assistant.threadId ? <span className="current-label">当前</span> : <Icon name="chevron" size={15} />}</button>)}</div> : <div className="empty-history"><Icon name="history" size={30} /><p>第一段故事，从现在开始。</p></div>}{active && <p className="field-hint">等当前任务结束后，就可以切换对话。</p>}</section>}
    <footer className="app-footer"><span><i />{assistant.account || '本地桌宠'} · 记录保存在本机</span><span>v{snapshot.version}</span></footer>
  </main>;
}

function MessageBody({ text, openExternal }: { text: string; openExternal(url: string): void }) {
  const blocks = text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g);
  return <div className="message-body">{blocks.map((block, index) => {
    if (block.startsWith('```')) {
      const end = block.indexOf('\n');
      return <div className="code-block" key={index}>{block.slice(3, end).trim() && <span>{block.slice(3, end).trim()}</span>}<pre><code>{block.slice(end + 1).replace(/```$/, '')}</code></pre></div>;
    }
    return <div className="message-prose" key={index}>{block.split(/(https?:\/\/[^\s<>]+|`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, i) => part.startsWith('https://') || part.startsWith('http://') ? <button className="message-link" key={i} onClick={() => openExternal(part)}>{part}</button> : part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>)}</div>;
  })}</div>;
}

interface QuestionDraft { values: Record<string, string>; custom: Record<string, boolean>; step: number }
function QuestionBubbles({ snapshot, request, draft, onDraft, locked, answer }: { snapshot: AppSnapshot; request: QuestionRequest; draft: QuestionDraft; onDraft(draft: QuestionDraft): void; locked: boolean; answer(answers: Record<string, string[]>): Promise<boolean> }) {
  const step = Math.min(draft.step, request.questions.length - 1), question = request.questions[step];
  const submitting = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => { submitting.current = false; setError(''); }, [request.id, step]);
  async function select(value: string) {
    if (locked || submitting.current) return;
    submitting.current = true;
    const values = { ...draft.values, [question.id]: value };
    const next = { ...draft, values, custom: { ...draft.custom, [question.id]: false }, step: Math.min(step + 1, request.questions.length - 1) };
    onDraft(next);
    if (step < request.questions.length - 1) return;
    const missing = request.questions.findIndex(item => !values[item.id]?.trim());
    if (missing >= 0) { onDraft({ ...next, step: missing }); return; }
    try { if (!await answer(Object.fromEntries(request.questions.map(item => [item.id, [values[item.id].trim()]])))) submitting.current = false; }
    catch (reason) { setError(errorText(reason)); submitting.current = false; }
  }
  return <QuickBubbleFrame shape={snapshot.quickShape} layout={snapshot.quickLayout} close={() => { void window.pet.setBubbleMode('hidden'); }} choices={question.options?.length ? <>{question.options.map((option, index) => <button key={`${question.id}-${index}`} className="choice-bubble" disabled={locked} aria-pressed={draft.values[question.id] === option.label} title={option.description} onClick={event => { if (event.detail < 2) void select(option.label); }}><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</button>)}</> : undefined}>
    <div className="quick-question-prompt"><p className="quick-reply-text">{question.question}</p></div>
    {request.questions.length > 1 && <div className="question-progress"><span>{step + 1} / {request.questions.length}</span>{step > 0 && <button className="text-button" disabled={locked} onClick={() => onDraft({ ...draft, step: step - 1 })}>上一题</button>}</div>}
    {!question.options?.length && <p className="quick-status">点聊天图标输入回答。</p>}
    {locked && <p className="quick-status">正在提交…</p>}{error && <p className="quick-error">{error}</p>}
  </QuickBubbleFrame>;
}
function Interaction({ request, locked, compact, draft, onDraft, onApprove, onAnswer }: { request: PendingInteraction; locked: boolean; compact: boolean; draft: QuestionDraft; onDraft(draft: QuestionDraft): void; onApprove(decision: ApprovalDecision): Promise<boolean>; onAnswer(answers: Record<string, string[]>): Promise<boolean> }) {
  if (request.kind === 'approval') return <ApprovalCard request={request} locked={locked} compact={compact} approve={onApprove} />;
  return <QuestionCard request={request} locked={locked} compact={compact} draft={draft} onDraft={onDraft} answer={onAnswer} />;
}

function ApprovalCard({ request, locked, compact, approve }: { request: ApprovalRequest; locked: boolean; compact: boolean; approve(decision: ApprovalDecision): Promise<boolean> }) {
  const details = <div className="request-details">{request.details.map((detail, index) => <pre key={index}>{detail}</pre>)}</div>;
  return <section className="interaction-card approval-card" aria-label="等待批准">{!compact && <div className="interaction-label"><Icon name="shield" size={15} />需要你批准<span>等待回应</span></div>}<h3>{request.title}</h3><p>{request.description}</p>{request.details.length > 0 && (compact ? <details className="compact-request-details"><summary>查看操作详情</summary>{details}</details> : details)}<div className="approval-actions"><button className="button primary" disabled={locked} onClick={() => { void approve('allow'); }}>{!compact && <Icon name="check" size={15} />}允许本次</button><button className="button" disabled={locked} onClick={() => { void approve('deny'); }}>拒绝</button><button className="text-button danger" disabled={locked} onClick={() => { void approve('stop'); }}>停止任务</button></div>{request.supportsSession && <button className="session-approval" disabled={locked} onClick={() => { void approve('session'); }}>对此请求允许到本会话结束{!compact && <Icon name="chevron" size={12} />}</button>}{(!compact || locked) && <p className="approval-note">{locked ? '正在提交回应…' : '没有你的选择，我会继续等待。'}</p>}</section>;
}

function QuestionCard({ request, locked, compact, draft, onDraft, answer }: { request: QuestionRequest; locked: boolean; compact: boolean; draft: QuestionDraft; onDraft(draft: QuestionDraft): void; answer(answers: Record<string, string[]>): Promise<boolean> }) {
  const { values, custom } = draft;
  const step = Math.max(0, Math.min(draft.step, request.questions.length - 1));
  const ready = request.questions.every(question => Boolean(values[question.id]?.trim()));
  const currentReady = Boolean(values[request.questions[step]?.id]?.trim());
  const submit = () => { if (ready) void answer(Object.fromEntries(request.questions.map(question => [question.id, [values[question.id].trim()]]))); };
  return <section className="interaction-card question-card" aria-label="等待回答"><div className="interaction-label"><Icon name="spark" size={15} />想和你确认<span>{compact && request.questions.length > 1 ? `${step + 1} / ${request.questions.length}` : '等待回应'}</span></div><h3>{request.title || '有件事想问你'}</h3>{request.questions.map((question, index) => !compact || index === step ? <fieldset key={question.id} disabled={locked}><legend>{request.questions.length > 1 && <span className="question-number">{index + 1}</span>}{question.header || '请告诉我'}</legend><p>{question.question}</p>{question.options && <div className="question-options">{question.options.map((option, i) => <button type="button" aria-pressed={values[question.id] === option.label && !custom[question.id]} className={values[question.id] === option.label && !custom[question.id] ? 'chosen' : ''} key={`${option.label}-${i}`} onClick={() => onDraft({ ...draft, values: { ...values, [question.id]: option.label }, custom: { ...custom, [question.id]: false } })}><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span><Icon name="check" size={15} /></button>)}</div>}<input className="field-input custom-answer" aria-label={`${question.header || '问题'}的文字回答`} type={question.isSecret ? 'password' : 'text'} value={custom[question.id] || !question.options?.length ? values[question.id] ?? '' : ''} placeholder={question.options?.length ? '或者，输入你的想法…' : '在这里写下回答…'} autoComplete="off" onChange={event => onDraft({ ...draft, custom: { ...custom, [question.id]: true }, values: { ...values, [question.id]: event.target.value } })} /></fieldset> : null)}<div className="question-navigation">{compact && step > 0 && <button className="button" disabled={locked} onClick={() => onDraft({ ...draft, step: step - 1 })}>上一题</button>}{compact && step < request.questions.length - 1 ? <button className="button primary answer-button" disabled={locked || !currentReady} onClick={() => onDraft({ ...draft, step: step + 1 })}>下一题<Icon name="arrow" size={15} /></button> : <button className="button primary answer-button" disabled={locked || !ready} onClick={submit}>{locked ? '正在提交…' : '回答并继续'}<Icon name="arrow" size={15} /></button>}</div></section>;
}

function SettingsView({ snapshot, busy, update, perform, openExternal }: { snapshot: AppSnapshot; busy: Set<string>; update(patch: Partial<Settings>): Promise<boolean>; perform(key: string, operation: () => Promise<unknown>): Promise<boolean>; openExternal(url: string): void }) {
  const { settings, assistant } = snapshot;
  const [origin, setOrigin] = useState('');
  const [originError, setOriginError] = useState('');
  const [scale, setScale] = useState(settings.scale);
  const adjustingScale = useRef(false);
  useEffect(() => { if (!adjustingScale.current) setScale(settings.scale); }, [settings.scale]);
  const active = Boolean(assistant.activeTurnId);
  const scopeDisabled = active || busy.has('settings');
  async function addFolder() {
    await perform('folder', async () => {
      const folder = await window.pet.chooseFolder();
      if (folder && !settings.grant.folders.includes(folder)) await window.pet.updateSettings({ grant: { ...settings.grant, folders: [...settings.grant.folders, folder] } });
    });
  }
  async function addOrigin() {
    try {
      const value = origin.trim();
      const url = new URL(value.includes('://') ? value : `https://${value}`);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('请输入完整的网站地址，例如 https://example.com。');
      if (settings.grant.origins.includes(url.origin)) { setOriginError('这个网站已经在范围内。'); return; }
      const success = await update({ grant: { ...settings.grant, origins: [...settings.grant.origins, url.origin] } });
      if (success) { setOrigin(''); setOriginError(''); }
    } catch { setOriginError('请输入有效的网站地址，例如 https://example.com。'); }
  }
  return <section className="settings-scroll">
    <div className="section-heading"><span className="eyebrow">刚刚好的陪伴</span><h2>桌宠与任务设置</h2></div>
    <section className="setting-section"><div className="setting-title"><Icon name="image" size={17} /><h3>我的形象</h3></div><div className="skin-setting"><SkinThumbnail skin={snapshot.skin} className="settings-character" /><div><strong>{snapshot.skin?.manifest.name ?? '临时龙蛋'}</strong><span>{snapshot.skin ? '已载入角色动画' : '尚未载入角色动画，请导入可用素材'}</span></div><button className="button small" disabled={busy.has('skin')} onClick={() => { void perform('skin', () => window.pet.importSkin()); }}>导入动画</button></div><div className="range-setting"><label htmlFor="pet-scale">桌宠大小 <span>{Math.round(scale * 100)}%</span></label><input id="pet-scale" aria-label="桌宠大小" type="range" min="0.65" max="1.6" step="0.05" value={scale} disabled={busy.has('settings')} onPointerDown={() => { adjustingScale.current = true; }} onChange={event => { setScale(Number(event.target.value)); }} onPointerUp={() => { adjustingScale.current = false; void update({ scale }); }} onKeyUp={() => { void update({ scale }); }} onBlur={() => { adjustingScale.current = false; if (scale !== settings.scale) void update({ scale }); }} /></div><Toggle label="自由走跑" hint="聊天、回答或等待批准时会停下" value={settings.roaming} disabled={busy.has('settings')} onChange={value => { void update({ roaming: value }); }} /><Toggle label="留在其他窗口上方" value={settings.alwaysOnTop} disabled={busy.has('settings')} onChange={value => { void update({ alwaysOnTop: value }); }} /></section>
    <section className="setting-section"><div className="setting-title"><Icon name="shield" size={17} /><h3>任务可以去哪里</h3><span>网站长期保存</span></div><p className="field-hint">文件夹按当前任务授权；网站与网页输入设置保存在本机，重启后仍有效。删除、覆盖和重要提交会再问你。</p>{active && <p className="scope-locked">当前任务进行中，结束后可调整范围。</p>}<div className="field-heading">文件夹<button className="text-button" disabled={scopeDisabled || busy.has('folder')} onClick={() => { void addFolder(); }}><Icon name="plus" size={13} />添加</button></div>{settings.grant.folders.length ? <ul className="scope-list">{settings.grant.folders.map(folder => <li key={folder}><Icon name="folder" size={14} /><span title={folder}>{folder}</span><button aria-label={`移除文件夹 ${folder}`} disabled={scopeDisabled} onClick={() => { void update({ grant: { ...settings.grant, folders: settings.grant.folders.filter(value => value !== folder) } }); }}><Icon name="close" size={13} /></button></li>)}</ul> : <p className="scope-empty">暂未开放文件夹</p>}<div className="field-heading">网站</div><ul className="scope-list">{settings.grant.origins.map(site => <li key={site}><Icon name="globe" size={14} /><span>{site}</span><button aria-label={`移除网站 ${site}`} disabled={scopeDisabled} onClick={() => { void update({ grant: { ...settings.grant, origins: settings.grant.origins.filter(value => value !== site) } }); }}><Icon name="close" size={13} /></button></li>)}</ul><div className="origin-entry"><input className="field-input" aria-label="允许访问的网站地址" value={origin} disabled={scopeDisabled} placeholder="https://example.com" onChange={event => { setOrigin(event.target.value); setOriginError(''); }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void addOrigin(); } }} /><button className="button small" disabled={scopeDisabled || !origin.trim()} onClick={() => { void addOrigin(); }}>添加</button></div>{originError && <p className="input-error" role="alert">{originError}</p>}</section>
    <ProjectSettings snapshot={snapshot} disabled={scopeDisabled} update={update} perform={perform} />
    <ChromeSetup snapshot={snapshot} busy={busy} scopeDisabled={scopeDisabled} update={update} perform={perform} openExternal={openExternal} />
    <CodexSettings snapshot={snapshot} busy={busy} update={update} perform={perform} />
  </section>;
}

function ChromeSetup({ snapshot, busy, scopeDisabled, update, perform }: { snapshot: AppSnapshot; busy: Set<string>; scopeDisabled: boolean; update(patch: Partial<Settings>): Promise<boolean>; perform(key: string, operation: () => Promise<unknown>): Promise<boolean>; openExternal(url: string): void }) {
  const {settings,browserSetup:setup}=snapshot;
  useEffect(() => { if (!setup || setup.status === 'idle') void perform('browser-detect', () => window.pet.detectBrowser()); }, []);
  const [executable,setExecutable]=useState(settings.chromeExecutablePath || '');
  const pending=busy.has('browser') || setup?.status==='awaiting-confirmation';
  return <section className="setting-section chrome-setup"><div className="setting-title"><Icon name="globe" size={17}/><h3>独立 Chrome</h3><span>{snapshot.assistant.browser==='connected'?'已连接':'自动连接'}</span></div>
    <p className="field-hint">网页任务会自动打开专属浏览器，无需安装扩展。首次登录请在这个窗口完成，以后自动保留。</p>
    <div className="chrome-status" role="status">{setup?.message || '正在检测浏览器…'}</div>
    <div className="setting-actions"><button className="button small" disabled={pending} onClick={()=>{void perform('browser',()=>window.pet.showBrowser());}}>显示浏览器</button><button className="button small" disabled={pending || scopeDisabled} onClick={()=>{void perform('browser',()=>window.pet.reconnectBrowser());}}>重新连接</button></div>
    <Toggle label="允许网页输入与选择（可能自动保存）" hint="授权网站内生效；提交、发送和付款仍需批准" value={settings.grant.browserInput ?? false} disabled={scopeDisabled} onChange={value=>{void update({grant:{...settings.grant,browserInput:value}});}}/>
    <details><summary>浏览器程序位置</summary><input className="field-input" aria-label="Chrome 程序路径" placeholder="自动检测本机 Chrome" value={executable} disabled={scopeDisabled} onChange={e=>setExecutable(e.target.value)}/><button className="button small" disabled={scopeDisabled} onClick={()=>{void update({chromeExecutablePath:executable.trim()}).then(ok=>{if(ok)void perform('browser-detect',()=>window.pet.detectBrowser());});}}>保存并检测</button></details>
    {setup?.status==='missing-browser' && <button className="text-button" onClick={()=>{void window.pet.openExternal('https://www.google.com/chrome/');}}>安装 Chrome</button>}
  </section>;
}

const effortLabel = (effort: string) => ({ none: '关闭', minimal: '最少', low: '较低', medium: '适中', high: '较高', xhigh: '极高', max: '最大', ultra: '极致' })[effort] ?? effort;
function ReasoningSetting({ model, settings, disabled, update }: { model?: ModelInfo; settings: Settings; disabled: boolean; update(patch: Partial<Settings>): Promise<boolean> }) {
  if (!model) return <p className="field-hint">选择模型后，可查看它支持的推理强度。</p>;
  const choices = model.supportedReasoningEfforts ?? [], saved = settings.reasoningByModel?.[model.id] ?? '';
  const invalid = Boolean(saved && !choices.some(choice => choice.reasoningEffort === saved));
  const save = (value: string) => { const next = { ...(settings.reasoningByModel ?? {}) }; if (value) next[model.id] = value; else delete next[model.id]; void update({ reasoningByModel: next }); };
  return <div className="reasoning-setting"><label className="field-heading" htmlFor="reasoning-effort">推理强度</label><select id="reasoning-effort" className="field-input" value={invalid ? '' : saved} disabled={disabled || !choices.length} onChange={event => save(event.target.value)}><option value="">默认{model.defaultReasoningEffort ? `（${effortLabel(model.defaultReasoningEffort)}）` : ''}</option>{choices.map(choice => <option key={choice.reasoningEffort} value={choice.reasoningEffort} title={choice.description}>{effortLabel(choice.reasoningEffort)}</option>)}</select>{invalid ? <p className="field-hint reasoning-unavailable">已保存的档位不可用，请改用默认。<button className="text-button" disabled={disabled} onClick={() => save('')}>恢复默认</button></p> : <p className="field-hint">{choices.length ? '为这个模型保存选择；切换模型后会记住。' : '当前模型未提供可选档位，使用模型默认值。'}</p>}</div>;
}

function CodexSettings({ snapshot, busy, update, perform }: { snapshot: AppSnapshot; busy: Set<string>; update(patch: Partial<Settings>): Promise<boolean>; perform(key: string, operation: () => Promise<unknown>): Promise<boolean> }) {
  const { settings, assistant } = snapshot;
  const [codexPath, setCodexPath] = useState(settings.codexPath);
  useEffect(() => setCodexPath(settings.codexPath), [settings.codexPath]);
  const active = Boolean(assistant.activeTurnId);
  const processing = busy.has('reconnect') || busy.has('login') || ['connecting', 'reconnecting'].includes(assistant.connection ?? '') || ['checking', 'opening-browser', 'waiting-browser'].includes(assistant.login ?? '');
  const stage = assistant.login === 'waiting-browser' ? '已打开登录页，等待你在浏览器中完成登录。' : assistant.login === 'opening-browser' ? '正在打开 Codex 登录页面…' : assistant.login === 'checking' ? '正在检查这台电脑上的 Codex 登录状态…' : assistant.connection === 'reconnecting' || busy.has('reconnect') ? '正在重新连接 Codex，请稍候…' : assistant.connection === 'connecting' ? '正在启动并连接本机 Codex…' : busy.has('login') ? '正在准备登录页面…' : assistant.login === 'signed-out' ? '还没有登录 Codex，点击下方“登录 Codex”继续。' : assistant.login === 'error' || assistant.connection === 'error' ? 'Codex 连接未完成，可以重新连接或再次登录。' : assistant.connected ? 'Codex 已连接，可以开始聊天或交代任务。' : 'Codex 尚未连接，可以点击“重新连接”。';
  return <section className="setting-section codex-settings"><div className="setting-title"><Icon name="spark" size={17} /><h3>Codex</h3><span>{processing ? '正在处理' : assistant.connected ? '已连接' : '未连接'}</span></div><p className="account-label">{assistant.account || '沿用本机 Codex 登录'}</p><p className="field-hint codex-status" role="status">{stage}</p>{assistant.diagnostic?.message && <p className="field-hint codex-diagnostic">{assistant.diagnostic.message}</p>}<label className="field-heading" htmlFor="model">使用模型</label><select className="field-input" id="model" value={settings.model} disabled={active || processing || busy.has('settings')} onChange={event => { void update({ model: event.target.value }); }}><option value="">账号默认模型</option>{assistant.models.map(model => <option value={model.id} key={model.id}>{model.label}{model.isDefault ? ' · 默认' : ''}</option>)}</select><ReasoningSetting model={settings.model ? assistant.models.find(model => model.id === settings.model) : (assistant.models.find(model => model.isDefault) ?? assistant.models[0])} settings={settings} disabled={active || processing || busy.has('settings')} update={update} /><details className="advanced-setting"><summary>连接设置<Icon name="chevron" size={12} /></summary><label className="field-heading" htmlFor="codex-path">Codex 程序路径</label><div className="origin-entry"><input className="field-input" id="codex-path" value={codexPath} placeholder="codex" disabled={active || processing} onChange={event => setCodexPath(event.target.value)} /><button className="button small" disabled={active || processing || busy.has('settings') || codexPath === settings.codexPath} onClick={() => { void update({ codexPath: codexPath.trim() }); }}>保存</button></div><p className="field-hint">留空时自动查找本机安装。</p></details><div className="setting-actions"><button className="button small" disabled={active || processing} onClick={() => { void perform('reconnect', () => window.pet.reconnect()); }}><Icon name="refresh" size={13} />{busy.has('reconnect') || assistant.connection === 'reconnecting' || assistant.connection === 'connecting' ? '正在连接…' : '重新连接'}</button><button className="text-button" disabled={active || processing} onClick={() => { void perform('login', () => window.pet.login()); }}>{assistant.login === 'waiting-browser' ? '等待浏览器登录…' : busy.has('login') || assistant.login === 'opening-browser' ? '正在打开登录页…' : '登录 Codex'}<Icon name="external" size={12} /></button>{assistant.login === 'waiting-browser' && <button className="text-button" disabled={busy.has('cancel-login')} onClick={() => { void perform('cancel-login', () => window.pet.cancelLogin()); }}>{busy.has('cancel-login') ? '正在取消…' : '取消登录'}</button>}</div></section>;
}

function Toggle({ label, hint, value, disabled, onChange }: { label: string; hint?: string; value: boolean; disabled?: boolean; onChange(value: boolean): void }) {
  return <label className="toggle-row"><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span><input type="checkbox" role="switch" checked={value} disabled={disabled} onChange={event => onChange(event.target.checked)} /><i aria-hidden="true" /></label>;
}
