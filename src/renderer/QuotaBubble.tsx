import { useLayoutEffect, useRef, useState } from 'react';
import type { AppSnapshot, QuotaWindow } from '../shared/types';
import { QuickBubbleFrame } from './QuickBubble';
import { Icon } from './icons';

function windowName(window: QuotaWindow, fallback: string): string {
  const minutes = window.windowDurationMins;
  if (!minutes) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440} 天额度`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时额度`;
  return `${minutes} 分钟额度`;
}
function QuotaWindowView({ window, fallback }: { window: QuotaWindow | null; fallback: string }) {
  const remaining = window ? Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)) * 10) / 10 : null;
  const label = window ? windowName(window, fallback) : fallback;
  return <div className="quota-window"><div><strong title={label}>{label}</strong><span>剩余 {remaining === null ? '—' : `${remaining}%`}</span></div>
    {remaining !== null ? <progress value={remaining} max={100} aria-label={`${label}剩余额度`} /> : <div className="quota-empty-bar" />}
    <small>{window?.resetsAt != null ? `重置：${new Date(window.resetsAt * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '重置时间：—'}</small>
  </div>;
}

/** Measure actual wrapping so long diagnostics are paged, never clipped or scrolled. */
function PagedText({ text }: { text: string }) {
  const area = useRef<HTMLDivElement>(null), measure = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<string[]>([text]), [page, setPage] = useState(0);
  useLayoutEffect(() => {
    const fit = () => {
      if (!area.current || !measure.current || area.current.clientHeight < 18) return;
      const chars = Array.from(text), result: string[] = [];
      let start = 0;
      while (start < chars.length) {
        let lo = 1, hi = chars.length - start, best = 1;
        while (lo <= hi) {
          const count = Math.floor((lo + hi) / 2);
          measure.current.textContent = chars.slice(start, start + count).join('');
          if (measure.current.getBoundingClientRect().height <= area.current.clientHeight) { best = count; lo = count + 1; } else hi = count - 1;
        }
        result.push(chars.slice(start, start + best).join('')); start += best;
      }
      measure.current.textContent = '';
      setPages(result.length ? result : ['—']);
    };
    const observer = new ResizeObserver(fit); if (area.current) observer.observe(area.current); fit(); setPage(0);
    return () => observer.disconnect();
  }, [text]);
  const current = Math.min(page, pages.length - 1);
  return <div className="quota-detail-pages"><div ref={area} className="quota-detail-area"><div className="quota-detail-text">{pages[current]}</div><div ref={measure} className="quota-detail-text quota-measure" aria-hidden="true" /></div>
    <div className="quota-pager"><button aria-label="上一页详情" disabled={!current} onClick={() => setPage(current - 1)}>‹</button><span>{current + 1} / {pages.length}</span><button aria-label="下一页详情" disabled={current + 1 >= pages.length} onClick={() => setPage(current + 1)}>›</button></div>
  </div>;
}

export function QuotaBubble({ snapshot, refreshing, refresh, back, close, error }: { snapshot: AppSnapshot; refreshing: boolean; refresh(): void; back(): void; close(): void; error: string | null }) {
  const quota = snapshot.assistant.quota, loading = refreshing || quota?.status === 'loading';
  const buckets = quota?.buckets ?? [], pending = snapshot.assistant.pending;
  const [selectedId, setSelectedId] = useState(''), [details, setDetails] = useState(false), [windowPage, setWindowPage] = useState(0);
  const selected = buckets.find(bucket => bucket.id === selectedId) ?? buckets.find(bucket => bucket.id === 'codex') ?? buckets[0];
  const selectedIndex = Math.max(0, buckets.findIndex(bucket => bucket.id === selected?.id));
  const compact = (snapshot.quickLayout?.maxHeight ?? 340) < 320;
  const problem = error || quota?.error;
  const detailsText = [selected?.name || selected?.id || 'Codex', selected?.planType ? `套餐：${selected.planType}` : '', selected?.credits ? `点数：${selected.credits.unlimited ? '不限' : selected.credits.balance ?? '—'}` : '', problem ? `刷新未完成：\n${problem}` : ''].filter(Boolean).join('\n\n');
  const status = loading ? quota?.slow ? '刷新较慢，稍后自动更新' : '正在刷新额度…' : problem ? quota?.updatedAt != null ? '刷新未完成，显示上次记录' : '刷新未完成，请重试' : quota?.stale && quota.updatedAt != null ? '上次记录，尚未更新。' : quota?.updatedAt != null ? '最新查询结果' : '尚未取得额度信息';
  const select = (offset: number) => { setSelectedId(buckets[(selectedIndex + offset + buckets.length) % buckets.length].id); setWindowPage(0); };
  const selectWindow = (offset: number) => { const count = Math.max(1, buckets.length) * 2, next = (selectedIndex * 2 + windowPage + offset + count) % count; setSelectedId(buckets[Math.floor(next / 2)]?.id ?? ''); setWindowPage(next % 2); };
  return <QuickBubbleFrame shape={snapshot.quickShape} layout={snapshot.quickLayout} title="Codex 额度" quota close={close}
    actions={<button type="button" className="icon-button" aria-label="刷新额度" title="刷新额度" disabled={loading} onClick={refresh}><Icon name="refresh" size={14} /></button>}
    footer={<button className="text-button quota-back" onClick={back}>{pending.length ? `返回处理待办（${pending.length}）` : '返回聊天'}<Icon name="chevron" size={12} /></button>}>
    <div className="quota-fixed">
      <div className="quota-category-switch" aria-label="额度类别">
        <button aria-label={compact ? '上一个额度窗口' : '上一个额度类别'} disabled={!compact && buckets.length < 2} onClick={() => compact ? selectWindow(-1) : select(-1)}>‹</button>
        <span title={selected?.name || selected?.id || 'Codex'} data-bucket={selected?.id ?? ''}>{selected?.name || selected?.id || 'Codex'}{compact ? ` · ${windowPage + 1}/2` : ''}</span>
        <button aria-label={compact ? '下一个额度窗口' : '下一个额度类别'} disabled={!compact && buckets.length < 2} onClick={() => compact ? selectWindow(1) : select(1)}>›</button>
      </div>
      <div className="quota-status-row"><span role={problem && !loading ? 'alert' : 'status'}>{status}</span><button className="text-button" aria-expanded={details} onClick={() => setDetails(!details)}>{details ? '额度' : '详情'}</button></div>
      <div className="quota-data">
        {details ? <PagedText text={detailsText || '暂无其他详情。'} /> : <>
          {(!compact || windowPage === 0) && <QuotaWindowView window={selected?.primary ?? null} fallback="主要额度" />}
          {(!compact || windowPage === 1) && <QuotaWindowView window={selected?.secondary ?? null} fallback="其他额度" />}
        </>}
      </div>
      <p className="quota-updated">{quota?.updatedAt != null ? `更新于 ${new Date(quota.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '更新时间：—'}</p>
    </div>
  </QuickBubbleFrame>;
}
