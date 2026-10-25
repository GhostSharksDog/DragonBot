import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ChatMessage } from '../shared/types';
import { createQuickBubbleShape, type QuickBubbleShape } from '../shared/bubble-shape';
import { Icon } from './icons';

interface QuickBubbleProps {
  shape?: QuickBubbleShape;
  compose: boolean;
  draft: string;
  setDraft(value: string): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  reply: ChatMessage | null;
  expanded: boolean;
  setExpanded(value: boolean): void;
  interaction: ReactNode;
  questionPrompt: ReactNode;
  interactionCount: number;
  approval: boolean;
  connected: boolean;
  active: boolean;
  thinking: boolean;
  sending: boolean;
  error: string | null;
  status: string;
  send(): Promise<void>;
  close(): void;
}

export function QuickBubbleFrame({ shape: suppliedShape, title, children, footer, actions, close, quota = false, compose = false }: { shape?: QuickBubbleShape; title?: string; children: ReactNode; footer?: ReactNode; actions?: ReactNode; close(): void; quota?: boolean; compose?: boolean }) {
  const [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight });
  const header = useRef<HTMLElement>(null), body = useRef<HTMLDivElement>(null), bottom = useRef<HTMLDivElement>(null);
  const lastHeight = useRef(0);
  useEffect(() => { const resize = () => setViewport({ width: innerWidth, height: innerHeight }); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  const shape = suppliedShape ?? createQuickBubbleShape(viewport.width, viewport.height, { x: -20, y: viewport.height * .7 });
  const insetHeight = viewport.height - shape.content.height;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const headerHeight = header.current?.getBoundingClientRect().height ?? 0;
        const footerHeight = bottom.current?.getBoundingClientRect().height ?? 0;
        const natural = headerHeight + (body.current?.getBoundingClientRect().height ?? 0) + footerHeight + (headerHeight ? 7 : 0) + (footerHeight ? 7 : 0);
        const height = Math.max(compose ? 160 : 88, Math.min(360, Math.ceil(natural + insetHeight)));
        if (lastHeight.current !== height) { lastHeight.current = height; void window.pet.resizeQuickBubble(height).catch(() => undefined); }
      }, 60);
    };
    const observer = new ResizeObserver(measure);
    for (const element of [header.current, body.current, bottom.current]) if (element) observer.observe(element);
    measure(); return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, [viewport.width, insetHeight, compose, title]);
  return <main className={`quick-shell ${quota ? 'quota-shell' : compose ? 'compose-shell' : 'reply-shell'}`} aria-label={quota ? 'Codex 额度小气泡' : compose ? '龙娘输入气泡' : '龙娘回复气泡'}>
    <svg className="quick-surface" width={viewport.width} height={viewport.height} viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-hidden="true"><path d={shape.path} /></svg>
    <div className="quick-inner" style={{ left: shape.content.x, top: shape.content.y, width: shape.content.width, height: shape.content.height }}>
      {title && <header ref={header} className="quick-header"><strong>{title}</strong><div className="quick-header-actions">{actions}<button type="button" className="icon-button" aria-label="收起气泡" title="收起气泡" onClick={close}><Icon name="minus" size={16} /></button></div></header>}
      <div className="quick-scroll"><div ref={body} className="quick-content">{children}</div></div>
      {footer && <div ref={bottom} className="quick-footer">{footer}</div>}
    </div>
    {!title && <button type="button" className="icon-button quick-dismiss" style={{ right: viewport.width - shape.content.x - shape.content.width - 7, top: shape.content.y - 10 }} aria-label="收起气泡" title="收起气泡" onClick={close}><Icon name="minus" size={13} /></button>}
  </main>;
}

export function QuickBubble(props: QuickBubbleProps) {
  const { compose, draft, setDraft, inputRef, reply, expanded, setExpanded, interaction, interactionCount, active } = props;
  const composing = useRef(false);
  const longReply = Boolean(reply && (reply.text.length > 180 || reply.text.split('\n').length > 4));

  useEffect(() => {
    const input = inputRef.current;
    if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(112, Math.max(68, input.scrollHeight))}px`; }
  }, [draft, inputRef, interaction, compose]);

  useEffect(() => {
    composing.current = false;
    if (!compose) return;
    // Only the explicit input launcher enters compose; automatic replies never take focus.
    const focusInput = () => { if (document.hasFocus() && !interaction) inputRef.current?.focus({ preventScroll: true }); };
    focusInput(); window.addEventListener('focus', focusInput, { once: true });
    return () => window.removeEventListener('focus', focusInput);
  }, [compose, Boolean(interaction)]);

  const showInteraction = Boolean(interaction) && (compose || props.approval);
  return <QuickBubbleFrame shape={props.shape} compose={compose} close={props.close}>
    {props.error && <p className="quick-error" role="alert">{props.error}</p>}
    {!props.connected && <p className="quick-status">{props.status}。右键桌宠可打开连接设置。</p>}
    {showInteraction ? <>{interactionCount > 1 && <p className="quick-queue">还有 {interactionCount - 1} 项待回应。</p>}{interaction}</> : compose ?
      <div className="quick-composer"><textarea ref={inputRef} value={draft} rows={3} aria-label="对龙娘说点什么" placeholder={active ? '还想补充什么？' : '想说什么，告诉我…'} maxLength={50000} onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void props.send(); }
      }} /><button type="button" className="send-button" aria-label={active ? '补充任务要求' : '发送消息'} title={active ? '补充任务要求' : '发送消息'} disabled={!draft.trim() || !props.connected || props.sending} onClick={() => { void props.send(); }}><Icon name="arrow" size={17} /></button></div>
      : props.questionPrompt ? props.questionPrompt : <>
        {reply && !props.thinking && <div className={`quick-reply${longReply && !expanded ? ' is-collapsed' : ''}`} aria-live="polite" aria-relevant="additions text"><p className="quick-reply-text">{reply.text}</p></div>}
        {reply && !props.thinking && longReply && <button className="text-button quick-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起回复' : '展开回复'}</button>}
        {props.thinking ? <p className="quick-reply-text" role="status">让我想想…</p> : !reply && !props.error && props.connected && <p className="quick-reply-text">我在，点旁边的聊天图标和我说话吧。</p>}
      </>}
  </QuickBubbleFrame>;
}
