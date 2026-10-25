import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ApprovalInput, ToolContext } from '../../shared/tools';

export class ToolDenied extends Error {}

export function contained(root: string, target: string, windows = process.platform === 'win32'): boolean {
  const api = windows ? path.win32 : path;
  const normalize = (value: string) => windows ? api.resolve(value).toLowerCase() : api.resolve(value);
  const relative = api.relative(normalize(root), normalize(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
}

export function validatePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) throw new ToolDenied('请输入有效的绝对文件路径。');
  if (!path.isAbsolute(value)) throw new ToolDenied('文件路径必须是绝对路径。');
  if (process.platform === 'win32') {
    // Reject device namespaces, alternate data streams and Win32 aliases before normalization.
    if (/^[\\/]{2}/.test(value) || value.slice(2).includes(':')) throw new ToolDenied('不支持网络路径、设备路径或备用数据流。');
    for (const part of value.slice(3).split(/[\\/]/)) {
      if (!part || part === '.' || part === '..') continue;
      if (/[. ]$/.test(part) || /[<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new ToolDenied('路径包含 Windows 保留名称或歧义字符。');
    }
  }
  return path.resolve(value);
}

export async function resolveTarget(input: string): Promise<string> {
  let candidate = validatePath(input);
  const suffix: string[] = [];
  while (true) {
    try { return path.join(await realpath(candidate), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      suffix.unshift(path.basename(candidate)); candidate = parent;
    }
  }
}

export async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export const digest = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export class FilePolicy {
  constructor(private context: ToolContext) {}

  async authorize(inputs: string[], title: string, details: string[], sensitive = false): Promise<() => Promise<string[]>> {
    const grant = JSON.stringify(this.context.getGrant());
    const targets = await Promise.all(inputs.map(resolveTarget));
    const roots = await Promise.all(this.context.getGrant().folders.map(async root => {
      try { const resolved = await realpath(validatePath(root)); return (await stat(resolved)).isDirectory() ? resolved : null; }
      catch { return null; }
    }));
    const outside = targets.filter(target => !roots.some(root => root !== null && contained(root, target)));
    if (sensitive || outside.length) {
      const approval: ApprovalInput = {
        title: outside.length ? `扩大本次访问范围：${title}` : title,
        description: outside.length ? '以下路径超出本任务授权文件夹。仅批准这一次具体操作，不会永久扩大范围。' : '请确认这一次具体文件操作。',
        details: [...targets.map(target => `路径：${target}`), ...details],
      };
      if (!await this.context.requestApproval(approval)) throw new ToolDenied('已拒绝操作，文件没有改动。');
    }
    const revalidate = async () => {
      if (JSON.stringify(this.context.getGrant()) !== grant) throw new ToolDenied('任务授权已变化，请重新发起操作。');
      const latest = await Promise.all(inputs.map(resolveTarget));
      if (latest.some((target, i) => !samePath(target, targets[i]))) throw new ToolDenied('等待期间路径已变化，请重新发起操作。');
      return latest;
    };
    await revalidate();
    return revalidate;
  }
}

export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function cleanOrigin(input: unknown): string {
  if (typeof input !== 'string') throw new ToolDenied('请输入有效的网址。');
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ToolDenied('只允许普通 HTTP / HTTPS 网页，网址不能包含用户名或密码。');
  return url.origin;
}
