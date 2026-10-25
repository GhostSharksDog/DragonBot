import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AssistantSnapshot, Settings } from '../src/shared/types';
import { AssistantService, DISABLED_FEATURES, type BackendRuntime } from '../src/main/agent/service';
import { attachAppServer, JsonLineRpc, RpcResponseError } from '../src/main/agent/transport';
import { normalizeQuota } from '../src/main/agent/quota';

const settings = (): Settings => ({ scale: 1, roaming: true, alwaysOnTop: true, model: '', reasoningByModel: {}, codexPath: '', chromeExecutablePath: '', chromeUserDataDir: '', chromeProfileDirectory: '', grant: { folders: [], origins: [] }, skinPath: null });
const model = (id: string, defaultEffort: string, efforts: string[]) => ({ model: id, displayName: id, hidden: false, isDefault: id === 'model-a', defaultReasoningEffort: defaultEffort, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: `Description ${reasoningEffort}` })) });
const models = [model('model-a', 'low', ['low', 'high', 'future-effort']), model('model-b', 'medium', ['medium'])];
const bucket = (usedPercent: number) => ({ limitId: 'codex', limitName: null, primary: { usedPercent, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: null, credits: null, planType: 'plus' });
const quota = (usedPercent: number, accountId = 'account-a') => ({ ordinaryUsageAllowed: true, accountId, rateLimits: bucket(usedPercent), rateLimitsByLimitId: { codex: bucket(usedPercent) }, rateLimitResetCredits: null, rateLimitUpsell: { secret: 'never forward this' } });
type Request = { id: number; method: string; params: Record<string, unknown>; session: ReturnType<typeof fakeChild> };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as string | null, kill: (): boolean => true });
  child.kill = () => { if (child.signalCode || child.exitCode !== null) return false; queueMicrotask(() => { child.signalCode = 'SIGTERM'; child.stdout.end(); child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); }); return true; }; return child;
}
async function fixture(accountType: 'chatgpt' | 'apiKey' | null = 'chatgpt') {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dragon-quota-')), value = settings(), requests: Request[] = []; let latest: ReturnType<typeof fakeChild>, account = accountType, accountId = 'account-a', turn = 0;
  const reply = (request: Request, result: unknown) => request.session.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  const runtime: BackendRuntime = { resolveCodex: async () => 'fake-codex.exe', spawnAppServer: () => {
    const child = fakeChild(); latest = child; const attached = attachAppServer(child as unknown as ChildProcessWithoutNullStreams);
    child.stdin.on('data', chunk => { for (const line of chunk.toString().trim().split('\n')) {
      const message = JSON.parse(line); if (!message.method) continue; const request: Request = { ...message, session: child }; requests.push(request);
      const response = (result: unknown) => queueMicrotask(() => reply(request, result));
      if (request.method === 'initialize') response({});
      if (request.method === 'config/read') response({ config: { features: { ...Object.fromEntries(DISABLED_FEATURES.map(name => [name, false])), code_mode_host: true }, mcp_servers: {} } });
      if (request.method === 'account/read') response({ account: account ? { type: account, email: 'test@example.test' } : null, workspaceRouting: account ? { chatgptAccountId: accountId } : null });
      if (request.method === 'model/list') response({ data: models, nextCursor: null });
      if (request.method === 'thread/start') response({ thread: { id: 'owned-thread' } });
      if (request.method === 'thread/resume') response({ thread: { id: 'owned-thread', status: { type: 'idle' } } });
      if (request.method === 'turn/start') response({ turn: { id: `turn-${++turn}` } });
      if (request.method === 'turn/interrupt' || request.method === 'turn/steer') response({});
    } }); return attached;
  } };
  const service = new AssistantService({ dataDir, getSettings: () => value, toolHost: { definitions: () => [], call: async () => ({ success: false, contentItems: [] }), connectBrowser: async () => {}, dispose: async () => {} }, openExternal: async () => { throw new Error('No login/browser should open.'); } }, runtime);
  return { service, settings: value, requests, quotaRequests: () => requests.filter(request => request.method === 'account/rateLimits/read'), reply, reject: (request: Request, code: number, message: string) => request.session.stdout.write(`${JSON.stringify({ id: request.id, error: { code, message } })}\n`), notify: (method: string, params: unknown) => latest.stdout.write(`${JSON.stringify({ method, params })}\n`), switchAccount: (id: string, type = account) => { accountId = id; account = type; }, close: async () => { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('quota normalizes multi-bucket windows without forwarding identity or upsell data', () => {
  const response = quota(0); response.rateLimitsByLimitId = { other: { ...bucket(100), limitId: 'other', credits: { hasCredits: false, unlimited: false, balance: '0' } }, codex: bucket(0) } as typeof response.rateLimitsByLimitId;
  const result = normalizeQuota(response); assert.deepEqual(result.map(value => value.id), ['codex', 'other']); assert.equal(result[0].primary!.usedPercent, 0); assert.equal(result[1].primary!.usedPercent, 100); assert.equal(result[1].credits!.balance, '0'); assert(!JSON.stringify(result).includes('account-a')); assert(!JSON.stringify(result).includes('never forward'));
  assert.deepEqual(normalizeQuota({ rateLimits: { limitId: null, primary: { usedPercent: Infinity }, secondary: null, credits: null } })[0], { id: 'codex', name: null, primary: null, secondary: null, credits: null, planType: null });
  assert.equal(normalizeQuota({ rateLimits: { ...bucket(120), primary: { usedPercent: 120, windowDurationMins: null, resetsAt: null } } })[0].primary!.usedPercent, 100);
});

test('model metadata and per-model effort are retained and explicitly sent for every new turn', async () => {
  const f = await fixture();
  try {
    await f.service.initialize(); assert.deepEqual(f.service.getSnapshot().models[0].supportedReasoningEfforts, models[0].supportedReasoningEfforts);
    f.settings.reasoningByModel = { 'model-a': 'high', 'model-b': 'medium' }; await f.service.send('first'); await f.service.stop();
    f.settings.reasoningByModel = {}; await f.service.send('use model default'); await f.service.stop();
    f.settings.model = 'model-b'; await f.service.send('other model'); await f.service.stop();
    f.settings.model = 'model-a'; f.settings.reasoningByModel = { 'model-a': 'future-effort' }; await f.service.send('future supported string');
    const turns = f.requests.filter(request => request.method === 'turn/start'); assert.deepEqual(turns.map(request => request.params.effort), ['high', 'low', 'medium', 'future-effort']); assert.deepEqual(turns.map(request => request.params.model), ['model-a', 'model-a', 'model-b', 'model-a']);
    await f.service.send('steering'); assert(!('effort' in [...f.requests].reverse().find(request => request.method === 'turn/steer')!.params));
  } finally { await f.close(); }
});

test('an unsupported effort is rejected before creating a thread or appending a user message', async () => {
  const f = await fixture();
  try { await f.service.initialize(); f.settings.reasoningByModel = { 'model-a': 'invalid' }; await assert.rejects(f.service.send('must not submit'), /不受当前模型支持/); assert.equal(f.service.getSnapshot().messages.length, 0); assert(!f.requests.some(request => ['thread/start', 'turn/start'].includes(request.method))); }
  finally { await f.close(); }
});
test('missing catalog default reports a local error without creating a thread', async () => {
  const f = await fixture();
  try { await f.service.initialize(); const internals = f.service as unknown as { state: AssistantSnapshot }; delete internals.state.models[0].defaultReasoningEffort; await assert.rejects(f.service.send('no implicit sticky effort'), /未返回默认推理强度/); assert.equal(f.service.getSnapshot().messages.length, 0); assert(!f.requests.some(request => ['thread/start', 'turn/start'].includes(request.method))); }
  finally { await f.close(); }
});

test('reject-only quota timeout leaves concurrent core requests and late-response correlation intact', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const input = new PassThrough(), output = new PassThrough(), rpc = new JsonLineRpc(input, output); const messages: { id: number; method: string }[] = []; output.on('data', chunk => messages.push(JSON.parse(chunk.toString()))); let closes = 0; rpc.on('close', () => closes++);
  try {
    const turn = rpc.request('turn/start', {}, 45000), usage = assert.rejects(rpc.request('account/rateLimits/read', {}, 10000, { timeoutMode: 'reject' }), /超时/); assert.equal(rpc.phase, 'turn/start', 'Optional quota read cannot replace the primary diagnostic phase.');
    t.mock.timers.tick(10000); await usage; assert.equal(closes, 0); input.write(`${JSON.stringify({ id: messages[1].id, result: quota(99) })}\n`); input.write(`${JSON.stringify({ id: messages[0].id, result: 'running' })}\n`); assert.equal(await turn, 'running');
    const another = rpc.request('account/read', {}); input.write(`${JSON.stringify({ id: messages[2].id, result: 'still connected' })}\n`); assert.equal(await another, 'still connected');
  } finally { rpc.close(); t.mock.timers.reset(); }
});

test('quota requests are singleflight, never initialize/login/infer, and do not alter task state', async () => {
  const f = await fixture();
  try {
    f.service.setQuotaVisible(true); await f.service.refreshQuota(); assert.equal(f.requests.length, 0); assert.equal(f.service.getSnapshot().quota!.status, 'error');
    await f.service.initialize(); assert.equal(f.quotaRequests().length, 0, 'Visibility does not perform an initial read.');
    await f.service.send('a running task'); const before = f.service.getSnapshot(); const one = f.service.refreshQuota(), two = f.service.refreshQuota(); assert.equal(one, two); assert.equal(f.quotaRequests().length, 1); assert.deepEqual(f.quotaRequests()[0].params, { excludeResetCreditDetails: true });
    f.reply(f.quotaRequests()[0], quota(25)); await Promise.all([one, two]); const after = f.service.getSnapshot(); assert.equal(after.quota!.buckets[0].primary!.usedPercent, 25); assert.equal(after.activeTurnId, before.activeTurnId); assert.equal(after.activity, before.activity); assert.deepEqual(after.messages, before.messages); assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 1); assert(!f.requests.some(request => request.method === 'account/login/start'));
  } finally { await f.close(); }
});

test('usage timeout preserves cached data, pending approval and active turn without service.fail', async t => {
  const f = await fixture();
  try {
    await f.service.initialize(); let reading = f.service.refreshQuota(); f.reply(f.quotaRequests()[0], quota(30)); await reading;
    const internals = f.service as unknown as { state: AssistantSnapshot; acceptingTools: boolean }; internals.state.threadId = 'owned-thread'; internals.state.activeTurnId = 'real-turn'; internals.acceptingTools = true; const approval = f.service.requestApproval({ title: 'do not disturb', description: '', details: [] });
    t.mock.timers.enable({ apis: ['setTimeout'] }); reading = f.service.refreshQuota(); t.mock.timers.tick(10000); await reading;
    const snapshot = f.service.getSnapshot(); assert.equal(snapshot.quota!.status, 'error'); assert.equal(snapshot.quota!.buckets[0].primary!.usedPercent, 30); assert(snapshot.quota!.stale); assert.equal(snapshot.activeTurnId, 'real-turn'); assert.equal(snapshot.activity, 'awaiting-approval'); assert.equal(snapshot.pending.length, 1); assert.equal(snapshot.error, null); assert.equal(snapshot.connection, 'ready');
    await f.service.stop(); assert.equal(await approval, false);
  } finally { t.mock.timers.reset(); await f.close(); }
});

test('same-auth-mode account switch clears data and ignores a late old-account response', async () => {
  const f = await fixture();
  try {
    await f.service.initialize(); const old = f.service.refreshQuota(), oldRequest = f.quotaRequests()[0]; f.switchAccount('account-b'); f.notify('account/updated', { authMode: 'chatgpt', planType: 'plus' }); assert.equal(f.service.getSnapshot().quota!.buckets.length, 0); await f.service.initialize();
    const current = f.service.refreshQuota(), currentRequest = f.quotaRequests()[1]; f.reply(oldRequest, quota(99, 'account-a')); await old; assert.equal(f.service.getSnapshot().quota!.status, 'loading');
    assert.equal(f.service.refreshQuota(), current, 'Old finally cannot clear the new singleflight request.'); f.reply(currentRequest, quota(10, 'account-b')); await current; assert.equal(f.service.getSnapshot().quota!.buckets[0].primary!.usedPercent, 10); assert(!JSON.stringify(f.service.getSnapshot().quota).includes('account-b'));
  } finally { await f.close(); }
});

test('visible sparse notifications coalesce and auto-read at most once per second; hidden view only dirties', async t => {
  const f = await fixture();
  try {
    await f.service.initialize(); t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); f.service.setQuotaVisible(true); const first = f.service.refreshQuota();
    for (let index = 0; index < 40; index++) f.notify('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: index }, planType: null } });
    f.reply(f.quotaRequests()[0], quota(5)); await first; assert.equal(f.service.getSnapshot().quota!.buckets[0].primary!.usedPercent, 5, 'Sparse data is not guessed/merged.'); assert(f.service.getSnapshot().quota!.stale);
    t.mock.timers.tick(999); await tick(); assert.equal(f.quotaRequests().length, 1); t.mock.timers.tick(1); await tick(); assert.equal(f.quotaRequests().length, 2);
    f.reply(f.quotaRequests()[1], quota(20)); await tick(); assert.equal(f.service.getSnapshot().quota!.stale, false);
    f.service.setQuotaVisible(false); f.notify('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: null } }); t.mock.timers.tick(2000); await tick(); assert.equal(f.quotaRequests().length, 2); assert(f.service.getSnapshot().quota!.stale); assert.equal(f.service.getSnapshot().quota!.buckets[0].primary!.usedPercent, 20);
  } finally { t.mock.timers.reset(); await f.close(); }
});

test('manual refresh bypasses notification throttling and unsupported query errors stay local', async () => {
  const f = await fixture();
  try {
    await f.service.initialize(); const first = f.service.refreshQuota(); f.reply(f.quotaRequests()[0], quota(50)); await first;
    const second = f.service.refreshQuota(); assert.equal(f.quotaRequests().length, 2); f.reject(f.quotaRequests()[1], -32601, 'method unavailable'); await second;
    const snapshot = f.service.getSnapshot(); assert.match(snapshot.quota!.error!, /暂不提供额度查询/); assert.equal(snapshot.quota!.buckets[0].primary!.usedPercent, 50); assert.equal(snapshot.error, null); assert.equal(snapshot.activity, 'idle'); assert.equal(snapshot.connection, 'ready');
  } finally { await f.close(); }
});
test('reconnect invalidates an old quota query without overwriting the replacement connection', async () => {
  const f = await fixture();
  try {
    await f.service.initialize(); const old = f.service.refreshQuota(); await f.service.reconnect(); await old; assert.equal(f.service.getSnapshot().quota!.buckets.length, 0); assert.equal(f.service.getSnapshot().connection, 'ready');
    const replacement = f.service.refreshQuota(); f.reply(f.quotaRequests()[1], quota(15)); await replacement; assert.equal(f.service.getSnapshot().quota!.buckets[0].primary!.usedPercent, 15); assert.equal(f.service.getSnapshot().error, null);
  } finally { await f.close(); }
});

test('logout notification immediately removes cached account data and cannot reopen login', async () => {
  const f = await fixture();
  try {
    await f.service.initialize(); const first = f.service.refreshQuota(); f.reply(f.quotaRequests()[0], quota(77)); await first;
    f.switchAccount('signed-out', null); f.notify('account/updated', { authMode: null, planType: null }); assert.equal(f.service.getSnapshot().quota!.buckets.length, 0); await f.service.initialize(); await f.service.refreshQuota(); assert.equal(f.service.getSnapshot().quota!.buckets.length, 0); assert.equal(f.quotaRequests().length, 1); assert(!f.requests.some(request => request.method === 'account/login/start'));
  } finally { await f.close(); }
});

test('API-key and unsigned quota views never start login or make a quota request', async () => {
  for (const type of ['apiKey', null] as const) {
    const f = await fixture(type); try { await f.service.initialize(); await f.service.refreshQuota(); assert.equal(f.quotaRequests().length, 0); assert.equal(f.service.getSnapshot().quota!.status, 'error'); assert(!f.requests.some(request => request.method === 'account/login/start')); }
    finally { await f.close(); }
  }
});

test('structured RPC errors retain their safe code without forwarding secret data', async () => {
  const input = new PassThrough(), rpc = new JsonLineRpc(input, new PassThrough()); const pending = rpc.request('account/rateLimits/read', {}); input.write(`${JSON.stringify({ id: 1, error: { code: -32601, message: 'not supported api_key=sk-abc123456789', data: { token: 'not forwarded' } } })}\n`);
  await assert.rejects(pending, error => error instanceof RpcResponseError && error.code === -32601 && !error.message.includes('sk-abc') && !('data' in error)); rpc.close();
});
