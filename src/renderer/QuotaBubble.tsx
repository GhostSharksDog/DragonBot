import { useEffect, useState } from 'react';
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
function QuotaWindowView({ window, fallback }: { window: QuotaWindow; fallback: string }) {
  const remaining = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)) * 10) / 10;
  const label = windowName(window, fallback);
  return <div className="quota-window"><div><strong>{label}</strong><span>剩余 {remaining}%</span></div><progress value={remaining} max={100} aria-label={`${label}剩余额度`} />{window.resetsAt !== null && <small>重置：{new Date(window.resetsAt * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>}</div>;
}
export function QuotaBubble({ snapshot, refreshing, refresh, back, close, error }: { snapshot: AppSnapshot; refreshing: boolean; refresh(): void; back(): void; close(): void; error: string | null }) {
  const quota = snapshot.assistant.quota, loading = refreshing || quota?.status === 'loading';
  const pending = snapshot.assistant.pending;
  const buckets = quota?.buckets ?? [];
  const [selectedId, setSelectedId] = useState('');
  const bucketIds = buckets.map(bucket => bucket.id).join('\0');
  useEffect(() => { setSelectedId(current => buckets.some(bucket => bucket.id === current) ? current : buckets.find(bucket => bucket.id === 'codex')?.id ?? buckets[0]?.id ?? ''); }, [bucketIds]);
  const selected = buckets.find(bucket => bucket.id === selectedId) ?? buckets.find(bucket => bucket.id === 'codex') ?? buckets[0];
  return <QuickBubbleFrame shape={snapshot.quickShape} layout={snapshot.quickLayout} title="Codex 额度" quota close={close} actions={<button type="button" className="icon-button" aria-label="刷新额度" title="刷新额度" disabled={loading} onClick={refresh}><Icon name="refresh" size={14} /></button>} footer={<>
    {pending.length > 0 && <p className="quota-pending" role="status">有 {pending.length} 项待{pending.some(request => request.kind === 'approval') ? '回答或批准' : '回答'}</p>}
    <button className="text-button quota-back" onClick={back}>{pending.length ? '返回处理待办' : '返回聊天'}<Icon name="chevron" size={12} /></button>
  </>}>
    <p className="quick-status quota-refresh-status" role="status">{loading ? '正在刷新额度…' : quota?.stale ? '上次记录，尚未更新。' : '\u00a0'}</p>
    {(error || quota?.error) && <p className="quick-error" role="alert">{error || quota?.error}</p>}
    {buckets.length > 1 && <><label className="quota-category" htmlFor="quota-bucket">额度类别</label><select id="quota-bucket" className="field-input" value={selected?.id ?? ''} onChange={event => setSelectedId(event.target.value)}>{buckets.map(bucket => <option key={bucket.id} value={bucket.id}>{bucket.name || bucket.id}</option>)}</select></>}
    {(selected ? [selected] : []).map(bucket => <section className="quota-bucket" key={bucket.id} aria-label={bucket.name || bucket.id}>
      <h3>{bucket.name || (bucket.id === 'codex' ? 'Codex' : bucket.id)}</h3>
      {bucket.primary && <QuotaWindowView window={bucket.primary} fallback="主要额度" />}
      {bucket.secondary && <QuotaWindowView window={bucket.secondary} fallback="其他额度" />}
      {!bucket.primary && !bucket.secondary && <p className="quick-status">暂未返回此窗口额度。</p>}
      {bucket.credits && (bucket.credits.unlimited || bucket.credits.balance !== null) && <p className="quick-status">点数：{bucket.credits.unlimited ? '不限' : bucket.credits.balance}</p>}
    </section>)}
    {!loading && !quota?.buckets.length && !error && !quota?.error && <p className="quick-status">尚未取得额度信息，点击刷新查看。</p>}
    {quota?.updatedAt !== null && quota?.updatedAt !== undefined && <p className="quota-updated">更新于 {new Date(quota.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</p>}
  </QuickBubbleFrame>;
}
