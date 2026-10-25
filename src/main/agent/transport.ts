import { EventEmitter } from 'node:events';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Readable, Writable } from 'node:stream';

export const CODEX_VERSION = '0.160.1';
export type RpcId = number | string;
export interface RpcMessage { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }
const execFileAsync = promisify(execFile);

export function sanitizeDiagnostic(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, '[认证信息已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[密钥已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[令牌已隐藏]')
    .replace(/(["']?[\w.-]*(?:token|secret|password|credential|api[_-]?key|authorization)[\w.-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&]+)/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(/([?&](?:code|key|token|access_token|refresh_token|api_key|signature)=)[^\s&#]+/gi, '$1[已隐藏]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(-1600);
}
export class BackendError extends Error {
  constructor(message: string, readonly phase: string, readonly exitCode?: number | null, readonly signal?: string | null) { super(sanitizeDiagnostic(message)); this.name = 'BackendError'; }
}
export class RpcResponseError extends Error {
  constructor(readonly code: number, message: string) { super(sanitizeDiagnostic(message)); this.name = 'RpcResponseError'; }
}
export interface RpcRequestOptions { timeoutMode?: 'close' | 'reject' }

/** Find the native binary. Running npm's .cmd launcher through a shell is deliberately avoided. */
export async function resolveCodex(override = ''): Promise<string> {
  const candidates: string[] = [];
  const addNpm = (root: string) => {
    for (const arch of ['x64', 'arm64']) candidates.push(path.join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc', 'bin', 'codex.exe'));
  };
  if (override.trim()) {
    const resolved = path.resolve(override.trim());
    if (!path.isAbsolute(override.trim()) || !/\.exe$/i.test(resolved)) throw new Error('Codex 路径需要是原生 codex.exe 的完整路径。');
    candidates.push(resolved);
  } else {
    addNpm(process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : path.join(os.homedir(), 'AppData', 'Roaming', 'npm'));
    for (const entry of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(entry, process.platform === 'win32' ? 'codex.exe' : 'codex'));
      addNpm(entry);
    }
    if (process.env.LOCALAPPDATA) {
      const root = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
      for (const entry of await readdir(root).catch(() => [] as string[])) candidates.push(path.join(root, entry, 'codex.exe'));
    }
  }
  const seenVersions = new Set<string>();
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate);
      const { stdout } = await execFileAsync(candidate, ['--version'], { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 64 });
      const version = stdout.trim().replace(/^codex-cli\s+/, '');
      if (version === CODEX_VERSION) return candidate;
      seenVersions.add(version);
    } catch { /* Continue searching other native installations. */ }
  }
  throw new Error(`需要 Codex CLI ${CODEX_VERSION}，${seenVersions.size ? `检测到 ${[...seenVersions].join('、')}` : '没有找到兼容的原生程序'}。请安装 npm install -g @openai/codex@${CODEX_VERSION}，或在设置中指定兼容的 codex.exe。`);
}

/** JSONL protocol without a shell, TCP port or renderer access to stdin. */
export class JsonLineRpc extends EventEmitter {
  private sequence = 0;
  private buffer = '';
  private closed = false;
  private readonly pending = new Map<RpcId, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private lastMethod = 'initialize';
  constructor(private readonly input: Readable, private readonly output: Writable, private readonly options: { deferEnd?: boolean } = {}) {
    super();
    input.setEncoding('utf8');
    input.on('data', this.onData);
    input.on('error', this.onError);
    input.on('end', this.onEnd);
    output.on('error', this.onError);
  }
  private onData = (chunk: string) => {
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) { this.close(new Error('Codex 返回的数据过大。')); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; }
      catch { this.close(new Error('Codex 返回了无效的消息。')); return; }
      if (!message || typeof message !== 'object') { this.close(new Error('Codex 协议消息格式错误。')); return; }
      if (message.method) this.emit('message', message);
      else if (message.id !== undefined) {
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new RpcResponseError(message.error.code, message.error.message));
        else request.resolve(message.result);
      }
    }
  };
  private onError = (error: NodeJS.ErrnoException) => {
    if (this.options.deferEnd && ['EPIPE', 'ECONNRESET'].includes(error.code ?? '')) return;
    this.close(new BackendError(error.message, this.lastMethod));
  };
  private onEnd = () => { if (!this.options.deferEnd) this.close(new BackendError('Codex 输出连接已关闭，请重新连接。', this.lastMethod)); };
  get phase(): string { return this.lastMethod; }
  private write(message: RpcMessage): void {
    if (this.closed) throw new Error('Codex 尚未连接。');
    this.output.write(`${JSON.stringify(message)}\n`);
  }
  request<T>(method: string, params: unknown, timeoutMs = 45_000, options: RpcRequestOptions = {}): Promise<T> {
    if (options.timeoutMode !== 'reject') this.lastMethod = method;
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new BackendError(`Codex 请求超时：${method}（${Math.ceil(timeoutMs / 1000)} 秒）。${options.timeoutMode === 'reject' ? '请稍后重试。' : '请检查网络后重新连接。'}`, method);
        if (options.timeoutMode === 'reject') { const request = this.pending.get(id); this.pending.delete(id); request?.reject(error); }
        else this.close(error);
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params?: unknown): void { this.write({ method, ...(params !== undefined ? { params } : {}) }); }
  respond(id: RpcId, result: unknown): void { this.write({ id, result }); }
  reject(id: RpcId, message: string, code = -32601): void { this.write({ id, error: { code, message } }); }
  close(reason = new Error('Codex 连接已关闭。')): void {
    if (this.closed) return;
    this.closed = true;
    this.input.off('data', this.onData);
    this.input.off('end', this.onEnd);
    // Keep the error listeners until the underlying streams finish shutting down.
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.pending.clear();
    this.emit('close', reason);
  }
}

export function attachAppServer(child: ChildProcessWithoutNullStreams): { child: ChildProcessWithoutNullStreams; rpc: JsonLineRpc } {
  const rpc = new JsonLineRpc(child.stdout, child.stdin, { deferEnd: true });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
  child.on('error', error => rpc.close(new BackendError(`Codex 无法启动：${error.message}`, rpc.phase)));
  child.on('close', (code, signal) => {
    const detail = sanitizeDiagnostic(stderr);
    rpc.close(new BackendError(`Codex 后台退出（阶段：${rpc.phase}，退出码：${code ?? '无'}${signal ? `，信号：${signal}` : ''}）。${detail ? `\n${detail}` : '请重新连接。'}`, rpc.phase, code, signal));
    stderr = '';
  });
  return { child, rpc };
}

export function spawnAppServer(executable: string, args: string[], cwd: string): { child: ChildProcessWithoutNullStreams; rpc: JsonLineRpc } {
  const child = spawn(executable, ['app-server', ...args], { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, RUST_LOG: 'error' } });
  return attachAppServer(child);
}
