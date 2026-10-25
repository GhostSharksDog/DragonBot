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
assert(codexHome && path.isAbsolute(codexHome), 'Use the real signed-in user --codex-home; this test never starts a login.');
const timeout = Number(argument('--timeout-ms') ?? 180000); assert(Number.isFinite(timeout) && timeout >= 10000 && timeout <= 300000);
const expectedName = argument('--expected-skin-name') ?? '银白龙娘 · 逐帧';
const expectedVersion = argument('--expected-version') ?? JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8')).version;
await fs.stat(executable); await fs.stat(codexHome);
const local = path.join(project, '.local'); await fs.mkdir(local, { recursive: true }); const directory = await fs.mkdtemp(path.join(local, 'animation-installed-check-')), dataDir = path.join(directory, 'user-data'); await fs.mkdir(dataDir);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const defaultDataDir = argument('--protected-data-dir') ?? (process.env.APPDATA ? path.join(process.env.APPDATA, 'dragon-pet') : null);
const protectedFiles = [{ label: 'Codex config', file: path.join(codexHome, 'config.toml') }, ...(defaultDataDir ? ['settings.json', 'chat-history.json'].map(name => ({ label: 'Existing pet ' + name, file: path.join(defaultDataDir, name) })) : [])];
async function readProtected() { return Promise.all(protectedFiles.map(async item => { try { return { label: item.label, file: item.file, sha256: digest(await fs.readFile(item.file)) }; } catch (error) { if (error.code === 'ENOENT') return { label: item.label, file: item.file, sha256: null }; throw error; } })); }
const beforeProtected = await readProtected();
const env = { ...process.env, CODEX_HOME: codexHome, DRAGON_PET_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE;
const result = { ok: false, executable, codexHome, directory, dataDir, expectedVersion, version: null, loginReused: false, loginStarted: false, uiMessagesSent: 0, newOwnedThread: false, protectedExistingFilesUnchanged: false, isolatedUserDataVerified: false, skin: null, sequence: [], idlePlaybackFramesObserved: [], thinkingPlaybackFramesObserved: [], trace: [], screenshots: {}, retries: 0, errors: [] };
let application, bubble, pet, thinkingCapture;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const state = () => bubble.evaluate(() => window.pet.getState());
const frameCount = animation => animation?.atlas?.indices?.length ?? animation?.frames?.length ?? 0;
const brief = snapshot => ({ connected: snapshot.assistant.connected, connection: snapshot.assistant.connection, login: snapshot.assistant.login, activity: snapshot.assistant.activity, pending: snapshot.assistant.pending.length, active: Boolean(snapshot.assistant.activeTurnId), error: snapshot.assistant.error, diagnostic: snapshot.assistant.diagnostic });

try {
  application = await _electron.launch({ executablePath: executable, cwd: project, env, timeout: 45000 });
  const windowsDeadline = Date.now() + 30000;
  while ((!bubble || !pet) && Date.now() < windowsDeadline) { bubble = application.windows().find(page => page.url().includes('view=bubble')); pet = application.windows().find(page => page.url().includes('view=pet')); if (!bubble || !pet) await sleep(100); }
  assert(bubble && pet, 'Both real packaged renderer windows must exist.');
  for (const page of [bubble, pet]) page.on('pageerror', error => result.errors.push(error.message));
  await Promise.all([bubble, pet].map(page => page.waitForFunction(() => Boolean(window.pet), null, { timeout: 10000 })));
  const runtime = await application.evaluate(({ app }) => ({ version: app.getVersion(), userData: app.getPath('userData') })); assert.equal(path.resolve(runtime.userData), path.resolve(dataDir)); assert.equal(runtime.version, expectedVersion); result.isolatedUserDataVerified = true;
  const connectionDeadline = Date.now() + 60000; let ready;
  while (Date.now() < connectionDeadline) { ready = await state(); if (ready.assistant.connection === 'ready') break; if (ready.assistant.connection === 'error') throw new Error(`Codex startup failed: ${JSON.stringify(brief(ready))}`); await sleep(100); }
  assert.equal(ready?.assistant.connection, 'ready'); assert.equal(ready.assistant.login, 'signed-in', 'Reuse an existing login; do not start login during this test.'); assert.equal(ready.assistant.threadId, null, 'Fresh isolated data must not resume an existing user thread.'); assert.equal(ready.assistant.messages.length, 0); result.loginReused = true; result.version = ready.version;
  const skin = ready.skin; assert(skin && !skin.manifest.rig, 'New default must be full-frame art, not the old rig.'); assert.equal(skin.manifest.name, expectedName);
  for (const action of ['idle', 'thinking']) assert.equal(frameCount(skin.manifest.animations[action]), 24, `${action} requires 24 playback frames; held sources are valid.`);
  result.skin = { name: skin.manifest.name, kind: 'frames', width: skin.manifest.width, height: skin.manifest.height, idle: { playbackFrames: frameCount(skin.manifest.animations.idle), imageFiles: skin.manifest.animations.idle.frames.length }, thinking: { playbackFrames: frameCount(skin.manifest.animations.thinking), imageFiles: skin.manifest.animations.thinking.frames.length } };
  await bubble.evaluate(() => window.pet.updateSettings({ roaming: true, grant: { folders: [], origins: [], browserInput: false } }));
  assert(!['walking-left', 'walking-right', 'running-left', 'running-right'].some(name => skin.manifest.animations[name]), 'This default intentionally has no unapproved roaming animation.');
  const bounds = () => application.evaluate(({ BrowserWindow, screen }) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=pet')); return { bounds: window.getBounds(), cursor: screen.getCursorScreenPoint() }; });
  const stablePositions = [];
  for (let index = 0; index < 7; index++) { stablePositions.push(await bounds()); await sleep(350); }
  assert.equal(new Set(stablePositions.map(sample => `${sample.bounds.x},${sample.bounds.y}`)).size, 1, 'No roaming art: roaming preference stays true while the pet window stays still.');
  assert.equal((await state()).settings.roaming, true); result.roamingPreferencePreserved = true; result.noRoamingWindowPositions = stablePositions;
  const dragBefore = await bounds(), button = await pet.locator('.pet-button').boundingBox(); assert(button); const dragX = button.x + button.width / 2, dragY = button.y + button.height * .55;
  await pet.mouse.move(dragX, dragY); await pet.mouse.down(); await pet.mouse.move(dragX - 28, dragY - 12, { steps: 8 }); await pet.mouse.up(); await sleep(250);
  const dragAfter = await bounds(); assert(Math.hypot(dragAfter.bounds.x - dragBefore.bounds.x, dragAfter.bounds.y - dragBefore.bounds.y) > 4, 'Real renderer pointer drag must still move the pet.'); result.drag = { before: dragBefore.bounds, after: dragAfter.bounds, moved: true };
  await pet.exposeFunction('__captureThinkingProof', async sample => {
    if (!thinkingCapture) thinkingCapture = (async () => { result.screenshots.thinking = path.join(directory, 'thinking.png'); await pet.screenshot({ path: result.screenshots.thinking, omitBackground: true }); result.thinkingScreenshotObservedAt = sample; })();
    await thinkingCapture;
  });
  await pet.evaluate(async () => {
    let latest = await window.pet.getState(), screenshotRequested = false, lastKey = '';
    const samples = []; window.__animationCheck = { samples, latest: null, stop: null };
    function sample() {
      const image = document.querySelector('img.pet-sprite'), canvas = document.querySelector('canvas[data-animation],canvas.frame-canvas,canvas.sprite-canvas,canvas.rig-canvas'), element = image ?? canvas, dataset = element?.dataset ?? {};
      const activity = latest.assistant.activity, animation = dataset.animation ?? dataset.frameAnimation ?? null, frame = Number(dataset.frame ?? dataset.frameIndex ?? -1), source = image?.currentSrc || image?.src || dataset.source || dataset.src || dataset.frameSource || dataset.assetUrl || null;
      const definition = latest.skin?.manifest.animations[animation ?? activity], expectedSources = (definition?.frames ?? []).map(file => new URL(file, latest.skin.baseUrl.endsWith('/') ? latest.skin.baseUrl : latest.skin.baseUrl + '/').href);
      let loaded = Boolean(image?.complete && image.naturalWidth > 0), alphaPixels = null;
      if (!image && canvas) { try { const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; alphaPixels = 0; for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) alphaPixels++; loaded = alphaPixels > 0; } catch { loaded = canvas.width > 0 && canvas.height > 0 && (dataset.ready === 'true' || dataset.frameReady === 'true'); } }
      const value = { time: Date.now(), activity, animation, frame, renderer: image ? 'img' : canvas ? 'canvas' : 'missing', loaded, alphaPixels, source, expectedAssetMatch: source ? expectedSources.includes(source) : null, active: Boolean(latest.assistant.activeTurnId), pending: latest.assistant.pending.length, epoch: Number(dataset.epoch ?? 0), decodeCount: Number(dataset.decodeCount ?? 0), renderCount: Number(dataset.renderCount ?? 0), imageLeft: image?.style.left ?? null, imageTop: image?.style.top ?? null };
      const key = JSON.stringify({ ...value, time: 0 }); if (key !== lastKey) { lastKey = key; samples.push(value); }
      window.__animationCheck.latest = value;
      if (!screenshotRequested && activity === 'thinking' && animation === 'thinking' && loaded && value.expectedAssetMatch !== false) { screenshotRequested = true; void window.__captureThinkingProof(value); }
    }
    const unsubscribe = window.pet.onState(next => { latest = next; sample(); }), timer = setInterval(sample, 25); window.__animationCheck.stop = () => { clearInterval(timer); unsubscribe(); }; sample();
  });
  await pet.waitForFunction(() => { const frame = window.__animationCheck.latest; return frame?.activity === 'idle' && frame.animation === 'idle' && frame.loaded && frame.expectedAssetMatch !== false; }, null, { timeout: 15000 });
  await sleep(350); result.screenshots.idleBefore = path.join(directory, 'idle-before.png'); await pet.screenshot({ path: result.screenshots.idleBefore, omitBackground: true });
  await pet.locator('.pet-button').click();
  const composer = bubble.getByRole('textbox', { name: '对龙娘说点什么', exact: true }); await composer.waitFor({ state: 'visible' });
  await composer.fill('你好，请先想一想，再用一句中文向我问好。不要调用工具、读写文件或打开网页，也不要追问。'); const sentAt = Date.now(); await bubble.getByRole('button', { name: '发送消息', exact: true }).click(); result.uiMessagesSent = 1;
  let sawActive = false, complete = false, lastRetry = '', finalState;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = await state(); finalState = snapshot; const assistant = snapshot.assistant;
    if (assistant.activeTurnId) sawActive = true;
    if (assistant.error) throw new Error(`Chat failed: ${JSON.stringify(brief(snapshot))}`);
    if (assistant.pending.length) { await bubble.evaluate(() => window.pet.stop()); throw new Error('A plain animation chat requested interaction/tool permission; test stopped without approving anything.'); }
    if (assistant.diagnostic?.phase === 'turn/retrying' && assistant.diagnostic.message !== lastRetry) { lastRetry = assistant.diagnostic.message; result.retries++; }
    const visual = await pet.evaluate(() => window.__animationCheck.latest);
    if ((sawActive || assistant.messages.some(message => message.role === 'assistant' && message.text)) && !assistant.activeTurnId && assistant.activity === 'idle' && visual?.activity === 'idle' && visual.animation === 'idle' && visual.loaded && visual.expectedAssetMatch !== false) { complete = true; break; }
    await sleep(40);
  }
  assert(complete, `Chat did not return to idle: ${JSON.stringify(brief(finalState ?? await state()))}`); assert(finalState.assistant.messages.some(message => message.role === 'assistant' && message.text.trim())); assert.equal(finalState.assistant.messages.filter(message => message.role === 'user').length, 1); result.newOwnedThread = Boolean(finalState.assistant.threadId);
  await sleep(350); if (thinkingCapture) await thinkingCapture;
  result.screenshots.idleAfter = path.join(directory, 'idle-after.png'); await pet.screenshot({ path: result.screenshots.idleAfter, omitBackground: true }); result.screenshots.reply = path.join(directory, 'chat-result.png'); await bubble.screenshot({ path: result.screenshots.reply });
  result.trace = await pet.evaluate(() => { window.__animationCheck.stop(); return window.__animationCheck.samples; });
  const idleBefore = result.trace.filter(sample => sample.time < sentAt && sample.activity === 'idle' && sample.animation === 'idle' && sample.loaded), thinking = result.trace.filter(sample => sample.time >= sentAt && sample.activity === 'thinking' && sample.animation === 'thinking' && sample.loaded);
  const lastThinkingAt = thinking.at(-1)?.time ?? Infinity, idleAfter = result.trace.filter(sample => sample.time > lastThinkingAt && sample.activity === 'idle' && sample.animation === 'idle' && sample.loaded && !sample.active);
  assert(idleBefore.length && thinking.length && idleAfter.length, 'Actual renderer must demonstrate idle → thinking → idle.');
  for (const sample of [...idleBefore, ...thinking, ...idleAfter]) { assert(sample.frame >= 0 && sample.frame < 24, 'Playback index must address the actual 24-frame animation.'); assert(sample.expectedAssetMatch !== false); }
  result.idlePlaybackFramesObserved = [...new Set([...idleBefore, ...idleAfter].map(sample => sample.frame))]; result.thinkingPlaybackFramesObserved = [...new Set(thinking.map(sample => sample.frame))]; assert(result.idlePlaybackFramesObserved.length > 1, 'Idle playback must advance even when it repeats a held source frame.'); assert(result.thinkingPlaybackFramesObserved.length > 1, 'Thinking playback must advance in the real renderer.'); assert(result.screenshots.thinking, 'Actual thinking screenshot must be captured.');
  const fallbackIdle = result.trace.filter(sample => sample.time > lastThinkingAt && sample.animation === 'idle' && sample.loaded && sample.epoch > 0); if (fallbackIdle.length) { assert.equal(new Set(fallbackIdle.map(sample => sample.epoch)).size, 1, 'Speaking/success→idle fallback must retain the same idle epoch.'); result.idleFallbackEpochPreserved = true; }
  const decodedCounts = result.trace.filter(sample => sample.loaded && sample.decodeCount > 0).map(sample => sample.decodeCount); if (decodedCounts.length) { assert.equal(new Set(decodedCounts).size, 1, 'State changes must reuse already decoded textures.'); result.decodedTextureCacheReused = true; result.decodedTextureCount = decodedCounts[0]; }
  result.sequence = ['idle', 'thinking', 'idle']; result.assetSwitchVerified = { idle: [...new Set(idleBefore.map(sample => sample.source))], thinking: [...new Set(thinking.map(sample => sample.source))], returnedIdle: [...new Set(idleAfter.map(sample => sample.source))] }; assert(result.newOwnedThread); assert.equal(result.errors.length, 0); result.ok = true;
} catch (error) {
  result.errors.push(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  if (pet && !pet.isClosed()) { result.trace = await pet.evaluate(() => { window.__animationCheck?.stop?.(); return window.__animationCheck?.samples ?? []; }).catch(() => []); await pet.screenshot({ path: path.join(directory, 'failure-pet.png'), omitBackground: true }).catch(() => {}); }
  if (bubble && !bubble.isClosed()) await bubble.evaluate(() => window.pet.stop()).catch(() => {});
} finally {
  if (application) await application.close().catch(error => { result.errors.push(`Close: ${error.message}`); result.ok = false; process.exitCode = 1; });
  const afterProtected = await readProtected(); result.protectedExistingFilesUnchanged = JSON.stringify(beforeProtected) === JSON.stringify(afterProtected); if (!result.protectedExistingFilesUnchanged) { result.errors.push('An existing protected config or pet record changed.'); result.ok = false; process.exitCode = 1; }
  const file = path.join(directory, 'result.json'); await fs.writeFile(file, JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, trace: `${result.trace.length} renderer samples (full trace saved in result.json)`, evidenceFile: file }, null, 2));
}
