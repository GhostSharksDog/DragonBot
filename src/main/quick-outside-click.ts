import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

export interface MouseButtonDown {
  button: 'left' | 'right' | 'middle' | 'x1' | 'x2';
  /** Physical Windows screen coordinates; convert with screen.screenToDipPoint in main. */
  x: number;
  y: number;
}

type HelperMessage = { type: 'ready' } | ({ type: 'mouse-down' } & MouseButtonDown);

export function rawMouseHelperPath(appPath: string): string {
  return path.join(appPath.replace(/\.asar$/i, '.asar.unpacked'), 'dist', 'native', 'raw-mouse.exe');
}

export function parseMouseHelperLine(line: string): HelperMessage | null {
  try {
    const data = JSON.parse(line);
    if (!data || typeof data !== 'object') return null;
    if (data.type === 'ready') return { type: 'ready' };
    if (data.type !== 'mouse-down' || !['left', 'right', 'middle', 'x1', 'x2'].includes(data.button)) return null;
    if (![data.x, data.y].every(value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)) return null;
    return { type: 'mouse-down', button: data.button, x: data.x, y: data.y };
  } catch { return null; }
}

/** Main classifies exact sprite pixels and bubble bounds after converting coordinates. */
export function shouldDismissQuickClick(mode: 'hidden' | 'quick' | 'panel', target: 'pet' | 'bubble' | 'outside'): boolean {
  return mode === 'quick' && target === 'outside';
}

export interface QuickOutsideClickOptions {
  helperPath: string;
  onMouseDown: (event: MouseButtonDown) => void;
  onUnavailable: (message: string) => void;
  onReady?: () => void;
  /** Injectable process boundary for lifecycle tests. */
  launch?: (helperPath: string) => ChildProcessWithoutNullStreams;
  platform?: NodeJS.Platform;
  startupTimeoutMs?: number;
}

/** Runs only while a quick bubble is visible. It never focuses windows or consumes input. */
export class QuickOutsideClickMonitor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private visible = false;
  private disposed = false;
  private generation = 0;
  private ready = false;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: QuickOutsideClickOptions) {}

  get isMonitoring(): boolean { return this.visible && this.child !== null && this.ready; }

  setQuickVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    if (!visible) { this.stop(); return; }
    if ((this.options.platform ?? process.platform) !== 'win32') {
      this.options.onUnavailable('当前系统使用窗口失焦收起气泡。');
      return;
    }
    const generation = ++this.generation;
    let child: ChildProcessWithoutNullStreams;
    try { child = (this.options.launch ?? (file => spawn(file, [], { windowsHide: true, stdio: 'pipe' })))(this.options.helperPath); }
    catch { this.unavailable(generation); return; }
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (generation !== this.generation || !this.visible || this.disposed) return;
      buffer += chunk;
      if (buffer.length > 8192) { this.unavailable(generation); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = parseMouseHelperLine(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        if (!message) continue;
        if (message.type === 'ready') {
          if (!this.ready) {
            this.ready = true;
            clearTimeout(this.startupTimer);
            this.options.onReady?.();
          }
        } else if (this.ready) {
          this.options.onMouseDown({ button: message.button, x: message.x, y: message.y });
          // A callback can hide the bubble synchronously; discard remaining queued clicks.
          if (generation !== this.generation || !this.visible || this.disposed) return;
        }
      }
    });
    child.stderr.resume(); // Drain only; helper diagnostics never contain user input.
    child.stdin.on('error', () => {});
    child.once('error', () => this.unavailable(generation));
    child.once('exit', () => this.unavailable(generation));
    this.startupTimer = setTimeout(() => this.unavailable(generation), this.options.startupTimeoutMs ?? 2500);
    this.startupTimer.unref();
  }

  dispose(): void {
    this.disposed = true;
    this.visible = false;
    this.stop();
  }

  private stop(): void {
    ++this.generation;
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    this.ready = false;
    const child = this.child;
    this.child = null;
    if (child) {
      child.stdin.end();
      try { child.kill(); } catch {}
    }
  }

  private unavailable(generation: number): void {
    if (generation !== this.generation || !this.visible || this.disposed) return;
    this.stop();
    this.options.onUnavailable('外部点击收起暂时不可用，仍可点击龙娘或关闭按钮收起气泡。');
  }
}
