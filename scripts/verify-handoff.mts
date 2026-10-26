import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCodex, spawnAppServer } from '../src/main/agent/transport';
import { isolatedConfigArgs } from '../src/main/agent/service';
import { ProjectService, userMessages } from '../src/main/projects';
import { defaults } from '../src/main/settings';
import type { Thread } from '../src/generated/codex/v2/Thread';

// Explicitly supplied, completed acceptance conversation only. Never target the
// active development conversation and never resume/turn-start from this backend.
const testId = process.env.DRAGON_TEST_THREAD;
const restoreId = process.env.DRAGON_RESTORE_THREAD;
if (!testId || !restoreId || testId === restoreId || ![testId, restoreId].every(id => /^[0-9a-f-]{36}$/.test(id))) throw Error('Provide distinct test/restore conversation IDs.');
const directory = await mkdtemp(path.resolve('.local/handoff-060-'));
const title = process.env.DRAGON_TEST_TITLE || '桌宠 0.6 接续验收';
const prompt = '这是桌宠接续的发送验收。不要读取文件或使用工具，只回复：接续验收完成。';
const { child, rpc } = spawnAppServer(await resolveCodex(''), isolatedConfigArgs(), directory);
const run = promisify(execFile);
const openLink = async (url: string) => { if (!/^codex:\/\/threads\/[0-9a-f-]{36}$/.test(url)) throw Error('Invalid link'); await run('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], { windowsHide: true }); };
let service: ProjectService | undefined;
try {
  await rpc.request('initialize', { clientInfo: { name: 'dragon-handoff-check', version: '0.6.0' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized');
  const readThread = async (id: string) => {
    const { thread } = await rpc.request<{thread: Thread}>('thread/read', { threadId: id, includeTurns: false });
    const recent = await rpc.request<{data: Thread['turns']}>('thread/turns/list', { threadId: id, limit: 12, sortDirection: 'desc', itemsView: 'summary' }); thread.turns = recent.data.slice().reverse(); return thread;
  };
  const before = await readThread(testId);
  assert(before.turns.every(turn => turn.status !== 'inProgress'), 'Test conversation must be idle.');
  assert(before.preview.includes('隔离验收'), 'Use a prior isolated project acceptance conversation.');
  await rpc.request('thread/name/set', { threadId: testId, name: title });
  const settings = { ...structuredClone(defaults), projects: [{ id: 'fixture', name: '接续验收', directory, application: 'codex' as const, threadId: testId, threadTitle: title }], activeProjectId: 'fixture' };
  const updates: unknown[] = [];
  service = new ProjectService({ dataDir: directory, helperPath: path.resolve('dist/native/desktop-chat.exe'), getSettings: () => settings, saveSettings: () => {}, listThreads: async () => [], readThread, openLink,
    uniqueTitle: async (id, name) => { const result = await rpc.request<{data: Thread[],nextCursor: string|null}>('thread/list',{searchTerm:name,limit:100}); return !result.nextCursor && result.data.filter(t => t.name === name).length === 1 && result.data.some(t => t.id === id); },
    choose: async question => { throw Error('Acceptance requires user interaction: ' + question); }, notify: () => {}, changed: () => { updates.push(service?.getSnapshot()); } });
  await service.send('fixture', prompt);
  const deadline = Date.now() + 100000;
  while (Date.now() < deadline && service.getSnapshot()?.status !== 'completed') { await new Promise(r => setTimeout(r, 1000)); await service.refresh(); }
  const after = await readThread(testId);
  const added = userMessages(after).filter(message => !userMessages(before).some(old => old.id === message.id));
  assert.equal(added.filter(message => message.text.trimEnd() === prompt).length, 1, 'Exactly one message sent by target app.');
  assert.equal(service.getSnapshot()?.status, 'completed');
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ok:true,threadId:testId,title,updates}, null, 2));
  console.log(directory);
} catch (error) { await writeFile(path.join(directory,'error.txt'),String(error)); throw error; }
finally { await service?.dispose(); await openLink(`codex://threads/${restoreId}`); rpc.close(); child.kill(); }
