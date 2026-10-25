import type { QuotaBucket, QuotaSnapshot, QuotaWindow } from '../../shared/types';
import { RpcResponseError, sanitizeDiagnostic } from './transport';

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.slice(0, 512) : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function emptyQuota(): QuotaSnapshot { return { status: 'idle', buckets: [], updatedAt: null, stale: true, error: null }; }
function window(value: unknown): QuotaWindow | null {
  const source = object(value); if (!source || !finite(source.usedPercent)) return null;
  return { usedPercent: Math.max(0, Math.min(100, source.usedPercent)), windowDurationMins: finite(source.windowDurationMins) && source.windowDurationMins > 0 ? source.windowDurationMins : null, resetsAt: finite(source.resetsAt) && source.resetsAt >= 0 ? source.resetsAt : null };
}
/** Only the display contract crosses IPC; account IDs and backend upsell data do not. */
export function normalizeQuota(input: unknown): QuotaBucket[] {
  const source = object(input); if (!source) return [];
  const multiple = object(source.rateLimitsByLimitId), entries = multiple ? Object.entries(multiple).filter((entry): entry is [string, Record<string, unknown>] => Boolean(object(entry[1]))) : [];
  const single = object(source.rateLimits);
  const snapshots: [string, Record<string, unknown>][] = entries.length ? entries : single ? [[text(single.limitId) ?? 'codex', single]] : [];
  return snapshots.map(([id, value]) => {
    const credits = object(value.credits);
    return { id, name: text(value.limitName), primary: window(value.primary), secondary: window(value.secondary), credits: credits && typeof credits.hasCredits === 'boolean' && typeof credits.unlimited === 'boolean' ? { hasCredits: credits.hasCredits, unlimited: credits.unlimited, balance: text(credits.balance) } : null, planType: text(value.planType) };
  }).sort((left, right) => left.id === right.id ? 0 : left.id === 'codex' ? -1 : right.id === 'codex' ? 1 : left.id.localeCompare(right.id));
}
export function quotaError(error: unknown): string {
  if (error instanceof RpcResponseError && error.code === -32601) return '当前 Codex 版本暂不提供额度查询。';
  const message = sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
  return /超时|timed?\s*out|timeout/i.test(message) ? '额度查询超时，请稍后刷新；当前任务会继续。' : `额度暂时无法读取，请稍后刷新${message ? `：${message}` : '。'}`;
}
