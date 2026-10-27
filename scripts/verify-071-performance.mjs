import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright';

const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const executable = arg('--executable');
const sampleCount = Number(arg('--samples') || 10), deviceScale = Number(arg('--device-scale') || 1);
assert(Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 20);
assert([1, 1.25, 1.5, 2].includes(deviceScale));
const directory = await fs.mkdtemp(path.resolve('.local/performance-071-'));
const dataDir = path.join(directory, 'data');
await fs.mkdir(path.join(dataDir, 'chat'), { recursive: true });
await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ roaming: false }));
// Synthetic history exercises the real startup/IPC path without private data.
await fs.writeFile(path.join(dataDir, 'chat/history.json'), JSON.stringify({ currentId: 'synthetic', conversations: [{ id: 'synthetic', title: '性能测试', updatedAt: 1, url: null, messages: Array.from({ length: 1000 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' : 'user', text: '本地合成历史。'.repeat(40), createdAt: i })) }], outbox: null }));
const env = { ...process.env, DRAGON_PET_DATA_DIR: dataDir, DRAGON_PET_PERF: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let app, pet, bubble;
const result = { ok: false, directory, deviceScale, samples: [], errors: [] };
try {
  app = await _electron.launch({ executablePath: path.resolve(executable || 'node_modules/electron/dist/electron.exe'), args: [...(executable ? [] : [process.cwd()]), `--force-device-scale-factor=${deviceScale}`], env, timeout: 45000 });
  for (let i = 0; i < 400 && (!pet || !bubble); i++) { pet = app.windows().find(w => w.url().includes('view=pet')); bubble = app.windows().find(w => w.url().includes('view=bubble')); await sleep(50); }
  assert(pet && bubble);
  for (const page of [pet, bubble]) page.on('pageerror', e => result.errors.push(e.message));
  await bubble.waitForFunction(() => Boolean(window.pet));
  assert.equal(await bubble.evaluate(() => devicePixelRatio), deviceScale);
  for (let i = 0; i < 300; i++) { const s = await bubble.evaluate(() => window.pet.getState()); if (s.assistant.connection === 'ready') break; if (s.assistant.connection === 'error') throw Error(s.assistant.error); await sleep(100); }
  const initial = await bubble.evaluate(() => window.pet.getState()); assert.equal(initial.assistant.connection, 'ready');
  const native = () => app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=bubble')); return { visible: b.isVisible(), ...b.getBounds() }; });
  for (const idleMs of [1000, ...(process.argv.includes('--long') ? [10000, 60000] : [])]) {
    for (const kind of ['icon', 'single', 'double']) {
      for (let repeat = 0; repeat < (idleMs === 1000 ? sampleCount : 1); repeat++) {
        await bubble.evaluate(() => window.pet.setBubbleMode('hidden')); await sleep(idleMs);
        const opened = Date.now();
        if (kind === 'icon') await pet.locator('.pet-chat-launcher').click();
        else if (kind === 'single') await pet.locator('.pet-button').click({ position: { x: 100, y: 100 } });
        else await pet.locator('.pet-button').dblclick({ position: { x: 100, y: 100 }, delay: 50 });
        let state;
        for (let i = 0; i < 500; i++) { state = await native(); if (state.visible) break; await sleep(10); }
        assert(state.visible, `${kind} bubble must become visible`);
        const snapshot = await bubble.evaluate(() => window.pet.getState());
        assert.equal(snapshot.quickView, kind === 'icon' ? 'compose' : kind === 'double' ? 'quota' : 'chat');
        if (kind === 'double') assert.equal(state.height, 340);
        result.samples.push({ kind, idleMs, revision: snapshot.quickLayout.id, observedMs: Date.now() - opened });
      }
      console.log(JSON.stringify({ completed: kind, idleMs }));
    }
  }
  await pet.evaluate(() => window.pet.openQuota());
  for (let i = 0; i < 150; i++) { const q = (await bubble.evaluate(() => window.pet.getState())).assistant.quota; if (q.status !== 'loading') break; await sleep(100); }
  await bubble.locator('.quota-shell').waitFor();
  const quotaLayout = await bubble.evaluate(() => Array.from(document.querySelectorAll('.quota-shell .quick-scroll, .quota-fixed, .quota-data')).map(el => ({ height: el.clientHeight, content: el.scrollHeight, overflow: getComputedStyle(el).overflowY })));
  assert(quotaLayout.every(r => r.content <= r.height + 1), 'Quota content fits without vertical scrolling.');
  await bubble.screenshot({ path: path.join(directory, 'quota.png'), omitBackground: true });
  await pet.evaluate(() => window.pet.openComposer()); await bubble.locator('.compose-shell').waitFor();
  await bubble.screenshot({ path: path.join(directory, 'input.png'), omitBackground: true });
  const final = await bubble.evaluate(() => window.pet.getState());
  assert.equal(final.assistant.threadId, initial.assistant.threadId); assert.deepEqual(final.assistant.messages, initial.assistant.messages);
  assert.deepEqual(result.errors, []);
} catch (error) { result.errors.push(String(error)); throw error; }
finally {
  await app?.close();
  try {
    const timings = JSON.parse(await fs.readFile(path.join(dataDir, 'diagnostics/performance.json'), 'utf8'));
    for (const sample of result.samples) {
      const open = timings.find(e => e.stage === 'open-request' && e.id === sample.revision);
      const visible = timings.find(e => e.stage === 'window-visible' && e.id === sample.revision);
      sample.visibleMs = open?.inputAt && visible ? visible.at - open.inputAt : null;
      sample.layoutMs = visible?.elapsedMs ?? null;
    }
    result.statistics = Object.fromEntries(['icon', 'single', 'double'].map(kind => {
      const values = result.samples.filter(s => s.kind === kind).map(s => s.visibleMs).sort((a, b) => a - b);
      assert(values.length && values.every(Number.isFinite), `Missing ${kind} timing`);
      const p95 = values[Math.ceil(values.length * .95) - 1];
      return [kind, { count: values.length, p95, max: values.at(-1), target: kind === 'single' ? 450 : 150 }];
    }));
    result.quota = timings.filter(e => e.stage === 'quota-end');
    result.ok = !result.errors.length && Object.values(result.statistics).every(s => s.p95 <= s.target);
  } catch (error) { result.errors.push(String(error)); }
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
assert(result.ok, 'Performance acceptance failed; inspect result.json');
