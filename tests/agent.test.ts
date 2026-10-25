import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonLineRpc, attachAppServer, resolveCodex, sanitizeDiagnostic } from '../src/main/agent/transport';
import { InteractionQueue } from '../src/main/agent/interactions';
import { AssistantService, DISABLED_FEATURES, isolatedConfigArgs, tomlKey, type BackendRuntime } from '../src/main/agent/service';
import type { AssistantSnapshot, Settings } from '../src/shared/types';
import type { RpcMessage } from '../src/main/agent/transport';

test('JSONL correlates concurrent responses, fragmented Chinese text, and server requests', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  let outgoing = ''; output.on('data', chunk => { outgoing += chunk.toString(); });
  const rpc = new JsonLineRpc(input, output);
  const events: RpcMessage[] = []; rpc.on('message', message => events.push(message));
  const one = rpc.request<{ ok: boolean }>('account/read', {});
  const two = rpc.request<string>('model/list', {});
  input.write('{"id":2,"result":"模型"}\n{"id":1,"res');
  input.write('ult":{"ok":true}}\n{"id":"问答-1","method":"item/tool/requestUserInput","params":{"question":"你好"}}\n');
  assert.deepEqual(await one, { ok: true }); assert.equal(await two, '模型');
  assert.equal(events[0].id, '问答-1');
  rpc.respond('问答-1', { answers: {} });
  const frames = outgoing.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames.length, 3); assert.deepEqual(frames[2], { id: '问答-1', result: { answers: {} } });
  rpc.close();
});

test('a failed connection rejects outstanding RPCs, without accepting malformed JSON', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const rpc = new JsonLineRpc(input, output);
  const pending = rpc.request('thread/start', {});
  const rejected = assert.rejects(pending, /无效的消息/);
  input.write('not json\n'); await rejected;
  await assert.rejects(rpc.request('account/read', {}), /尚未连接/);
});

const approval = { threadId: 'thread', turnId: 'turn', title: '覆盖文件', description: '将替换已有内容', details: ['C:\\test\\file.txt'], supportsSession: false };
test('approvals resolve once, reject unsupported session grants, and expire on stop', () => {
  const results: string[] = []; const queue = new InteractionQueue(() => {});
  const first = queue.approval(approval, result => results.push(result));
  assert.throws(() => queue.approve(first, 'session'), /仅支持本次/);
  queue.approve(first, 'deny');
  assert.throws(() => queue.approve(first, 'allow'), /过期/);
  const second = queue.approval(approval, result => results.push(result));
  queue.clear();
  assert.deepEqual(results, ['deny', 'deny']); assert.equal(queue.snapshot().length, 0);
  assert.throws(() => queue.approve(second, 'allow'), /过期/);
});

test('questions require every answer and do not permit duplicate replies', () => {
  const queue = new InteractionQueue(() => {}); let received: unknown;
  const id = queue.question({ threadId: 'thread', turnId: 'turn', title: '需要补充', questions: [{ id: 'folder', header: '文件夹', question: '使用哪个文件夹？' }] }, answer => { received = answer; });
  assert.throws(() => queue.answer({ id, answers: {} }), /全部问题/);
  queue.answer({ id, answers: { folder: ['D:\\documents'], injected: ['ignore'] } });
  assert.deepEqual(received, { folder: ['D:\\documents'] });
  assert.throws(() => queue.answer({ id, answers: { folder: ['again'] } }), /过期/);
});

test('Codex process overrides disable action paths and quote MCP identifiers without a shell', () => {
  const args = isolatedConfigArgs(['node_repl', 'a.server with "quotes"', 'DEL\u007f', 'node_repl']);
  for (const feature of DISABLED_FEATURES) assert(args.includes(`features.${feature}=false`));
  assert(args.includes('sandbox_mode="read-only"')); assert(args.includes('web_search="disabled"'));
  assert(args.includes('features.code_mode_host=true')); assert(args.includes('features.code_mode=false'));
  const overrides = args.filter(value => value.startsWith('mcp_servers='));
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0], 'mcp_servers={"node_repl"={enabled=false},"a.server with \\"quotes\\""={enabled=false},"DEL\\u007F"={enabled=false}}');
  assert(!args.some(value => value.startsWith('mcp_servers.')));
});

const settings: Settings = { scale: 1, roaming: true, alwaysOnTop: true, model: '', codexPath: '', chromeExecutablePath: '', chromeUserDataDir: '', chromeProfileDirectory: '', grant: { folders: [], origins: [] }, skinPath: null };
type TestInternals = { state: AssistantSnapshot; rpc: JsonLineRpc | null; acceptingTools: boolean; onMessage(message: RpcMessage): Promise<void>; onRequest(request: RpcMessage): Promise<void> };

test('live tool approval is attached to the real task and stopping denies the operation', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-queue-test-'));
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: { definitions: () => [], call: async () => ({ contentItems: [], success: false }), connectBrowser: async () => {}, dispose: async () => {} }, openExternal: async () => {} });
  const internals = service as unknown as TestInternals;
  internals.state.connected = true; internals.state.threadId = 'owned-thread'; internals.state.activeTurnId = 'live-turn';
  internals.acceptingTools = true;
  try {
    const permission = service.requestApproval({ title: '删除', description: '删除测试文件', details: ['test.txt'] });
    const view = service.getSnapshot();
    assert.equal(view.activity, 'awaiting-approval'); assert.equal(view.pending[0].turnId, 'live-turn');
    await service.stop(); assert.equal(await permission, false);
    await assert.rejects(service.approve(view.pending[0].id, 'allow'), /过期/);
    assert.equal(await service.requestApproval({ title: '旧操作', description: '', details: [] }), false);
  } finally { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

test('native approvals are denied, and stopped dynamic tool calls never execute', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-native-test-'));
  let calls = 0;
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: { definitions: () => [{ name: 'file_write', description: '', inputSchema: {} }], call: async () => { calls++; return { contentItems: [], success: true }; }, connectBrowser: async () => {}, dispose: async () => {} }, openExternal: async () => {} });
  const input = new PassThrough(); const output = new PassThrough(); let outgoing = ''; output.on('data', chunk => { outgoing += chunk.toString(); });
  const rpc = new JsonLineRpc(input, output); const internals = service as unknown as TestInternals;
  internals.rpc = rpc; internals.state.connected = true; internals.state.threadId = 'owned-thread';
  try {
    await internals.onRequest({ id: 'native', method: 'item/fileChange/requestApproval', params: { threadId: 'owned-thread', turnId: 'stopped', itemId: 'patch', startedAtMs: 0 } });
    await internals.onRequest({ id: 'dynamic', method: 'item/tool/call', params: { threadId: 'owned-thread', turnId: 'stopped', callId: 'call', namespace: null, tool: 'file_write', arguments: {} } });
    assert.equal(calls, 0);
    const frames = outgoing.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(frames[0].result, { decision: 'decline' }); assert.equal(frames[1].result.success, false);
  } finally { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

test('streaming text persists, while unanswered questions and approvals are never replayed', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-history-test-'));
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: { definitions: () => [], call: async () => ({ contentItems: [], success: false }), connectBrowser: async () => {}, dispose: async () => {} }, openExternal: async () => {} });
  const internals = service as unknown as TestInternals;
  internals.state.connected = true; internals.state.threadId = 'owned-thread'; internals.state.activeTurnId = 'live-turn';
  internals.acceptingTools = true;
  await internals.onMessage({ method: 'item/agentMessage/delta', params: { threadId: 'owned-thread', turnId: 'live-turn', itemId: 'response', delta: '你好，' } });
  await internals.onMessage({ method: 'item/agentMessage/delta', params: { threadId: 'owned-thread', turnId: 'live-turn', itemId: 'response', delta: '主人。' } });
  const pending = service.requestApproval({ title: '敏感操作', description: '待审批', details: ['SECRET_TARGET'] });
  await service.dispose(); assert.equal(await pending, false);
  const saved = await readFile(path.join(dataDir, 'chat-history.json'), 'utf8');
  assert(saved.includes('你好，主人。')); assert(!saved.includes('SECRET_TARGET')); assert(!saved.includes('pending'));
  await rm(dataDir, { recursive: true, force: true });
});

test('an old turn completion cannot dismiss the current task approval', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-turn-race-'));
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: { definitions: () => [], call: async () => ({ contentItems: [], success: false }), connectBrowser: async () => {}, dispose: async () => {} }, openExternal: async () => {} });
  const internals = service as unknown as TestInternals;
  internals.state.connected = true; internals.state.threadId = 'owned-thread'; internals.state.activeTurnId = 'new-turn'; internals.acceptingTools = true;
  try {
    const pending = service.requestApproval({ title: '当前任务', description: '等待批准', details: [] });
    await internals.onMessage({ method: 'turn/completed', params: { threadId: 'owned-thread', turn: { id: 'old-turn', status: 'interrupted', error: null } } });
    assert.equal(service.getSnapshot().pending.length, 1); assert.equal(service.getSnapshot().activeTurnId, 'new-turn');
    await service.approve(service.getSnapshot().pending[0].id, 'allow'); assert.equal(await pending, true);
  } finally { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

test('restored sessions cannot execute tools until an explicit new user turn is submitted', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-restore-gate-'));
  let calls = 0;
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: { definitions: () => [{ name: 'file_write', description: '', inputSchema: {} }], call: async () => { calls++; return { contentItems: [], success: true }; }, connectBrowser: async () => {}, dispose: async () => {} }, openExternal: async () => {} });
  const internals = service as unknown as TestInternals;
  internals.state.connected = true; internals.state.threadId = 'owned-thread'; internals.state.activeTurnId = 'restored-turn';
  try {
    await internals.onRequest({ id: 8, method: 'item/tool/call', params: { threadId: 'owned-thread', turnId: 'restored-turn', callId: 'restored', namespace: null, tool: 'file_write', arguments: {} } });
    assert.equal(calls, 0); assert.equal(await service.requestApproval({ title: '上次操作', description: '', details: [] }), false);
  } finally { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

test('success animation returns to idle after three seconds and does not override a newer task', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-success-state-'));
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: { definitions: () => [], call: async () => ({ contentItems: [], success: false }), connectBrowser: async () => {}, dispose: async () => {} }, openExternal: async () => {} });
  const internals = service as unknown as TestInternals;
  internals.state.connected = true; internals.state.threadId = 'owned-thread'; internals.state.activeTurnId = 'finished-turn';
  try {
    await internals.onMessage({ method: 'turn/completed', params: { threadId: 'owned-thread', turn: { id: 'finished-turn', status: 'completed', error: null } } });
    assert.equal(service.getSnapshot().activity, 'success');
    t.mock.timers.tick(2999); assert.equal(service.getSnapshot().activity, 'success');
    t.mock.timers.tick(1); assert.equal(service.getSnapshot().activity, 'idle');
    internals.state.activeTurnId = 'second-turn';
    await internals.onMessage({ method: 'turn/completed', params: { threadId: 'owned-thread', turn: { id: 'second-turn', status: 'completed', error: null } } });
    await internals.onMessage({ method: 'turn/started', params: { threadId: 'owned-thread', turn: { id: 'third-turn' } } });
    t.mock.timers.tick(3000); assert.equal(service.getSnapshot().activity, 'thinking');
  } finally { await service.dispose(); t.mock.timers.reset(); await rm(dataDir, { recursive: true, force: true }); }
});

test('an unsigned account cannot submit an inference turn or add an unsent user message', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-login-guard-'));
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: { definitions: () => [], call: async () => ({ contentItems: [], success: false }), connectBrowser: async () => {}, dispose: async () => {} }, openExternal: async () => {} });
  const internals = service as unknown as TestInternals;
  const input = new PassThrough(); const output = new PassThrough(); let writes = 0; output.on('data', () => { writes++; });
  internals.rpc = new JsonLineRpc(input, output); internals.state.connected = true; internals.state.account = '未登录';
  try {
    await assert.rejects(service.send('你好'), /请先点击登录/);
    assert.equal(writes, 0); assert.equal(service.getSnapshot().messages.length, 0);
  } finally { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as string | null, kill: (): boolean => true });
  child.kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    queueMicrotask(() => { child.signalCode = 'SIGTERM'; child.stdout.end(); child.stderr.end(); child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); }); return true;
  };
  return child;
}
function fakeRuntime(initiallyLoggedIn = true) {
  let loggedIn = initiallyLoggedIn, fail = false, cancelFailure = false, loginSequence = 0, latest: ReturnType<typeof fakeChild> | undefined, alive = 0, maximum = 0;
  const methods: string[] = [], argumentsList: string[][] = [];
  const runtime: BackendRuntime = {
    resolveCodex: async () => 'codex.exe',
    spawnAppServer: (_exe, args) => {
      argumentsList.push(args); const child = fakeChild(); latest = child;
      alive++; maximum = Math.max(maximum, alive); child.once('exit', () => alive--);
      const attached = attachAppServer(child as unknown as ChildProcessWithoutNullStreams);
      if (fail) {
        queueMicrotask(() => {
          child.stderr.write('Error: invalid transport\napi_key=sk-abc123456789 secret="very secret value"\n');
          child.exitCode = 1; child.stdout.end(); child.stderr.end(); child.emit('exit', 1, null); child.emit('close', 1, null);
        });
        return attached;
      }
      const response = (id: unknown, result: unknown) => queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id, result })}\n`));
      child.stdin.on('data', chunk => {
        for (const line of chunk.toString().trim().split('\n')) {
          const request = JSON.parse(line); if (!request.method) continue;
          methods.push(request.method);
          if (request.method === 'initialize') response(request.id, {});
          if (request.method === 'config/read') response(request.id, { config: { features: { ...Object.fromEntries(DISABLED_FEATURES.map(name => [name, false])), code_mode_host: true }, mcp_servers: { 'a.server with "quotes"': { command: 'unchanged', enabled: !args.some(arg => arg.startsWith('mcp_servers={')) } } } });
          if (request.method === 'account/read') response(request.id, { account: loggedIn ? { type: 'chatgpt', email: 'test@example.com' } : null });
          if (request.method === 'model/list') response(request.id, { data: [{ model: 'test-model', displayName: 'Test model', isDefault: true, hidden: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Default effort' }, { reasoningEffort: 'high', description: 'More reasoning' }] }], nextCursor: null });
          if (request.method === 'account/login/start') response(request.id, { type: 'chatgpt', loginId: `login-${++loginSequence}`, authUrl: 'https://auth.openai.com/test' });
          if (request.method === 'account/login/cancel') {
            if (cancelFailure) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -1, message: 'cancel temporarily failed' } })}\n`));
            else response(request.id, { status: 'canceled' });
          }
        }
      });
      return attached;
    },
  };
  return { runtime, methods, argumentsList, setFail: (value: boolean) => { fail = value; }, setCancelFailure: (value: boolean) => { cancelFailure = value; }, maximum: () => maximum,
    cancelNotification: (id = `login-${loginSequence}`) => latest!.stdout.write(`${JSON.stringify({ method: 'account/login/completed', params: { loginId: id, success: false, error: 'login canceled', onboardingEntrypoint: null } })}\n`),
    completeLogin: () => { loggedIn = true; latest!.stdout.write(`${JSON.stringify({ method: 'account/login/completed', params: { loginId: `login-${loginSequence}`, success: true, error: null, onboardingEntrypoint: null } })}\n`); } };
}
const emptyHost = { definitions: () => [], call: async () => ({ contentItems: [], success: false }), connectBrowser: async () => {}, dispose: async () => {} };

test('connection, repeated reconnects and existing-login checks share one live backend process', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-lifecycle-test-')); const fixture = fakeRuntime(); let browserOpens = 0;
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: emptyHost, openExternal: async () => { browserOpens++; } }, fixture.runtime);
  try {
    await Promise.all([service.initialize(), service.initialize()]);
    await Promise.all([service.reconnect(), service.reconnect(), service.login(), service.initialize()]);
    assert.equal(fixture.maximum(), 1); assert.equal(browserOpens, 0); assert(!fixture.methods.includes('account/login/start'));
    assert.equal(fixture.argumentsList.length, 4, 'one discovery/restart pair per coalesced connection');
    assert.equal(service.getSnapshot().connection, 'ready'); assert.equal(service.getSnapshot().login, 'signed-in');
  } finally { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

test('unsigned login launches one browser flow, waits, and refreshes after completion', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-login-flow-')); const fixture = fakeRuntime(false); let browserOpens = 0;
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: emptyHost, openExternal: async () => { browserOpens++; } }, fixture.runtime);
  try {
    await service.initialize(); assert.equal(service.getSnapshot().login, 'signed-out');
    await Promise.all([service.login(), service.login()]); await service.login();
    assert.equal(browserOpens, 1); assert.equal(fixture.methods.filter(method => method === 'account/login/start').length, 1);
    assert.equal(service.getSnapshot().login, 'waiting-browser');
    fixture.completeLogin(); await service.initialize();
    assert.equal(service.getSnapshot().login, 'signed-in');
  } finally { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

test('canceling login provides feedback, allows a new flow, and ignores old canceled callbacks', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-cancel-login-')); const fixture = fakeRuntime(false);
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: emptyHost, openExternal: async () => {} }, fixture.runtime);
  try {
    await service.login(); await service.cancelLogin();
    assert.equal(service.getSnapshot().login, 'signed-out'); assert.equal(service.getSnapshot().error, null); assert.match(service.getSnapshot().diagnostic!.message, /已取消登录/);
    await service.cancelLogin(); assert.equal(fixture.methods.filter(method => method === 'account/login/cancel').length, 1);
    await service.login(); fixture.cancelNotification('login-1');
    assert.equal(service.getSnapshot().login, 'waiting-browser');
    fixture.completeLogin(); await service.initialize(); assert.equal(service.getSnapshot().login, 'signed-in');
    await service.cancelLogin(); assert.equal(service.getSnapshot().login, 'signed-in'); assert(!fixture.methods.includes('account/logout'));
  } finally { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

test('a failed cancellation can be retried without discarding the pending auth flow', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-cancel-retry-')); const fixture = fakeRuntime(false);
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: emptyHost, openExternal: async () => {} }, fixture.runtime);
  try {
    await service.login(); fixture.setCancelFailure(true);
    await assert.rejects(service.cancelLogin(), /取消登录未完成/); assert.equal(service.getSnapshot().connection, 'ready');
    fixture.setCancelFailure(false); await service.cancelLogin(); assert.equal(service.getSnapshot().login, 'signed-out');
  } finally { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

test('server cancellation clears browser waiting and reports cancellation without an execution error', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-native-cancel-')); const fixture = fakeRuntime(false);
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: emptyHost, openExternal: async () => {} }, fixture.runtime);
  try {
    await service.login(); fixture.cancelNotification();
    assert.equal(service.getSnapshot().login, 'signed-out'); assert.equal(service.getSnapshot().error, null); assert.match(service.getSnapshot().diagnostic!.message, /已取消登录/);
    await service.login(); assert.equal(service.getSnapshot().login, 'waiting-browser');
  } finally { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

test('an auth browser launch failure cancels its abandoned flow and permits retry', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-auth-browser-retry-')); const fixture = fakeRuntime(false); let failBrowser = true;
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: emptyHost, openExternal: async () => { if (failBrowser) throw new Error('cannot open browser'); } }, fixture.runtime);
  try {
    await assert.rejects(service.login(), /cannot open browser/); assert.equal(service.getSnapshot().login, 'error');
    assert.equal(fixture.methods.filter(method => method === 'account/login/cancel').length, 1);
    fixture.cancelNotification('login-1'); assert.equal(service.getSnapshot().login, 'error');
    failBrowser = false; await service.login(); assert.equal(service.getSnapshot().login, 'waiting-browser');
  } finally { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

test('startup diagnostics retain exit reason, redact credentials and permit a clean retry', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-exit-recovery-')); const fixture = fakeRuntime(); fixture.setFail(true);
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: emptyHost, openExternal: async () => {} }, fixture.runtime);
  try {
    await assert.rejects(service.initialize(), /invalid transport/);
    const failed = service.getSnapshot(); assert.equal(failed.diagnostic?.exitCode, 1); assert.equal(failed.connection, 'error');
    assert(!failed.error?.includes('sk-abc')); assert(!failed.error?.includes('very secret value'));
    fixture.setFail(false); await service.reconnect();
    assert.equal(service.getSnapshot().connection, 'ready'); assert.equal(service.getSnapshot().diagnostic, null); assert.equal(fixture.maximum(), 1);
  } finally { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

test('EOF waits for process close so stderr and exit code are not replaced by a generic connection error', async () => {
  const child = fakeChild(); const { rpc } = attachAppServer(child as unknown as ChildProcessWithoutNullStreams);
  const pending = rpc.request('initialize', {}); const rejection = assert.rejects(pending, /invalid transport/);
  child.stdout.end(); child.stderr.write('Error: invalid transport\nin `mcp_servers.example`\n');
  child.exitCode = 1; child.emit('exit', 1, null); child.emit('close', 1, null);
  await rejection;
  assert.equal(sanitizeDiagnostic('Bearer abcdef\npassword="foo bar"\nhttps://a:b@example.test/?code=123'), '[认证信息已隐藏]\npassword=[已隐藏]\nhttps://[已隐藏]@example.test/?code=[已隐藏]');
});

test('RPC timeout shuts down the stale connection and rejects every outstanding request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rpc = new JsonLineRpc(new PassThrough(), new PassThrough());
  const first = assert.rejects(rpc.request('initialize', {}, 1000), /initialize.*1 秒/);
  const second = assert.rejects(rpc.request('account/read', {}, 5000), /initialize.*1 秒/);
  t.mock.timers.tick(1000); await Promise.all([first, second]);
  await assert.rejects(rpc.request('config/read', {}), /尚未连接/); t.mock.timers.reset();
});

test('a retryable turn error preserves the running task and pending approval', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-turn-retry-'));
  const service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: emptyHost, openExternal: async () => {} });
  const internals = service as unknown as TestInternals;
  internals.state.connected = true; internals.state.threadId = 'owned-thread'; internals.state.activeTurnId = 'running-turn'; internals.acceptingTools = true;
  try {
    const pending = service.requestApproval({ title: '保留当前审批', description: '', details: [] });
    await internals.onMessage({ method: 'error', params: { threadId: 'owned-thread', turnId: 'running-turn', willRetry: true, error: { message: 'Reconnecting... 2/5' } } });
    assert.equal(service.getSnapshot().activeTurnId, 'running-turn'); assert.equal(service.getSnapshot().error, null); assert.equal(service.getSnapshot().pending.length, 1);
    await service.stop(); assert.equal(await pending, false);
  } finally { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

test('native 0.160.1 parses literal MCP names and preserves disabled server transports', { skip: process.env.DRAGON_PET_NATIVE_TEST !== '1' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dragon-native-mcp-'));
  const names = ['node_repl', 'a.server with "quotes"', 'name\u007fDEL'];
  const config = names.map(name => `[mcp_servers.${tomlKey(name)}]\ncommand="unused-disabled-server"\nenabled=true\n`).join('\n');
  await writeFile(path.join(directory, 'config.toml'), config, 'utf8');
  const child = spawn(await resolveCodex(), ['app-server', ...isolatedConfigArgs(names)], { cwd: directory, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: directory } });
  const { rpc } = attachAppServer(child);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'dragon-native-regression', version: '0.3.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }); rpc.notify('initialized');
    const response = await rpc.request<{ config: { mcp_servers: Record<string, { enabled: boolean; command: string }> } }>('config/read', { includeLayers: false, cwd: directory });
    assert.deepEqual(Object.keys(response.config.mcp_servers).sort(), [...names].sort());
    for (const name of names) { assert.equal(response.config.mcp_servers[name].enabled, false); assert.equal(response.config.mcp_servers[name].command, 'unused-disabled-server'); }
    assert.equal(await readFile(path.join(directory, 'config.toml'), 'utf8'), config);
  } finally {
    rpc.close();
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(); });
    await rm(directory, { recursive: true, force: true });
  }
});
