import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright';

// Native-window UI check with isolated settings and an intentionally unavailable
// Codex binary: no login, quota request, inference, website, or user data access.
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const executable = path.resolve(argument('--executable') ?? 'release/win-unpacked/龙娘桌宠.exe');
const expectedVersion = argument('--expected-version') ?? JSON.parse(await fs.readFile('package.json', 'utf8')).version;
const local = path.resolve('.local'); await fs.mkdir(local, { recursive: true });
const directory = await fs.mkdtemp(path.join(local, 'native-051-ui-'));
const dataDir = path.join(directory, 'user-data'); await fs.mkdir(dataDir);
await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ codexPath: path.join(directory, 'intentionally-unavailable-codex.exe'), roaming: false }));
const env = { ...process.env, DRAGON_PET_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE;
const result = { ok: false, executable, expectedVersion, directory, isolatedData: false, loginStarted: false, inferenceTurns: 0, nativeWindows: 0, checks: [], screenshots: {}, errors: [] };
let application;
try {
  application = await _electron.launch({ executablePath: executable, env, timeout: 45000 });
  let pet, bubble;
  const deadline = Date.now() + 15000;
  while ((!pet || !bubble) && Date.now() < deadline) { pet = application.windows().find(page => page.url().includes('view=pet')); bubble = application.windows().find(page => page.url().includes('view=bubble')); if (!pet || !bubble) await new Promise(resolve => setTimeout(resolve, 60)); }
  assert(pet && bubble, 'Both native windows must exist.');
  for (const page of [pet, bubble]) page.on('pageerror', error => result.errors.push(error.message));
  await Promise.all([pet, bubble].map(page => page.waitForFunction(() => Boolean(window.pet))));
  const native = await application.evaluate(({ app, BrowserWindow }) => ({ version: app.getVersion(), dataDir: app.getPath('userData'), windows: BrowserWindow.getAllWindows().length }));
  assert.equal(native.version, expectedVersion); assert.equal(path.resolve(native.dataDir), dataDir); assert.equal(native.windows, 2); result.nativeWindows = 2; result.isolatedData = true;
  const state = () => pet.evaluate(() => window.pet.getState());
  const wait = async (mode, view) => { await pet.waitForFunction(async ({ mode, view }) => { const snapshot = await window.pet.getState(); return snapshot.bubbleMode === mode && (!view || snapshot.quickView === view); }, { mode, view }); };
  const capture = async (page, name) => { const destination = path.join(directory, name + '.png'); await page.screenshot({ path: destination, omitBackground: true }); result.screenshots[name] = destination; };
  await wait('hidden'); result.checks.push('Startup shows pet without a bubble.');
  await pet.locator('.pet-chat-launcher').waitFor();
  await pet.waitForFunction(() => document.querySelector('.pet-sprite')?.complete && document.querySelector('.sprite-canvas')?.dataset.ready === 'true');
  await capture(pet, 'pet-launcher');
  await pet.locator('.pet-button').click(); await wait('quick', 'chat');
  await bubble.locator('.reply-shell').waitFor(); assert.equal(await bubble.locator('textarea, input').count(), 0); result.checks.push('Character single click shows text-only reply.');
  await capture(bubble, 'reply');
  await pet.locator('.pet-chat-launcher').click(); await wait('quick', 'compose');
  await bubble.locator('.compose-shell').waitFor(); assert.equal(await bubble.locator('.reply-shell, .quota-shell').count(), 0);
  const input = bubble.getByRole('textbox', { name: '对龙娘说点什么', exact: true }); await input.fill('输入框草稿，切换后仍保留'); await capture(bubble, 'input');
  result.checks.push('Chat logo replaces reply with a single input bubble.');
  await pet.locator('.pet-button').dblclick({ delay: 60 }); await wait('quick', 'quota'); await bubble.locator('.quota-shell').waitFor();
  assert.equal(await input.count(), 0); assert.equal(await bubble.locator('.compose-shell, .reply-shell').count(), 0); result.checks.push('Double click retains quota while input is hidden.');
  await bubble.getByRole('button', { name: '返回聊天', exact: true }).click(); await wait('quick', 'chat'); assert.equal(await input.count(), 0);
  await pet.locator('.pet-chat-launcher').click(); await wait('quick', 'compose'); assert.equal(await input.inputValue(), '输入框草稿，切换后仍保留');
  await bubble.getByRole('button', { name: '收起气泡', exact: true }).click(); await wait('hidden');
  await pet.locator('.pet-chat-launcher').click(); await wait('quick', 'compose'); assert.equal(await input.inputValue(), '输入框草稿，切换后仍保留');
  result.checks.push('Quota and close/reopen preserve the composer draft.');
  await pet.evaluate(() => window.pet.setBubbleMode('panel', 'settings')); await wait('panel'); await bubble.getByRole('heading', { name: '桌宠与任务设置', exact: true }).waitFor();
  await pet.locator('.pet-chat-launcher').click(); await wait('quick', 'compose'); await bubble.locator('.compose-shell').waitFor(); assert.equal(await bubble.locator('.bubble-shell').count(), 0); assert.equal(await input.inputValue(), '输入框草稿，切换后仍保留');
  result.checks.push('Chat logo replaces full panel without a third window.');
  for (const scale of [.65, 1.6, 1]) {
    await pet.evaluate(scale => window.pet.updateSettings({ scale }), scale);
    const geometry = await pet.locator('.pet-chat-launcher').evaluate(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight }; });
    assert(geometry.x >= 0 && geometry.y >= 0 && geometry.right <= geometry.width && geometry.bottom <= geometry.height, 'Launcher stays inside the native pet window at each scale.');
  }
  result.checks.push('Launcher remains visible at small, default, and large scales.');
  const final = await state(); assert.equal(final.assistant.threadId, null); assert.equal(final.assistant.messages.length, 0); assert.equal(final.assistant.pending.length, 0);
  assert.equal(final.assistant.browser, 'disconnected'); assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2); assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) { result.errors.push(error.stack ?? String(error)); throw error; }
finally { await application?.close(); await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
