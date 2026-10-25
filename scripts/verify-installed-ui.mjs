import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = flag => { const index = process.argv.indexOf(flag); if (index === -1) return null; const result = process.argv[index + 1]; if (!result || result.startsWith('--')) throw new Error(`${flag} requires a value.`); return result; };
const executable = path.resolve(value('--executable') ?? path.join(root, 'release/win-unpacked/龙娘桌宠.exe'));
const codexHome = value('--codex-home') ?? process.env.CODEX_HOME;
assert(codexHome && path.isAbsolute(codexHome), 'Pass the actual user --codex-home as an absolute existing directory.');
const timeout = Number(value('--timeout-ms') ?? 240000);
assert(Number.isFinite(timeout) && timeout >= 10000 && timeout <= 360000, 'Invalid --timeout-ms.');
await fs.stat(executable); await fs.stat(codexHome);
const local = path.join(root, '.local'); await fs.mkdir(local, { recursive: true });
const directory = await fs.mkdtemp(path.join(local, 'installed-ui-check-'));
const files = path.join(directory, 'files'), userData = path.join(directory, 'user-data');
await fs.mkdir(files); await fs.mkdir(userData);
const target = path.join(files, 'overwrite-target.txt');
const inside = (base, candidate) => { const relative = path.relative(base, path.resolve(candidate)); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
assert(inside(local, directory) && inside(files, target), 'Test files must stay under project .local.');
await fs.writeFile(target, 'before', 'utf8');
const configPath = path.join(codexHome, 'config.toml');
const configHash = async () => createHash('sha256').update(await fs.readFile(configPath)).digest('hex');
const initialHash = await configHash();
const env = { ...process.env, CODEX_HOME: codexHome, DRAGON_PET_DATA_DIR: userData }; delete env.ELECTRON_RUN_AS_NODE;
const result = { ok: false, executable, codexHome, directory, target, version: null, reusedLogin: false, quickMode: false, quickDraftPreserved: false, questionStepPreserved: false, rightMenu: null, questionAnswers: 0, deniedApprovals: 0, allowedApprovals: 0, before: 'before', afterDenied: null, afterAllowed: null, streamed: false, turns: [], errors: [], globalConfigUnchanged: false };
let app, page, petPage;
const state = () => page.evaluate(() => window.pet.getState());
const brief = snapshot => ({ connected: snapshot.assistant.connected, connection: snapshot.assistant.connection, login: snapshot.assistant.login, activity: snapshot.assistant.activity, activeTurnId: snapshot.assistant.activeTurnId, pending: snapshot.assistant.pending.map(item => ({ id: item.id, kind: item.kind, title: item.title })), error: snapshot.assistant.error, diagnostic: snapshot.assistant.diagnostic });

async function runTurn(prompt, decision, requireQuestion) {
  const initial = await state(); const initialMessages = initial.assistant.messages.length;
  assert.equal(initial.assistant.activeTurnId, null); assert.equal(initial.assistant.pending.length, 0);
  const composer = page.getByRole('textbox', { name: '对龙娘说点什么', exact: true });
  await composer.fill(prompt); await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const started = Date.now(), handled = new Set(); let sawTurn = false, questions = 0, approvals = 0, retries = 0, lastDiagnostic = '';
  while (Date.now() - started < timeout) {
    const snapshot = await state(); const assistant = snapshot.assistant;
    if (assistant.activeTurnId) sawTurn = true;
    if (assistant.messages.slice(initialMessages).some(message => message.role === 'assistant' && message.text)) result.streamed = true;
    if (assistant.diagnostic?.phase === 'turn/retrying' && assistant.diagnostic.message !== lastDiagnostic) { retries++; lastDiagnostic = assistant.diagnostic.message; }
    if (assistant.error) throw new Error(`Turn failed: ${JSON.stringify(brief(snapshot))}`);
    for (const pending of assistant.pending) {
      if (handled.has(pending.id)) continue;
      assert.equal(pending.threadId, assistant.threadId); assert.equal(pending.turnId, assistant.activeTurnId);
      handled.add(pending.id);
      if (pending.kind === 'question') {
        const card = page.getByRole('region', { name: '等待回答', exact: true });
        await card.waitFor({ state: 'visible', timeout: 10000 });
        const fieldsets = card.locator('fieldset'); assert.equal(await fieldsets.count(), result.quickMode ? 1 : pending.questions.length);
        if (requireQuestion && result.quickMode) assert(pending.questions.length >= 2, 'Quick mode must receive a real multi-question request.');
        for (let index = 0; index < pending.questions.length; index++) {
          const question = pending.questions[index]; assert(!question.isSecret, 'Test never enters credentials.');
          const fieldset = fieldsets.nth(result.quickMode ? 0 : index);
          if (question.header) assert((await fieldset.locator('legend').innerText()).includes(question.header));
          if (question.options?.length) await fieldset.locator('input[type=radio]').first().check();
          else await fieldset.locator('input.custom-answer').fill('继续验收，只操作指定测试文件。');
          if (result.quickMode && index === 1) {
            const input = fieldset.locator('input.custom-answer'); await input.fill('approved');
            await page.getByRole('button', { name: '收起气泡', exact: true }).click();
            await petPage.locator('.pet-button').click(); await card.waitFor({ state: 'visible' });
            assert.equal(await card.locator('input.custom-answer').inputValue(), 'approved');
            if (question.header) assert((await card.locator('legend').innerText()).includes(question.header));
            result.questionStepPreserved = true;
          }
          await page.screenshot({ path: path.join(directory, `turn-${decision}-question-${index + 1}.png`) });
          if (result.quickMode && index < pending.questions.length - 1) {
            await card.getByRole('button', { name: '下一题', exact: true }).click();
            assert((await state()).assistant.pending.some(item => item.id === pending.id), 'Next question must not submit an incomplete response.');
          }
        }
        await card.getByRole('button', { name: '回答并继续', exact: true }).click();
        questions += pending.questions.length; result.questionAnswers += pending.questions.length; process.stdout.write(`UI: answered ${pending.questions.length} ${decision} turn questions.\n`);
      } else {
        assert.equal(pending.kind, 'approval'); assert.equal(pending.title, '覆盖文件', 'Never approve native, expansion, deletion, browser or unrelated requests.');
        assert.equal(pending.supportsSession, false); assert.equal(approvals, 0, 'One overwrite approval per turn; no automatic retries.');
        const paths = pending.details.filter(detail => detail.startsWith('路径：')).map(detail => detail.slice(3));
        assert.equal(paths.length, 1); assert(inside(files, paths[0])); assert.equal(path.resolve(paths[0]).toLowerCase(), target.toLowerCase());
        assert(pending.details.some(detail => detail === '内容预览：\napproved'), 'Only the exact test content can be approved.');
        if (requireQuestion) assert(questions > 0, 'The real model must ask before requesting overwrite.');
        const card = page.getByRole('region', { name: '等待批准', exact: true });
        await card.waitFor({ state: 'visible', timeout: 10000 });
        assert((await card.innerText()).includes(target));
        await page.screenshot({ path: path.join(directory, `turn-${decision}-approval.png`) });
        await card.getByRole('button', { name: decision === 'deny' ? '拒绝' : '允许本次', exact: true }).click();
        approvals++; if (decision === 'deny') result.deniedApprovals++; else result.allowedApprovals++;
        process.stdout.write(`UI: ${decision === 'deny' ? 'denied' : 'allowed'} exact test-file overwrite.\n`);
      }
    }
    if (sawTurn && !assistant.activeTurnId && assistant.pending.length === 0 && ['success', 'idle'].includes(assistant.activity)) {
      assert.equal(approvals, 1, 'Expected one real file-overwrite approval.'); if (requireQuestion) assert(questions > 0);
      assert(!assistant.messages.slice(initialMessages).some(message => message.role === 'system' && message.text.includes('已拦截原生')), 'Native action paths must not be used.');
      const record = { decision, questions, approvals, retries, durationMs: Date.now() - started, finalActivity: assistant.activity };
      result.turns.push(record); await page.screenshot({ path: path.join(directory, `turn-${decision}-completed.png`) }); return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Turn timed out: ${JSON.stringify(brief(await state()))}`);
}

try {
  app = await _electron.launch({ executablePath: executable, cwd: root, env, timeout: 45000 });
  const deadline = Date.now() + 30000;
  while (!page && Date.now() < deadline) { page = app.windows().find(window => window.url().includes('view=bubble')); if (!page) await new Promise(resolve => setTimeout(resolve, 100)); }
  assert(page, 'Packaged chat window did not load.');
  petPage = app.windows().find(window => window.url().includes('view=pet')); assert(petPage, 'Packaged pet window did not load.');
  page.on('pageerror', error => result.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.pet), null, { timeout: 10000 });
  let ready; const connectionDeadline = Date.now() + 45000;
  while (Date.now() < connectionDeadline) {
    ready = await state();
    if (ready.assistant.connection === 'ready') break;
    if (ready.assistant.connection === 'error') throw new Error(`Startup failed: ${JSON.stringify(brief(ready))}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(ready?.assistant.connection, 'ready', 'Codex startup did not finish within 45 seconds.');
  result.version = ready.version; result.reusedLogin = ready.assistant.login === 'signed-in';
  assert(result.reusedLogin, `Expected existing login: ${JSON.stringify(brief(ready))}`);
  await page.evaluate(folder => window.pet.updateSettings({ roaming: false, alwaysOnTop: false, grant: { folders: [folder], origins: [], browserInput: false } }), files);
  const configured = await state(); assert.deepEqual(configured.settings.grant.folders, [files]); assert.deepEqual(configured.settings.grant.origins, []);
  if (configured.bubbleMode !== undefined) {
    await page.evaluate(() => window.pet.setBubbleMode('hidden')); await petPage.locator('.pet-button').click();
    assert.equal((await state()).bubbleMode, 'quick'); result.quickMode = true;
    const composer = page.getByRole('textbox', { name: '对龙娘说点什么', exact: true }); await composer.fill('小气泡草稿保留验收');
    await page.getByRole('button', { name: '收起气泡', exact: true }).click(); await petPage.locator('.pet-button').click();
    assert.equal(await composer.inputValue(), '小气泡草稿保留验收'); result.quickDraftPreserved = true; await composer.fill('');
    await page.screenshot({ path: path.join(directory, 'quick-greeting.png') });
  } else await page.evaluate(() => window.pet.setBubble(true));
  await runTurn(`这是桌宠真实安装版的UI验收。唯一允许操作的文件是 ${target}，它已经存在且内容为 before。严格按顺序：先用一次 request_user_input 请求提出${result.quickMode ? '两道问题：第一题“是否继续覆盖测试文件？”，选项“继续验收”和“停止”；第二题“目标内容是否为 approved？”，选项“approved”和“停止”' : '问题“是否继续覆盖测试文件？”，给出“继续验收”和“停止”两个选项'}；收到全部回答后，仅调用一次 pet_files_write，将这个已有文件的完整内容改为 approved（8个ASCII字符，无换行），正常等待覆盖审批。如果用户拒绝，立即结束本轮并说明没有修改；不能换路径、换工具或再次请求。不要创建其他文件，不联网，不执行命令。`, 'deny', true);
  result.afterDenied = await fs.readFile(target, 'utf8'); assert.equal(result.afterDenied, 'before');
  await runTurn(`这是新的用户指令，上一轮已结束。这次重新申请覆盖同一测试文件 ${target}。无需再追问目标，直接仅调用一次 pet_files_write，完整内容为 approved（8个ASCII字符，无换行），等待覆盖审批；允许后执行，拒绝后停止。只使用受控文件工具，不操作其他文件、网站或命令。完成后如实回复结果。`, 'allow', false);
  result.afterAllowed = await fs.readFile(target, 'utf8'); assert.equal(result.afterAllowed, 'approved');
  if (result.quickMode) {
    await app.evaluate(({ Menu }) => {
      const original = Menu.prototype.popup;
      globalThis.__rigUiCheckOriginalPopup = original;
      Menu.prototype.popup = function (...args) { globalThis.__rigUiCheckMenu = this; globalThis.__rigUiCheckMenuCount = (globalThis.__rigUiCheckMenuCount ?? 0) + 1; return Reflect.apply(original, this, args); };
    });
    const menuResults = [];
    for (const tab of ['settings', 'history']) {
      const beforeCount = await app.evaluate(() => globalThis.__rigUiCheckMenuCount ?? 0);
      await petPage.locator('.pet-button').click({ button: 'right' });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && await app.evaluate(() => globalThis.__rigUiCheckMenuCount ?? 0) === beforeCount) await new Promise(resolve => setTimeout(resolve, 100));
      assert((await app.evaluate(() => globalThis.__rigUiCheckMenuCount ?? 0)) > beforeCount, 'Pet right-click must open a real native context menu.');
      const selection = await app.evaluate((_electron, tab) => {
        const menu = globalThis.__rigUiCheckMenu, labels = menu.items.map(item => item.label);
        const item = menu.items.find(item => tab === 'settings' ? /设置/.test(item.label) : /历史|过去的对话|对话记录/.test(item.label));
        if (!item || !item.enabled) throw new Error(`No enabled ${tab} native menu item: ${labels.join(', ')}`);
        menu.closePopup(); item.click(item); return { tab, label: item.label, labels };
      }, tab);
      await page.waitForFunction(tab => { const heading = document.querySelector('.section-heading h2')?.textContent ?? ''; return tab === 'settings' ? heading.includes('设置') : heading.includes('对话'); }, tab);
      const selected = await state(); assert.equal(selected.bubbleMode, 'panel'); assert.equal(selected.panelTab, tab);
      await page.screenshot({ path: path.join(directory, `native-menu-${tab}.png`) }); menuResults.push(selection);
    }
    await app.evaluate(({ Menu }) => { Menu.prototype.popup = globalThis.__rigUiCheckOriginalPopup; });
    result.rightMenu = { nativePopup: true, selections: menuResults };
  }
  result.globalConfigUnchanged = initialHash === await configHash(); assert(result.globalConfigUnchanged);
  assert.equal(result.errors.length, 0); assert(result.streamed); result.ok = true;
} catch (error) {
  result.errors.push(error instanceof Error ? error.message : String(error));
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {}); await page.evaluate(() => window.pet.stop()).catch(() => {}); }
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(error => { result.errors.push(`Close: ${error.message}`); result.ok = false; process.exitCode = 1; });
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify({ ...result, evidenceFile: path.join(directory, 'result.json') })}\n`);
}
