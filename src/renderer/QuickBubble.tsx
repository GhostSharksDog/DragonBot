import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ChatMessage } from '../shared/types';
import { createQuickBubbleShape, type QuickBubbleShape } from '../shared/bubble-shape';
import { Icon } from './icons';

interface QuickBubbleProps {
  shape?: QuickBubbleShape;
  draft: string;
  setDraft(value: string): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  reply: ChatMessage | null;
  expanded: boolean;
  setExpanded(value: boolean): void;
  interaction: ReactNode;
  interactionCount: number;
  approval: boolean;
  connected: boolean;
  active: boolean;
  thinking: boolean;
  sending: boolean;
  stopping: boolean;
  error: string | null;
  status: string;
  renderMessage(text: string): ReactNode;
  send(): Promise<void>;
  stop(): void;
  close(): void;
}

export function QuickBubbleFrame({ shape: suppliedShape, title, children, footer, actions, close, quota = false }: { shape?: QuickBubbleShape; title: string; children: ReactNode; footer?: ReactNode; actions?: ReactNode; close(): void; quota?: boolean }) {
  const [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight });
  const header = useRef<HTMLElement>(null), body = useRef<HTMLDivElement>(null), bottom = useRef<HTMLDivElement>(null);
  const lastHeight = useRef(0);
  useEffect(() => { const resize = () => setViewport({ width: innerWidth, height: innerHeight }); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  const shape = suppliedShape ?? createQuickBubbleShape(viewport.width, viewport.height, { x: -20, y: viewport.height * .7 });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const footerHeight = bottom.current?.getBoundingClientRect().height ?? 0;
        const natural = (header.current?.getBoundingClientRect().height ?? 24) + (body.current?.getBoundingClientRect().height ?? 0) + footerHeight + (footerHeight ? 14 : 7);
        // content.height = .7 * (windowHeight - 18), including the ellipse's inset.
        const height = Math.max(180, Math.min(360, Math.ceil(natural / .7 + 18)));
        if (lastHeight.current !== height) { lastHeight.current = height; void window.pet.resizeQuickBubble(height).catch(() => undefined); }
      }, 60);
    };
    const observer = new ResizeObserver(measure);
    for (const element of [header.current, body.current, bottom.current]) if (element) observer.observe(element);
    measure(); return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, [viewport.width, viewport.height]);
  return <main className={`quick-shell${quota ? ' quota-shell' : ''}`} aria-label={quota ? 'Codex 额度小气泡' : '龙娘小气泡'}>
    <svg className="quick-surface" width={viewport.width} height={viewport.height} viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-hidden="true"><path d={shape.path} /></svg>
    <div className="quick-inner" style={{ left: shape.content.x, top: shape.content.y, width: shape.content.width, height: shape.content.height }}>
      <header ref={header} className="quick-header"><strong>{title}</strong><div className="quick-header-actions">{actions}<button type="button" className="icon-button" aria-label="收起气泡" title="收起气泡" onClick={close}><Icon name="minus" size={16} /></button></div></header>
      <div className="quick-scroll"><div ref={body} className="quick-content">{children}</div></div>
      <div ref={bottom} className="quick-footer">{footer}</div>
    </div>
  </main>;
}

export function QuickBubble(props: QuickBubbleProps) {
  const { draft, setDraft, inputRef, reply, expanded, setExpanded, interaction, interactionCount, active } = props;
  const composing = useRef(false);
  const longReply = Boolean(reply && (reply.text.length > 180 || reply.text.split('\n').length > 4));

  useEffect(() => {
    const input = inputRef.current;
    if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(72, Math.max(34, input.scrollHeight))}px`; }
  }, [draft, inputRef, interaction]);

  useEffect(() => {
    // A user click focuses the native window; automatic showInactive reminders leave focus elsewhere.
    const focusInput = () => { if (document.hasFocus() && !interaction) inputRef.current?.focus({ preventScroll: true }); };
    focusInput(); window.addEventListener('focus', focusInput, { once: true });
    return () => window.removeEventListener('focus', focusInput);
  }, []);

  const footer = <>
      {!interaction ? <div className="quick-composer"><textarea ref={inputRef} value={draft} rows={1} aria-label="对龙娘说点什么" placeholder={active ? '还想补充什么？' : '想说什么，告诉我…'} maxLength={50000} onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void props.send(); }
      }} /><button type="button" className="send-button" aria-label={active ? '补充任务要求' : '发送消息'} title={active ? '补充任务要求' : '发送消息'} disabled={!draft.trim() || !props.connected || props.sending} onClick={() => { void props.send(); }}><Icon name="arrow" size={17} /></button></div> : null}
      {active && !props.approval && <button className="text-button quick-stop" disabled={props.stopping} onClick={props.stop}><Icon name="stop" size={11} />停止任务</button>}
    </>;
  return <QuickBubbleFrame shape={props.shape} title={interaction ? '有件事想和你确认' : '怎么了？'} footer={footer} close={props.close}>
      {props.error && <p className="quick-error" role="alert">{props.error}</p>}
      {!props.connected && <p className="quick-status">{props.status}。右键桌宠可打开连接设置。</p>}
      {interaction ? <>{interactionCount > 1 && <p className="quick-queue">还有 {interactionCount - 1} 项等你回应，先处理这一项。</p>}{interaction}</> : <>
        {reply && <div className={`quick-reply${longReply && !expanded ? ' is-collapsed' : ''}`} aria-live="polite" aria-relevant="additions text">{props.renderMessage(reply.text)}</div>}
        {longReply && <button className="text-button quick-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起回复' : '展开回复'}<Icon name="chevron" size={12} /></button>}
        {props.thinking && <p className="quick-status"><span className="quick-pulse" />正在想办法…</p>}
      </>}
  </QuickBubbleFrame>;
}
