import { access, readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserConnectionConfig, BrowserProfile, BrowserSetupSnapshot, Settings } from '../shared/types';

export const PLAYWRIGHT_EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';
export const PLAYWRIGHT_EXTENSION_STORE = `https://chromewebstore.google.com/detail/playwright-extension/${PLAYWRIGHT_EXTENSION_ID}`;
const PROFILE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._ -]{1,100}$/;
const execFileAsync = promisify(execFile);
type JsonObject = Record<string, any>;
interface SetupOptions {
  independentDataDir?: string;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): void;
  openExternal(url: string): Promise<void>;
  onChange?(snapshot: BrowserSetupSnapshot): void;
  environment?: NodeJS.ProcessEnv;
  executableCandidates?: string[];
  launchChrome?(config: BrowserConnectionConfig, url: string): Promise<void>;
}

async function fileExists(file: string) { try { return (await stat(file)).isFile(); } catch { return false; } }
async function json(file: string): Promise<JsonObject | null> {
  try { const info = await stat(file); if (info.size > 16777216) return null; const parsed: unknown = JSON.parse(await readFile(file, 'utf8')); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null; } catch { return null; }
}
const profileName = (value: unknown): value is string => typeof value === 'string' && PROFILE_NAME.test(value);
const initial = (): BrowserSetupSnapshot => ({ status: 'idle', message: '先检测 Chrome，再安装或启用官方扩展。', profiles: [], selectedProfileId: null, chromeFound: false, canConnect: false });

export function extensionState(preferences: JsonObject | null, secure: JsonObject | null, installed: boolean): BrowserProfile['extension'] {
  const setting = secure?.extensions?.settings?.[PLAYWRIGHT_EXTENSION_ID] ?? preferences?.extensions?.settings?.[PLAYWRIGHT_EXTENSION_ID];
  if (setting && typeof setting === 'object') {
    const reasons = setting.disable_reasons;
    const disabled = Array.isArray(reasons) ? reasons.length > 0 : typeof reasons === 'number' ? reasons !== 0 : false;
    if (setting.state === 0 || disabled) return 'disabled';
    if (setting.state === 1) return installed ? 'enabled' : 'unknown';
    return 'unknown';
  }
  return installed ? 'unknown' : preferences || secure ? 'missing' : 'unknown';
}

export class BrowserSetupService {
  private state = initial();
  private executablePath = '';
  private userDataDir = '';
  private detecting: Promise<BrowserSetupSnapshot> | null = null;
  constructor(private options: SetupOptions) {}
  getSnapshot(): BrowserSetupSnapshot { return structuredClone(this.state); }
  private publish(patch: Partial<BrowserSetupSnapshot>) { this.state = { ...this.state, ...patch }; this.options.onChange?.(this.getSnapshot()); }

  async detect(): Promise<BrowserSetupSnapshot> {
    if (this.detecting) return this.detecting;
    this.detecting = this.inspect();
    try { return await this.detecting; } finally { this.detecting = null; }
  }

  private async inspect(): Promise<BrowserSetupSnapshot> {
    this.publish({ status: 'detecting', message: this.options.independentDataDir ? '正在查找独立 Chrome…' : '正在查找 Chrome 与官方扩展…', canConnect: false });
    try {
      const settings = this.options.getSettings(); const env = this.options.environment ?? process.env;
      const candidates = settings.chromeExecutablePath ? [settings.chromeExecutablePath] : this.options.executableCandidates ?? [
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)']!, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ].filter((value): value is string => Boolean(value));
      this.executablePath = '';
      for (const candidate of candidates) if (path.isAbsolute(candidate) && await fileExists(candidate)) { this.executablePath = path.resolve(candidate); break; }
      if (!this.executablePath && !settings.chromeExecutablePath && !this.options.executableCandidates && process.platform === 'win32') this.executablePath = await this.registryChrome();
      if (!this.executablePath) { this.publish({ status: 'missing-browser', message: '没有找到 Chrome。请先安装 Chrome；如已安装在其他位置，可在高级设置中指定程序路径。', chromeFound: false, profiles: [], selectedProfileId: null }); return this.getSnapshot(); }
      if (this.options.independentDataDir) {
        this.userDataDir = path.join(this.options.independentDataDir, 'browser-profile');
        this.publish({ status: 'ready', message: '独立 Chrome 已就绪，无需扩展。首次网页登录后会保存在本机。', chromeFound: true, canConnect: true, selectedProfileId: 'Default', profiles: [{ id: 'Default', name: '桌宠专属', extension: 'unknown', lastUsed: true }] });
        return this.getSnapshot();
      }
      this.userDataDir = settings.chromeUserDataDir || (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data') : '');
      if (!this.userDataDir || !path.isAbsolute(this.userDataDir)) throw new Error('profile');
      this.userDataDir = path.resolve(this.userDataDir);
      const localState = await json(path.join(this.userDataDir, 'Local State'));
      const cache = localState?.profile?.info_cache;
      const names = new Set<string>();
      if (cache && typeof cache === 'object' && !Array.isArray(cache)) for (const name of Object.keys(cache)) if (profileName(name)) names.add(name);
      if (profileName(settings.chromeProfileDirectory)) { try { if ((await stat(path.join(this.userDataDir, settings.chromeProfileDirectory))).isDirectory()) names.add(settings.chromeProfileDirectory); } catch { /* A stale advanced profile setting is handled below. */ } }
      let directories: Dirent[];
      try { directories = await readdir(this.userDataDir, { withFileTypes: true }); } catch { directories = []; }
      for (const entry of directories) if (entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name)) names.add(entry.name);
      const profiles: BrowserProfile[] = [];
      for (const id of [...names].slice(0, 30)) {
        const base = path.join(this.userDataDir, id);
        const [preferences, secure] = await Promise.all([json(path.join(base, 'Preferences')), json(path.join(base, 'Secure Preferences'))]);
        const extensionDirectory = path.join(base, 'Extensions', PLAYWRIGHT_EXTENSION_ID);
        let installed = false;
        try { const versions = await readdir(extensionDirectory, { withFileTypes: true }); for (const version of versions) if (version.isDirectory() && /^[\d._]+$/.test(version.name) && await fileExists(path.join(extensionDirectory, version.name, 'manifest.json'))) { installed = true; break; } } catch { /* Extension is not installed in this profile. */ }
        const rawName = cache?.[id]?.name ?? preferences?.profile?.name;
        const name = typeof rawName === 'string' ? rawName.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : id === 'Default' ? '默认用户' : id;
        profiles.push({ id, name: name || id, extension: extensionState(preferences, secure, installed), lastUsed: localState?.profile?.last_used === id });
      }
      const preferred = settings.chromeProfileDirectory;
      const selected = profiles.find(profile => profile.id === preferred) ?? profiles.find(profile => profile.lastUsed) ?? profiles[0];
      this.publish({ chromeFound: true, profiles, selectedProfileId: selected?.id ?? null });
      if (!selected) this.publish({ status: 'failed', message: '已找到 Chrome，但没有可用的用户配置。请先打开 Chrome 完成首次设置，然后重新检测。', canConnect: false });
      else if (selected.extension === 'enabled') this.publish({ status: 'ready', message: `已找到「${selected.name}」中的 Playwright 扩展，可以连接并选择标签页。`, canConnect: true });
      else if (selected.extension === 'disabled') this.publish({ status: 'extension-disabled', message: `「${selected.name}」中的扩展已停用。请打开扩展管理页启用 Playwright，然后重新检测。`, canConnect: false });
      else if (profiles.some(profile => profile.extension === 'enabled')) this.publish({ status: 'profile-mismatch', message: '扩展已安装在其他 Chrome 用户中。可以切换到已安装的用户，或为当前用户安装扩展。', canConnect: false });
      else if (selected.extension === 'unknown') this.publish({ status: 'ready', message: '发现 Chrome 用户配置，但无法确定扩展是否启用。可以尝试连接；若未出现确认页面，请安装或启用扩展。', canConnect: true });
      else this.publish({ status: 'missing-extension', message: `请先为「${selected.name}」安装 Playwright 官方扩展。安装后点击“重新检测”。`, canConnect: false });
      return this.getSnapshot();
    } catch { this.publish({ status: 'failed', message: '无法读取 Chrome 配置。请检查高级设置，或关闭 Chrome 设置页后重新检测。', canConnect: false }); return this.getSnapshot(); }
  }

  async select(id: string): Promise<BrowserSetupSnapshot> {
    if (this.detecting) await this.detecting;
    if (!profileName(id) || !this.state.profiles.some(profile => profile.id === id)) throw new Error('请选择检测到的 Chrome 用户。');
    this.options.updateSettings({ chromeProfileDirectory: id }); return this.detect();
  }

  async getConnectionConfig(): Promise<BrowserConnectionConfig> {
    if (!this.state.chromeFound || !this.state.selectedProfileId) await this.detect();
    const id = this.state.selectedProfileId;
    if (!this.executablePath || !id || !this.userDataDir || !this.state.canConnect) throw new Error(this.state.message);
    if (!await fileExists(this.executablePath)) throw new Error('Chrome 程序位置已变化，请重新检测。');
    return { executablePath: this.executablePath, userDataDir: this.userDataDir, profileDirectory: id };
  }

  async install(): Promise<void> {
    if (this.options.independentDataDir) { await this.options.openExternal('https://www.google.com/chrome/'); return; }
    if (!this.state.chromeFound || !this.state.selectedProfileId) await this.detect();
    const selected = this.state.profiles.find(profile => profile.id === this.state.selectedProfileId);
    if (!this.executablePath || !selected) { await this.options.openExternal('https://www.google.com/chrome/'); return; }
    const config = { executablePath: this.executablePath, userDataDir: this.userDataDir, profileDirectory: selected.id };
    const url = selected.extension === 'disabled' ? `chrome://extensions/?id=${PLAYWRIGHT_EXTENSION_ID}` : PLAYWRIGHT_EXTENSION_STORE;
    try {
      if (this.options.launchChrome) await this.options.launchChrome(config, url);
      else await this.launchChrome(config, url);
      this.publish({ message: selected.extension === 'disabled' ? '已打开所选 Chrome 用户的扩展管理页。启用 Playwright 后，回到这里重新检测。' : '已在所选 Chrome 用户中打开官方商店。点击“添加至 Chrome”，安装完成后回到这里重新检测。' });
    } catch { this.publish({ status: 'failed', message: 'Chrome 未能打开。请检查程序路径，重新检测后再试。', canConnect: false }); throw new Error(this.state.message); }
  }

  setConnectionState(status: 'connecting' | 'connected' | 'disconnected' | 'failed', message?: string): void {
    if (this.options.independentDataDir) {
      this.publish({ status: status === 'connecting' ? 'awaiting-confirmation' : status === 'disconnected' ? 'ready' : status, canConnect: status !== 'connecting' && this.state.chromeFound, message: status === 'connecting' ? '正在启动独立 Chrome…' : status === 'connected' ? '独立浏览器已连接，登录状态自动保存在本机。' : status === 'failed' ? message || '独立浏览器连接失败，请重新连接。' : '独立浏览器已断开，重新连接后先读取页面。' }); return;
    }
    if (status === 'connecting') this.publish({ status: 'awaiting-confirmation', message: '请切换到 Chrome，在 Playwright 页面批准连接，并选择允许操作的标签页。', canConnect: false });
    else if (status === 'connected') this.publish({ status: 'connected', message: '已连接你选择的 Chrome 标签页，可以返回聊天交代任务。', canConnect: true });
    else if (status === 'failed') this.publish({ status: 'failed', message: /超时|timeout/i.test(message ?? '') ? '等待 Chrome 确认超时。请在 Chrome 中批准连接并选择标签页，然后重试。' : 'Chrome 连接未完成。请检查扩展已启用，并在 Chrome 中批准连接后重试。', canConnect: true });
    else if (this.state.status === 'connected' || this.state.status === 'awaiting-confirmation') this.publish({ status: 'ready', message: 'Chrome 连接已断开，可以重新连接并选择标签页。', canConnect: true });
  }

  private async registryChrome(): Promise<string> {
    for (const hive of ['HKCU', 'HKLM']) {
      try { const { stdout } = await execFileAsync('reg.exe', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`, '/ve'], { windowsHide: true, timeout: 3000 }); const candidate = stdout.match(/REG_SZ\s+([^\r\n]+)/)?.[1]?.trim().replace(/^"|"$/g, ''); if (candidate && path.isAbsolute(candidate) && await fileExists(candidate)) return candidate; } catch { /* Try standard registry hives only. */ }
    }
    return '';
  }

  private async launchChrome(config: BrowserConnectionConfig, url: string) {
    await access(config.executablePath);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(config.executablePath, [`--user-data-dir=${config.userDataDir}`, `--profile-directory=${config.profileDirectory}`, url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    });
  }
}
