import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

type Stage = 'open-request' | 'layout-commit' | 'window-visible' | 'quota-start' | 'quota-end';
type Entry = { stage: Stage; at: number; elapsedMs?: number; id?: number; view?: 'chat' | 'compose' | 'quota'; source?: 'open' | 'manual' | 'prefetch'; outcome?: 'ready' | 'error'; inputAt?: number };
const entries: Entry[] = [];
let file = '', timer: NodeJS.Timeout | undefined, saving = Promise.resolve();
export function configurePerformanceLog(dataDir: string) {
  if (process.env.DRAGON_PET_PERF === '1') file = path.join(dataDir, 'diagnostics', 'performance.json');
}
/** Only fixed event names, local timestamps and durations; never user content. */
export function recordPerformance(entry: Omit<Entry, 'at'>) {
  if (!file) return;
  entries.push({ ...entry, at: Date.now() });
  if (entries.length > 256) entries.shift();
  if (!timer) { timer = setTimeout(() => { timer = undefined; void flushPerformanceLog(); }, 500); timer.unref(); }
}
export function flushPerformanceLog(): Promise<void> {
  if (timer) clearTimeout(timer); timer = undefined;
  if (!file) return Promise.resolve();
  const content = JSON.stringify(entries, null, 2);
  saving = saving.catch(() => {}).then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file + '.tmp', content, 'utf8'); await rename(file + '.tmp', file);
  }).catch(() => {});
  return saving;
}
