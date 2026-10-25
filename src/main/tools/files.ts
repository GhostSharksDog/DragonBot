import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DynamicTool, ToolContext } from '../../shared/tools';
import { contained, digest, exists, FilePolicy, resolveTarget, samePath, ToolDenied, validatePath } from './policy';

const string = { type: 'string' };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const define = (name: string, description: string, properties: Record<string, unknown>, required: string[]): DynamicTool => ({ name: `pet_files_${name}`, description, inputSchema: schema(properties, required) });
export const fileDefinitions: DynamicTool[] = [
  define('list', '列出授权目录中的文件。路径必须为绝对路径。', { path: string }, ['path']),
  define('read', '读取 UTF-8 文本文件（最多 512 KiB）。', { path: string }, ['path']),
  define('search', '在目录内按名称或文本搜索（不跟随符号链接）。', { path: string, query: string, content: { type: 'boolean' } }, ['path', 'query']),
  define('write', '创建 UTF-8 文件，覆盖已有文件时请求本次批准。', { path: string, content: string }, ['path', 'content']),
  define('mkdir', '创建一个新目录，父目录必须存在。', { path: string }, ['path']),
  define('copy', '复制单个普通文件，覆盖目标时请求批准。', { source: string, destination: string }, ['source', 'destination']),
  define('move', '移动或重命名单个普通文件。首版不移动目录；目标必须不存在。', { source: string, destination: string }, ['source', 'destination']),
  define('trash', '请求批准后将文件或目录移到 Windows 回收站。不会永久删除。', { path: string }, ['path']),
];

export interface FileOptions { trashItem?: (target: string) => Promise<void> }

function textArg(args: Record<string, unknown>, key: string, max = 4096): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length > max) throw new ToolDenied(`参数 ${key} 必须是文本，长度不超过 ${max}。`);
  return value;
}

async function plainFile(target: string) {
  const entry = await lstat(target);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new ToolDenied('此操作仅支持普通文件。');
  return entry;
}

async function identity(target: string): Promise<string | null> {
  if (!await exists(target)) return null;
  const entry = await lstat(target);
  return `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.ctimeMs}:${entry.mode}`;
}

export class FileTools {
  private policy: FilePolicy;
  constructor(context: ToolContext, private options: FileOptions = {}) { this.policy = new FilePolicy(context); }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'pet_files_list': return this.list(validatePath(args.path));
      case 'pet_files_read': return this.read(validatePath(args.path));
      case 'pet_files_search': return this.search(validatePath(args.path), textArg(args, 'query', 500), args.content === true);
      case 'pet_files_write': return this.write(validatePath(args.path), textArg(args, 'content', 524288));
      case 'pet_files_mkdir': return this.makeDirectory(validatePath(args.path));
      case 'pet_files_copy': return this.transfer(validatePath(args.source), validatePath(args.destination), false);
      case 'pet_files_move': return this.transfer(validatePath(args.source), validatePath(args.destination), true);
      case 'pet_files_trash': return this.trash(validatePath(args.path));
      default: throw new ToolDenied('未知文件工具。');
    }
  }

  private async list(input: string) {
    const check = await this.policy.authorize([input], '列出目录', []);
    const [target] = await check();
    const entries = await readdir(target, { withFileTypes: true });
    return { path: target, entries: entries.slice(0, 300).map(entry => ({ name: entry.name, kind: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })), truncated: entries.length > 300 };
  }

  private async read(input: string) {
    const check = await this.policy.authorize([input], '读取文本文件', []);
    const [target] = await check();
    const entry = await plainFile(target);
    if (entry.size > 524288) throw new ToolDenied('文件大于 512 KiB，请缩小文件后重试。');
    const data = await readFile(target);
    if (data.includes(0)) throw new ToolDenied('这是二进制文件，不能作为文本读取。');
    return { path: target, content: data.toString('utf8') };
  }

  private async search(input: string, query: string, content: boolean) {
    if (!query.trim()) throw new ToolDenied('搜索内容不能为空。');
    const check = await this.policy.authorize([input], '搜索目录', [`搜索：${query}`, `搜索文件内容：${content ? '是' : '否'}`]);
    const [root] = await check();
    const matches: { path: string; line?: number; preview?: string }[] = [];
    const queue = [root]; let visited = 0;
    while (queue.length && visited < 1500 && matches.length < 100) {
      const directory = queue.shift()!;
      const directoryReal = await resolveTarget(directory);
      if (!contained(root, directoryReal)) continue;
      await check();
      let entries;
      try { entries = await readdir(directoryReal, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (++visited > 1500 || matches.length >= 100) break;
        if (entry.isSymbolicLink()) continue;
        const candidate = path.join(directoryReal, entry.name);
        const canonical = await resolveTarget(candidate);
        if (!contained(root, canonical)) continue;
        if (entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) matches.push({ path: candidate });
        if (entry.isDirectory()) { queue.push(candidate); continue; }
        if (!content || !entry.isFile()) continue;
        try {
          const info = await lstat(canonical);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 262144) continue;
          const data = await readFile(canonical);
          if (data.includes(0)) continue;
          const lines = data.toString('utf8').split(/\r?\n/);
          for (let i = 0; i < lines.length && matches.length < 100; i++) if (lines[i].toLocaleLowerCase().includes(query.toLocaleLowerCase())) matches.push({ path: candidate, line: i + 1, preview: lines[i].slice(0, 250) });
        } catch { /* Files may disappear while searching. */ }
      }
    }
    return { matches, truncated: visited >= 1500 || matches.length >= 100 };
  }

  private async write(input: string, content: string) {
    const target = await resolveTarget(input);
    const before = await identity(target);
    if (before) { const info = await plainFile(target); if (info.nlink > 1) throw new ToolDenied('为避免修改其他硬链接，不允许覆盖此文件。'); }
    const check = await this.policy.authorize([input], before ? '覆盖文件' : '创建文件', [`新内容：${Buffer.byteLength(content)} 字节`, `SHA-256：${digest(content)}`, `内容预览：\n${content.slice(0, 2000)}`], before !== null);
    const [latest] = await check();
    if (await identity(latest) !== before) throw new ToolDenied('等待期间文件已变化，请重新确认操作。');
    if (before) {
      const handle = await open(latest, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`;
        if (fingerprint !== before || info.nlink > 1) throw new ToolDenied('文件已变化，未覆盖。');
        await check();
        await handle.truncate(0); await handle.writeFile(content, 'utf8');
      } finally { await handle.close(); }
    } else {
      const handle = await open(latest, 'wx');
      try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
    }
    return { path: latest, bytes: Buffer.byteLength(content), status: before ? 'overwritten' : 'created' };
  }

  private async makeDirectory(input: string) {
    const check = await this.policy.authorize([input], '创建目录', []);
    const [target] = await check(); await mkdir(target); return { path: target, status: 'created' };
  }

  private async transfer(sourceInput: string, destinationInput: string, move: boolean) {
    const source = await resolveTarget(sourceInput); const destination = await resolveTarget(destinationInput);
    if (samePath(source, destination)) throw new ToolDenied('源文件和目标文件相同。');
    const sourceEntry = await plainFile(source);
    const sourceBefore = await identity(source); const destinationBefore = await identity(destination);
    if (destinationBefore) {
      await plainFile(destination);
      if (move) throw new ToolDenied('移动目标已存在，请选择新路径；如需替换，请先批准将旧文件移到回收站。');
      if (sourceEntry.size > 16777216) throw new ToolDenied('首版只支持覆盖复制 16 MiB 以内的文件，请选择新的目标路径。');
    }
    const check = await this.policy.authorize([sourceInput, destinationInput], `${move ? '移动' : '复制'}文件${destinationBefore ? '并覆盖目标' : ''}`, [`来源：${source}`, `目标：${destination}`, `来源大小：${sourceEntry.size} 字节`], destinationBefore !== null);
    const [from, to] = await check();
    if (await identity(from) !== sourceBefore || await identity(to) !== destinationBefore) throw new ToolDenied('等待期间文件已变化，请重新发起操作。');
    if (move) {
      // COPYFILE_EXCL avoids accidentally replacing a destination created after approval.
      await check();
      await copyFile(from, to, constants.COPYFILE_EXCL);
      try { await check(); if (await identity(from) !== sourceBefore) throw new ToolDenied('源文件已变化。'); await check(); await this.trashOriginal(from); }
      catch (error) { throw new ToolDenied(`目标副本已创建，但源文件未移走：${(error as Error).message}`); }
    } else if (destinationBefore) {
      const data = await readFile(from); await this.writeApprovedCopy(to, data, destinationBefore, check);
    } else { await check(); await copyFile(from, to, constants.COPYFILE_EXCL); }
    return { source: from, destination: to, status: move ? 'moved' : 'copied' };
  }

  private async writeApprovedCopy(target: string, data: Buffer, before: string, check: () => Promise<string[]>) {
    const handle = await open(target, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}` !== before || info.nlink > 1) throw new ToolDenied('目标文件已变化或存在硬链接，未覆盖。');
      await check(); await handle.truncate(0); await handle.writeFile(data);
    } finally { await handle.close(); }
  }

  private async trash(input: string) {
    const target = await resolveTarget(input);
    const before = await identity(target);
    if (!before) throw new ToolDenied('文件不存在。');
    const check = await this.policy.authorize([input], '移到回收站', ['此操作将删除该路径；目录会连同其中的文件一起移到回收站。'], true);
    const [latest] = await check();
    if (await identity(latest) !== before) throw new ToolDenied('等待期间文件已变化，请重新发起操作。');
    await check();
    await this.trashOriginal(latest); return { path: latest, status: 'trashed' };
  }

  private async trashOriginal(target: string) {
    if (this.options.trashItem) return this.options.trashItem(target);
    const { shell } = await import('electron');
    await shell.trashItem(target);
  }
}
