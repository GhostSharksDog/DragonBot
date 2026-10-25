import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '../shared/types';
export const defaults: Settings = { scale: 1, roaming: true, alwaysOnTop: true, model: '', reasoningByModel: {}, codexPath: '', chromeExecutablePath: '', chromeUserDataDir: '', chromeProfileDirectory: '', grant: { folders: [], origins: [] }, skinPath: null };
export function validateSettings(input: unknown, previous: Settings = defaults): Settings {
  const v = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const result = structuredClone(previous);
  if (typeof v.scale === 'number' && Number.isFinite(v.scale)) result.scale = Math.max(.65, Math.min(1.7, v.scale));
  for (const key of ['roaming', 'alwaysOnTop'] as const) if (typeof v[key] === 'boolean') result[key] = v[key];
  for (const key of ['model', 'codexPath', 'chromeExecutablePath', 'chromeUserDataDir', 'chromeProfileDirectory'] as const) if (typeof v[key] === 'string' && v[key].length < 4096 && !v[key].includes('\0')) result[key] = v[key];
  if (v.reasoningByModel && typeof v.reasoningByModel === 'object' && !Array.isArray(v.reasoningByModel)) {
    result.reasoningByModel = Object.fromEntries(Object.entries(v.reasoningByModel).filter(([model, effort]) => model.length > 0 && model.length < 256 && !model.includes('\0') && typeof effort === 'string' && effort.length > 0 && effort.length < 80 && !effort.includes('\0')).slice(0, 100));
  }
  if (v.skinPath === null || typeof v.skinPath === 'string') result.skinPath = v.skinPath;
  if (v.grant && typeof v.grant === 'object') {
    const grant = v.grant as Record<string, unknown>;
    if (Array.isArray(grant.folders)) result.grant.folders = [...new Set(grant.folders.filter((f): f is string => typeof f === 'string' && path.isAbsolute(f) && f.length < 4096).map(f => path.resolve(f)))].slice(0, 12);
    if (Array.isArray(grant.origins)) result.grant.origins = [...new Set(grant.origins.filter((o): o is string => typeof o === 'string').map(o => { try { const u = new URL(o); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.origin : ''; } catch { return ''; } }).filter(Boolean))].slice(0, 30);
    if (typeof grant.browserInput === 'boolean') result.grant.browserInput = grant.browserInput;
  }
  return result;
}
export class SettingsStore {
  value: Settings;
  private file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'settings.json');
    try { this.value = validateSettings(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { this.value = structuredClone(defaults); }
    // Folder access belongs to the task; website access is an explicit lasting preference.
    this.value.grant = { ...this.value.grant, folders: [] };
  }
  update(patch: Partial<Settings>) {
    this.value = validateSettings(patch, this.value);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ ...this.value, grant: { ...this.value.grant, folders: [] } }, null, 2));
    fs.renameSync(this.file + '.tmp', this.file);
  }
}
