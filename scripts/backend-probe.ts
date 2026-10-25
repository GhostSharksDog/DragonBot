/** No inference, login launch, browser or global-config writes. Run with the real user's CODEX_HOME. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AssistantService, type BackendRuntime } from '../src/main/agent/service';
import { resolveCodex, spawnAppServer } from '../src/main/agent/transport';
import type { Settings } from '../src/shared/types';

async function main() {
  const homeIndex = process.argv.indexOf('--codex-home');
  if (homeIndex !== -1) {
    const home = process.argv[homeIndex + 1];
    if (!home || !path.isAbsolute(home)) throw new Error('--codex-home requires an absolute existing directory.');
    process.env.CODEX_HOME = home;
  }
  if (!process.env.CODEX_HOME) throw new Error('Set CODEX_HOME explicitly so a sandbox profile cannot give a misleading result.');
  const configPath = path.join(process.env.CODEX_HOME, 'config.toml');
  const digest = async () => createHash('sha256').update(await readFile(configPath)).digest('hex');
  const before = await digest();
  const withTurn = process.argv.includes('--turn');
  const modelIndex = process.argv.indexOf('--model');
  const timeoutIndex = process.argv.indexOf('--timeout-ms');
  const turnTimeout = timeoutIndex === -1 ? 180_000 : Number(process.argv[timeoutIndex + 1]);
  if (!Number.isFinite(turnTimeout) || turnTimeout < 1000 || turnTimeout > 300_000) throw new Error('Turn timeout must be between 1000 and 300000 ms.');
  const dataDir = await mkdtemp(path.resolve('.local/backend-probe-'));
  const settings: Settings = { scale: 1, roaming: false, alwaysOnTop: false, model: '', codexPath: '', chromeExecutablePath: '', chromeUserDataDir: '', chromeProfileDirectory: '', grant: { folders: [], origins: [] }, skinPath: null };
  if (modelIndex !== -1) settings.model = process.argv[modelIndex + 1] ?? '';
  let latest: ReturnType<typeof spawnAppServer>['child'] | undefined, alive = 0, maximum = 0, starts = 0;
  const methods: string[] = [];
  const runtime: BackendRuntime = {
    resolveCodex,
    spawnAppServer: (...args) => {
      const backend = spawnAppServer(...args); latest = backend.child; starts++; alive++; maximum = Math.max(maximum, alive);
      backend.child.once('exit', () => alive--);
      const request = backend.rpc.request.bind(backend.rpc);
      backend.rpc.request = ((method, params, timeout) => {
        methods.push(method);
        if ((!withTurn && /^turn\//.test(method)) || /^account\/login\//.test(method)) throw new Error(`Probe blocked side-effectful RPC ${method}`);
        return request(method, params, timeout);
      }) as typeof backend.rpc.request;
      return backend;
    },
  };
  let service: AssistantService;
  service = new AssistantService({ dataDir, getSettings: () => settings, toolHost: {
    definitions: () => withTurn ? [{ name: 'pet_probe_approval', description: '仅用于本轮验收：在桌宠里请求一次批准并返回结果。完全不读写文件、不访问网站、不执行命令。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] : [],
    call: async name => {
      assert.equal(name, 'pet_probe_approval');
      const allowed = await service.requestApproval({ title: '桌宠验收批准', description: '仅返回内存测试结果，不产生文件、网站或系统操作。', details: ['测试用途：验证真实模型调用与桌宠批准回调'] });
      return { success: true, contentItems: [{ type: 'inputText', text: allowed ? '已收到用户批准，验收成功。' : '用户拒绝；没有执行任何操作。' }] };
    }, connectBrowser: async () => {}, dispose: async () => {},
  }, openExternal: async () => { throw new Error('Probe must not open an auth browser.'); } }, runtime);
  try {
    await Promise.all([service.initialize(), service.initialize()]);
    const initial = service.getSnapshot(); assert.equal(initial.connection, 'ready');
    if (process.argv.includes('--expect-signed-in')) assert.equal(initial.login, 'signed-in');
    // For a signed-in user, login() must reuse existing credentials without starting an OAuth flow.
    if (initial.login === 'signed-in') await service.login();
    for (let cycle = 0; cycle < 3; cycle++) await Promise.all([service.reconnect(), service.reconnect(), service.initialize()]);
    const beforeCrash = service.getSnapshot(); assert.equal(beforeCrash.connection, 'ready');
    const crashed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { service.off('change', changed); reject(new Error('Backend exit was not reported.')); }, 5000);
      const changed = () => { if (!service.getSnapshot().connected) { clearTimeout(timer); service.off('change', changed); resolve(); } };
      service.on('change', changed);
    });
    latest!.kill(); await crashed;
    assert(service.getSnapshot().diagnostic?.message.includes('退出'));
    await service.reconnect();
    const recovered = service.getSnapshot(); assert.equal(recovered.connection, 'ready'); assert.equal(recovered.login, initial.login); assert.equal(maximum, 1);
    let questions = 0, approvals = 0, streamed = false;
    if (withTurn) {
      const handled = new Set<string>(); let sawActiveTurn = false;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const state = service.getSnapshot(); service.off('change', changed);
          reject(new Error(`Live turn timed out: ${JSON.stringify({ questions, approvals, streamed, activity: state.activity, diagnostic: state.diagnostic })}`));
        }, turnTimeout);
        const finish = (error?: Error) => { clearTimeout(timer); service.off('change', changed); error ? reject(error) : resolve(); };
        const changed = () => {
          const state = service.getSnapshot();
          if (state.error) { finish(new Error(state.error)); return; }
          if (state.activeTurnId) sawActiveTurn = true;
          if (state.messages.some(message => message.role === 'assistant' && message.text.length > 0)) streamed = true;
          for (const interaction of state.pending) {
            if (handled.has(interaction.id)) continue; handled.add(interaction.id);
            if (interaction.kind === 'question') {
              questions++; process.stderr.write('Probe: answering native question.\n'); void service.answer({ id: interaction.id, answers: Object.fromEntries(interaction.questions.map(question => [question.id, [question.options?.[0]?.label ?? '测试答案']])) }).catch(finish);
            } else { approvals++; process.stderr.write('Probe: allowing controlled in-memory tool.\n'); void service.approve(interaction.id, 'allow').catch(finish); }
          }
          if (sawActiveTurn && !state.activeTurnId && state.activity === 'success') finish();
        };
        service.on('change', changed);
        void service.send('这是一轮桌宠集成验收。请严格按顺序：1. 用 request_user_input 工具问我一个问题“选择验收答案”，提供“测试答案”和“跳过”两个选项；2. 收到答案后，调用 pet_probe_approval 一次，它仅在内存里模拟批准，不会读写文件、访问网页或执行命令；3. 获得工具结果后回复“桌宠验收通过”。不要跳过提问和工具调用，不使用其他工具。').catch(finish);
      });
      assert(questions > 0, 'Actual model did not request user input.'); assert(approvals > 0, 'Actual model did not request controlled approval.'); assert(streamed, 'No assistant text was streamed.');
    }
    const unchanged = before === await digest(); assert(unchanged, 'Global config changed concurrently; inspect before claiming a clean run.');
    console.log(JSON.stringify({ ok: true, codexHome: process.env.CODEX_HOME, loggedIn: recovered.login === 'signed-in', modelCount: recovered.models.length, reconnectCycles: 3, crashRecovery: true, maxConcurrentBackends: maximum, nativeProcessStarts: starts, authFlowsStarted: methods.filter(method => method === 'account/login/start').length, inferenceTurns: methods.filter(method => method === 'turn/start').length, questions, approvals, streamed, globalConfigUnchanged: unchanged, dataDir }));
  } finally { await service.dispose(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
