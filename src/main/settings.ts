import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '../shared/types';
export const defaults: Settings = { chat: { mode: 'auto', model: '', effort: 'high' }, projectReadAccess: true, projects: [], activeProjectId: null, scale: 1, roaming: true, alwaysOnTop: true, model: '', reasoningByModel: {}, codexPath: '', chromeExecutablePath: '', chromeUserDataDir: '', chromeProfileDirectory: '', grant: { folders: [], origins: [] }, skinPath: null };
export function validateSettings(input: unknown, previous: Settings = defaults): Settings {
  const v = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const result = structuredClone(previous);
  if (v.chat && typeof v.chat === 'object' && !Array.isArray(v.chat)) {
    const chat = v.chat as Record<string, unknown>;
    result.chat = { mode: ['auto','chat','task'].includes(String(chat.mode)) ? chat.mode as 'auto'|'chat'|'task' : previous.chat?.mode ?? 'auto', model: typeof chat.model === 'string' && chat.model.length < 120 ? chat.model : previous.chat?.model ?? '', effort: 'high' };
  }
  if (typeof v.scale === 'number' && Number.isFinite(v.scale)) result.scale = Math.max(.65, Math.min(1.7, v.scale));
  for (const key of ['roaming', 'alwaysOnTop', 'projectReadAccess'] as const) if (typeof v[key] === 'boolean') result[key] = v[key];
  for (const key of ['model', 'codexPath', 'chromeExecutablePath', 'chromeUserDataDir', 'chromeProfileDirectory'] as const) if (typeof v[key] === 'string' && v[key].length < 4096 && !v[key].includes('\0')) result[key] = v[key];
  if (v.reasoningByModel && typeof v.reasoningByModel === 'object' && !Array.isArray(v.reasoningByModel)) {
    result.reasoningByModel = Object.fromEntries(Object.entries(v.reasoningByModel).filter(([model, effort]) => model.length > 0 && model.length < 256 && !model.includes('\0') && typeof effort === 'string' && effort.length > 0 && effort.length < 80 && !effort.includes('\0')).slice(0, 100));
  }
  if (Array.isArray(v.projects)) result.projects = v.projects.filter((p: any) => p && typeof p.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(p.id) && p.application === 'codex' && typeof p.name === 'string' && p.name.length > 0 && p.name.length < 100 && typeof p.directory === 'string' && path.isAbsolute(p.directory) && !p.directory.includes('\0') && typeof p.threadId === 'string' && /^[0-9a-f-]{36}$/i.test(p.threadId) && typeof p.threadTitle === 'string' && p.threadTitle.length > 0 && p.threadTitle.length < 300).slice(0,20).map((p: any) => ({ id:p.id, name:p.name, directory:path.resolve(p.directory), application:'codex', threadId:p.threadId, threadTitle:p.threadTitle }));
  if (v.activeProjectId === null || typeof v.activeProjectId === 'string') result.activeProjectId = v.activeProjectId as string | null;
  if (!result.projects?.some(project => project.id === result.activeProjectId)) result.activeProjectId = null;
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
