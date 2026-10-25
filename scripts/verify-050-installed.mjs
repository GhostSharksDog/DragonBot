import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => { const index = process.argv.indexOf(name); if (index < 0) return null; const value = process.argv[index + 1]; if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`); return value; };
const executable = path.resolve(argument('--executable') ?? path.join(project, 'release/win-unpacked/龙娘桌宠.exe'));
const codexHome = argument('--codex-home') ?? process.env.CODEX_HOME;
assert(codexHome && path.isAbsolute(codexHome), 'Pass the real signed-in --codex-home. This test never opens login.');
const expectedVersion = argument('--expected-version') ?? '0.5.0';
const timeout = Number(argument('--timeout-ms') ?? 180000); assert(Number.isFinite(timeout) && timeout >= 10000 && timeout <= 300000);
await fs.stat(executable); await fs.stat(codexHome);
const local = path.join(project, '.local'); await fs.mkdir(local, { recursive: true }); const directory = await fs.mkdtemp(path.join(local, 'installed-050-check-')), dataDir = path.join(directory, 'user-data'), folder = path.join(directory, 'task-folder'); await fs.mkdir(dataDir); await fs.mkdir(folder);
const site = 'https://dragon-pet-test.invalid', protectedData = argument('--protected-data-dir') ?? (process.env.APPDATA ? path.join(process.env.APPDATA, 'dragon-pet') : null);
const protectedFiles = [path.join(codexHome, 'config.toml'), ...(protectedData ? ['settings.json', 'chat-history.json'].map(name => path.join(protectedData, name)) : [])];
const hashProtected = () => Promise.all(protectedFiles.map(async file => { try { return { file, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') }; } catch (error) { if (error.code === 'ENOENT') return { file, sha256: null }; throw error; } }));
const protectedBefore = await hashProtected(), env = { ...process.env, CODEX_HOME: codexHome, DRAGON_PET_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE;
const result = { ok: false, executable, expectedVersion, directory, dataDir, loginReused: false, loginStarted: false, isolatedData: false, nativeSingleClickChat: false, nativeDoubleClickQuota: false, quotaCreatesNoThreadOrMessages: false, quota: null, reasoning: null, websitePreferences: null, restartPersistence: false, newResumeScope: false, uiMessagesSent: 0, newOwnedThreads: [], chatCompleted: false, retries: 0, protectedExistingFilesUnchanged: false, errors: [], screenshots: {} };
let application, bubble, pet;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const state = () => bubble.evaluate(() => window.pet.getState());
async function waitState(predicate, description, limit = 15000) {
  const deadline = Date.now() + limit; let latest;
  while (Date.now() < deadline) { latest = await state(); if (predicate(latest)) return latest; await sleep(60); }
  throw new Error(`${description} timed out (connection=${latest?.assistant.connection}, activity=${latest?.assistant.activity}, quota=${latest?.assistant.quota?.status}).`);
}
async function launch() {
  application = await _electron.launch({ executablePath: executable, cwd: project, env, timeout: 45000 }); bubble = null; pet = null;
  const deadline = Date.now() + 30000;
  while ((!bubble || !pet) && Date.now() < deadline) { bubble = application.windows().find(page => page.url().includes('view=bubble')); pet = application.windows().find(page => page.url().includes('view=pet')); if (!bubble || !pet) await sleep(100); }
  assert(bubble && pet); for (const page of [bubble, pet]) page.on('pageerror', error => result.errors.push(error.message)); await Promise.all([bubble, pet].map(page => page.waitForFunction(() => Boolean(window.pet), null, { timeout: 10000 })));
  const runtime = await application.evaluate(({ app }) => ({ version: app.getVersion(), userData: app.getPath('userData') })); assert.equal(runtime.version, expectedVersion); assert.equal(path.resolve(runtime.userData), dataDir); result.isolatedData = true;
  const ready = await waitState(snapshot => snapshot.assistant.connection === 'ready' || snapshot.assistant.connection === 'error', 'Codex startup', 60000); assert.equal(ready.assistant.connection, 'ready', ready.assistant.error ?? 'Startup failed.'); assert.equal(ready.assistant.login, 'signed-in', 'Use existing login without launching auth.'); result.loginReused = true;
  await pet.waitForFunction(() => { const image = document.querySelector('img.pet-sprite'); return image?.complete && image.naturalWidth > 0; }, null, { timeout: 15000 }); return ready;
}
async function capture(name) { const destination = path.join(directory, name + '.png'); await bubble.screenshot({ path: destination, omitBackground: true }); result.screenshots[name] = destination; }
function assertSites(snapshot) { assert.deepEqual(snapshot.settings.grant.origins, [site]); assert.equal(snapshot.settings.grant.browserInput, true); assert.equal(snapshot.assistant.browser, 'disconnected', 'Never connect daily Chrome or visit the test origin.'); }
function quotaSummary(snapshot) { const quota = snapshot.assistant.quota; return { status: quota?.status, bucketCount: quota?.buckets.length ?? 0, buckets: quota?.buckets ?? [], updatedAt: quota?.updatedAt ?? null, stale: quota?.stale ?? true, error: quota?.error ?? null }; }
async function assertQuotaUi(snapshot) {
  const quota = snapshot.assistant.quota; assert(quota && ['ready', 'error'].includes(quota.status)); assert.equal(snapshot.assistant.error, null); assert.equal(snapshot.assistant.connection, 'ready');
  if (quota.status === 'error') { assert(quota.error?.trim(), 'Unavailable quota must have a real explanation.'); assert((await bubble.getByRole('alert').innerText()).trim()); }
  else {
    for (const bucket of quota.buckets) {
      if (quota.buckets.length > 1) await bubble.locator('#quota-bucket').selectOption(bucket.id);
      await bubble.getByRole('region', { name: bucket.name || (bucket.id === 'codex' ? 'codex' : bucket.id), exact: true }).waitFor();
      const windows = [bucket.primary, bucket.secondary].filter(Boolean);
      assert.equal(await bubble.locator('progress').count(), windows.length);
      for (const [index, window] of windows.entries()) { const expected = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)) * 10) / 10; assert.equal(Number(await bubble.locator('progress').nth(index).getAttribute('value')), expected); }
    }
    if (quota.buckets.length > 1) await bubble.locator('#quota-bucket').selectOption(quota.buckets.find(bucket => bucket.id === 'codex')?.id ?? quota.buckets[0].id);
  }
  assert(!Object.hasOwn(quota, 'accountId')); assert(!Object.hasOwn(quota, 'rateLimitUpsell'));
}

try {
  const first = await launch(); assert.equal(first.assistant.threadId, null); assert.equal(first.assistant.messages.length, 0); assert.equal(first.assistant.threads.length, 0);
  await pet.locator('.pet-button').click(); await bubble.getByRole('main', { name: '龙娘小气泡', exact: true }).waitFor(); const single = await state(); assert.equal(single.quickView, 'chat'); result.nativeSingleClickChat = true;
  await pet.locator('.pet-button').dblclick({ delay: 60 }); await bubble.getByRole('main', { name: 'Codex 额度小气泡', exact: true }).waitFor(); await sleep(450); assert.equal((await state()).quickView, 'quota'); result.nativeDoubleClickQuota = true;
  const firstQuota = await waitState(snapshot => ['ready', 'error'].includes(snapshot.assistant.quota?.status), 'First real quota read', 15000); await assertQuotaUi(firstQuota); await capture('quota-first');
  assert.equal(firstQuota.assistant.threadId, null); assert.equal(firstQuota.assistant.messages.length, 0); assert.equal(firstQuota.assistant.threads.length, 0);
  await bubble.getByRole('button', { name: '刷新额度', exact: true }).click(); await sleep(200); const refreshed = await waitState(snapshot => ['ready', 'error'].includes(snapshot.assistant.quota?.status), 'Manual real quota refresh', 15000); await assertQuotaUi(refreshed); await capture('quota-refreshed');
  assert.equal(refreshed.assistant.threadId, null); assert.equal(refreshed.assistant.messages.length, 0); assert.equal(refreshed.assistant.threads.length, 0); result.quotaCreatesNoThreadOrMessages = true; result.quota = { first: quotaSummary(firstQuota), refreshed: quotaSummary(refreshed), available: refreshed.assistant.quota.status === 'ready' && refreshed.assistant.quota.buckets.length > 0 };
  await bubble.getByRole('button', { name: '返回聊天', exact: true }).click(); await bubble.getByRole('main', { name: '龙娘小气泡', exact: true }).waitFor();
  await bubble.evaluate(() => window.pet.setBubbleMode('panel', 'settings')); await bubble.getByRole('heading', { name: '桌宠与任务设置', exact: true }).waitFor();
  const available = (await state()).assistant.models, selected = available.find(model => model.isDefault && model.supportedReasoningEfforts?.length) ?? available.find(model => model.supportedReasoningEfforts?.length); assert(selected, 'A real model must advertise its effort choices.');
  const effort = selected.supportedReasoningEfforts.find(option => option.reasoningEffort !== selected.defaultReasoningEffort)?.reasoningEffort ?? selected.defaultReasoningEffort; assert(effort);
  await bubble.locator('#model').selectOption(selected.id); await waitState(snapshot => snapshot.settings.model === selected.id, 'Model selection');
  const reasoningSelect = bubble.getByRole('combobox', { name: /推理强度/ }); await reasoningSelect.waitFor(); const optionValues = await reasoningSelect.locator('option').evaluateAll(options => options.map(option => option.value)); assert(optionValues.includes(effort)); await reasoningSelect.selectOption(effort); await waitState(snapshot => snapshot.settings.reasoningByModel?.[selected.id] === effort, 'Per-model effort selection');
  const otherModel = available.find(model => model.id !== selected.id && model.supportedReasoningEfforts?.length); let otherSelection = null;
  if (otherModel) { const otherEffort = otherModel.supportedReasoningEfforts.find(option => option.reasoningEffort !== otherModel.defaultReasoningEffort)?.reasoningEffort ?? otherModel.defaultReasoningEffort; assert(otherEffort); await bubble.locator('#model').selectOption(otherModel.id); await waitState(snapshot => snapshot.settings.model === otherModel.id, 'Second model selection'); await reasoningSelect.selectOption(otherEffort); await waitState(snapshot => snapshot.settings.reasoningByModel?.[otherModel.id] === otherEffort, 'Second model effort'); await bubble.locator('#model').selectOption(selected.id); await waitState(snapshot => snapshot.settings.model === selected.id, 'Restore first model'); assert.equal(await reasoningSelect.inputValue(), effort); otherSelection = { model: otherModel.id, effort: otherEffort }; }
  const originInput = bubble.getByRole('textbox', { name: '允许访问的网站地址', exact: true }); await originInput.fill(site); await originInput.locator('..').getByRole('button', { name: '添加', exact: true }).click();
  await bubble.getByRole('switch', { name: /允许网页输入/ }).check(); await waitState(snapshot => snapshot.settings.grant.origins.includes(site) && snapshot.settings.grant.browserInput, 'Lasting website preferences');
  await bubble.evaluate(folder => window.pet.updateSettings({ grant: { folders: [folder], origins: ['https://dragon-pet-test.invalid'], browserInput: true } }), folder); assertSites(await state()); assert.deepEqual((await state()).settings.grant.folders, [folder]);
  result.reasoning = { model: selected.id, effort, advertisedEfforts: selected.supportedReasoningEfforts.map(option => option.reasoningEffort), defaultEffort: selected.defaultReasoningEffort, otherSelection }; result.websitePreferences = { origin: site, browserInput: true, visited: false, chromeConnected: false }; await capture('settings-before-restart');
  await application.close(); application = null;
  const restarted = await launch(); assertSites(restarted); assert.deepEqual(restarted.settings.grant.folders, []); assert.equal(restarted.settings.model, selected.id); assert.equal(restarted.settings.reasoningByModel?.[selected.id], effort); if (otherSelection) assert.equal(restarted.settings.reasoningByModel?.[otherSelection.model], otherSelection.effort); assert.equal(restarted.assistant.threadId, null); result.restartPersistence = true;
  await bubble.evaluate(() => window.pet.setBubbleMode('panel', 'settings')); await bubble.getByRole('combobox', { name: /推理强度/ }).waitFor(); assert.equal(await bubble.getByRole('combobox', { name: /推理强度/ }).inputValue(), effort); await capture('settings-after-restart');
  await bubble.evaluate(folder => window.pet.updateSettings({ grant: { folders: [folder], origins: ['https://dragon-pet-test.invalid'], browserInput: true } }), folder); await bubble.evaluate(() => window.pet.newThread()); const firstThread = await state(); assert(firstThread.assistant.threadId); result.newOwnedThreads.push(firstThread.assistant.threadId); assertSites(firstThread); assert.deepEqual(firstThread.settings.grant.folders, []);
  // app-server only creates a durable rollout after the first real turn. Resume
  // the greeting thread below, rather than an unused empty thread/start handle.
  await bubble.evaluate(() => window.pet.setBubbleMode('quick')); const composer = bubble.getByRole('textbox', { name: '对龙娘说点什么', exact: true }); await composer.waitFor({ state: 'visible' }); await composer.fill('你好，请用一句中文向我问好，不要调用任何工具、访问文件或网页，也不要追问。'); await bubble.getByRole('button', { name: '发送消息', exact: true }).click(); result.uiMessagesSent = 1;
  let lastRetry = ''; const completed = await waitState(snapshot => { const assistant = snapshot.assistant; if (assistant.error) throw new Error(assistant.error); if (assistant.pending.length) throw new Error('Greeting unexpectedly requested a question/approval; no request will be approved.'); if (assistant.diagnostic?.phase === 'turn/retrying' && assistant.diagnostic.message !== lastRetry) { lastRetry = assistant.diagnostic.message; result.retries++; } return !assistant.activeTurnId && assistant.activity === 'idle' && assistant.messages.some(message => message.role === 'assistant' && message.text.trim()); }, 'One real greeting', timeout);
  assert.equal(completed.assistant.messages.filter(message => message.role === 'user').length, 1); assertSites(completed); result.chatCompleted = true; await capture('chat-complete');
  await bubble.evaluate(folder => window.pet.updateSettings({ grant: { folders: [folder], origins: ['https://dragon-pet-test.invalid'], browserInput: true } }), folder); await bubble.evaluate(() => window.pet.newThread()); const secondThread = await state(); assert.notEqual(secondThread.assistant.threadId, firstThread.assistant.threadId); result.newOwnedThreads.push(secondThread.assistant.threadId); assertSites(secondThread); assert.deepEqual(secondThread.settings.grant.folders, []);
  await bubble.evaluate(folder => window.pet.updateSettings({ grant: { folders: [folder], origins: ['https://dragon-pet-test.invalid'], browserInput: true } }), folder); await bubble.evaluate(id => window.pet.resumeThread(id), firstThread.assistant.threadId); const resumed = await state(); assert.equal(resumed.assistant.threadId, firstThread.assistant.threadId); assertSites(resumed); assert.deepEqual(resumed.settings.grant.folders, []); assert.equal(resumed.settings.reasoningByModel?.[selected.id], effort); assert.equal(resumed.assistant.messages.filter(message => message.role === 'user').length, 1); result.newResumeScope = true; await capture('resumed-chat');
  assert.equal(result.errors.length, 0); result.ok = true;
} catch (error) {
  result.errors.push(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  if (bubble && !bubble.isClosed()) { await bubble.screenshot({ path: path.join(directory, 'failure.png'), omitBackground: true }).catch(() => {}); await bubble.evaluate(() => window.pet.stop()).catch(() => {}); }
} finally {
  if (application) await application.close().catch(error => { result.errors.push(`Close: ${error.message}`); result.ok = false; process.exitCode = 1; });
  result.protectedExistingFilesUnchanged = JSON.stringify(protectedBefore) === JSON.stringify(await hashProtected()); if (!result.protectedExistingFilesUnchanged) { result.errors.push('Existing config or pet records changed.'); result.ok = false; process.exitCode = 1; }
  const file = path.join(directory, 'result.json'); await fs.writeFile(file, JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, evidenceFile: file }, null, 2));
}
