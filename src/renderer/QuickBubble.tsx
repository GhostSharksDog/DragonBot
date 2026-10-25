import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { ChatMessage } from '../shared/types';
import { Icon } from './icons';

interface QuickBubbleProps {
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

export function QuickBubble(props: QuickBubbleProps) {
  const { draft, setDraft, inputRef, reply, expanded, setExpanded, interaction, interactionCount, active } = props;
  const shell = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const lastHeight = useRef(0);
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

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const header = shell.current?.querySelector('.quick-header');
        const natural = (header?.getBoundingClientRect().height ?? 28) + (content.current?.getBoundingClientRect().height ?? 0) + (footer.current?.getBoundingClientRect().height ?? 0) + 56;
        const height = Math.max(180, Math.min(360, Math.ceil(natural)));
        if (lastHeight.current === height) return;
        lastHeight.current = height;
        void window.pet.resizeQuickBubble(height).catch(() => undefined);
      }, 60);
    };
    const observer = new ResizeObserver(measure);
    for (const element of [content.current, footer.current]) if (element) observer.observe(element);
    measure();
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, []);

  return <main ref={shell} className="quick-shell" aria-label="龙娘小气泡">
    <header className="quick-header"><strong>{interaction ? '有件事想和你确认' : '怎么了？'}</strong><button type="button" className="icon-button" aria-label="收起气泡" title="收起气泡" onClick={props.close}><Icon name="minus" size={16} /></button></header>
    <div className="quick-scroll"><div ref={content} className="quick-content">
      {props.error && <p className="quick-error" role="alert">{props.error}</p>}
      {!props.connected && <p className="quick-status">{props.status}。右键桌宠可打开连接设置。</p>}
      {interaction ? <>{interactionCount > 1 && <p className="quick-queue">还有 {interactionCount - 1} 项等你回应，先处理这一项。</p>}{interaction}</> : <>
        {reply && <div className={`quick-reply${longReply && !expanded ? ' is-collapsed' : ''}`} aria-live="polite" aria-relevant="additions text">{props.renderMessage(reply.text)}</div>}
        {longReply && <button className="text-button quick-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起回复' : '展开回复'}<Icon name="chevron" size={12} /></button>}
        {props.thinking && <p className="quick-status"><span className="quick-pulse" />正在想办法…</p>}
      </>}
    </div></div>
    <div ref={footer} className="quick-footer">
      {!interaction ? <div className="quick-composer"><textarea ref={inputRef} value={draft} rows={1} aria-label="对龙娘说点什么" placeholder={active ? '还想补充什么？' : '想说什么，告诉我…'} maxLength={50000} onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void props.send(); }
      }} /><button type="button" className="send-button" aria-label={active ? '补充任务要求' : '发送消息'} title={active ? '补充任务要求' : '发送消息'} disabled={!draft.trim() || !props.connected || props.sending} onClick={() => { void props.send(); }}><Icon name="arrow" size={17} /></button></div> : null}
      {active && !props.approval && <button className="text-button quick-stop" disabled={props.stopping} onClick={props.stop}><Icon name="stop" size={11} />停止任务</button>}
    </div>
  </main>;
}
