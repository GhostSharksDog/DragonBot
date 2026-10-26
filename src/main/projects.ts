import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ProjectCandidate, ProjectHandoff, ProjectLink, Settings } from '../shared/types';
import type { Thread } from '../generated/codex/v2/Thread';

interface DesktopState { title: string; draftLength: number; draftHash: string; busy: boolean; needsResponse: boolean }
export interface ProjectOptions {
  dataDir: string; helperPath: string; getSettings(): Settings; saveSettings(patch: Partial<Settings>): void;
  listThreads(): Promise<Thread[]>; readThread(id: string): Promise<Thread>; openLink(url: string): Promise<void>;
  uniqueTitle?(id: string, title: string): Promise<boolean>;
  choose(question: string, options: string[]): Promise<string | null>; notify(message: string): void; changed(): void;
  runHelper?(input: Record<string, unknown>): Promise<any>;
}
interface Intent { state: ProjectHandoff; prompt: string; baseline: string[]; title: string; fingerprint: string; uniqueTitle?: boolean; turnId?: string; messageHash?: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
export function userMessages(thread: Thread) {
  return (thread.turns ?? []).flatMap(turn => turn.items.filter(item => item.type === 'userMessage').map(item => ({ id: item.id, turn, text: item.type === 'userMessage' ? item.content.filter(part => part.type === 'text').map(part => part.type === 'text' ? part.text : '').join('\n') : '' })));
}
export function threadFingerprint(thread: Thread): string {
  const last = userMessages(thread).at(-1)?.text ?? '';
  const lines = last.split('\n').map(line => line.replace(/^\s*[#*>-]+\s*/, '').trim()).filter(line => line.length >= 24 && !line.startsWith('<') && !line.startsWith('{'));
  return normalize(lines[0] ?? last).slice(0, 72);
}

export class ProjectService {
  private intent: Intent | null = null;
  private running = false;
  private disposed = false;
  private generation = 0;
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private saving = Promise.resolve();
  constructor(private options: ProjectOptions) {}
  getSnapshot() { return this.intent ? structuredClone(this.intent.state) : null; }
  private file() { return path.join(this.options.dataDir, 'project-handoff.json'); }
  async initialize() {
    try {
      const stored = JSON.parse(await readFile(this.file(), 'utf8'));
      if (stored?.state?.threadId && Array.isArray(stored.baseline) && typeof stored.prompt === 'string') {
        this.intent = stored;
        if (!['completed', 'failed'].includes(stored.state.status)) this.update('uncertain', '上次发送状态需要核对。不会自动重发，请点击“核对接续状态”。');
      }
    } catch { /* No saved intent. Never re-execute a saved operation. */ }
  }
  private update(status: ProjectHandoff['status'], message: string) {
    if (!this.intent) return;
    this.intent.state = { ...this.intent.state, status, message, updatedAt: Date.now() };
    const data = JSON.stringify(this.intent);
    this.saving = this.saving.catch(() => {}).then(async () => { await mkdir(this.options.dataDir, { recursive: true }); await writeFile(this.file() + '.tmp', data); await rename(this.file() + '.tmp', this.file()); });
    void this.saving.catch(() => { if (this.intent && !this.disposed) { this.intent.state.message = '接续状态未能保存，请核对原应用后再操作；不会自动重发。'; this.options.changed(); } });
    this.options.changed();
  }
  async discover(): Promise<ProjectCandidate[]> {
    const threads = await this.options.listThreads(), result: ProjectCandidate[] = [];
    for (const thread of threads) {
      if (!thread.name || !/桌宠|dragon|pet/i.test(thread.name + ' ' + thread.preview)) continue;
      let directory = thread.cwd;
      // Recognize the repository under the conversation workspace, without scanning the disk.
      for (const candidate of [thread.cwd, path.join(thread.cwd, 'dragon-pet'), path.join(thread.cwd, 'DragonBot')]) {
        try { const data = JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8')); if (/dragon-pet|dragonbot/i.test(data.name ?? '')) { directory = candidate; break; } } catch { }
      }
      result.push({ threadId: thread.id, title: thread.name, directory, updatedAt: thread.updatedAt * 1000 });
    }
    return result;
  }
  private project(id: string) {
    const project = this.options.getSettings().projects?.find(p => p.id === id);
    if (!project) throw new Error('请先关联一个项目与原应用对话。');
    return project;
  }
  async open(id: string) { const project = this.project(id); await this.options.openLink(`codex://threads/${project.threadId}`); }
  async continueDefault(prompt: string) {
    let project = this.options.getSettings().projects?.find(p => p.id === this.options.getSettings().activeProjectId);
    if (!project) {
      const candidates = await this.discover();
      if (!candidates.length) throw new Error('没有找到匹配的开发对话。请在设置的“项目接续”中重新查找或填写原对话编号。');
      const labels = candidates.map((p, i) => `${i + 1}. ${p.title} · ${p.threadId.slice(-6)}`);
      const chosen = await this.options.choose('把桌宠项目关联到哪段已有开发对话？', labels);
      if (!chosen) return;
      const selected = candidates[labels.indexOf(chosen)]; if (!selected) return;
      project = { id: randomUUID(), name: 'DragonBot', directory: selected.directory, application: 'codex', threadId: selected.threadId, threadTitle: selected.title };
      this.options.saveSettings({ projects: [...(this.options.getSettings().projects ?? []), project], activeProjectId: project.id });
    }
    await this.send(project.id, prompt);
  }
  private helper(input: Record<string, unknown>): Promise<any> {
    if (this.options.runHelper) return this.options.runHelper(input);
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('目标应用响应超时。请核对原对话，不会自动重发。')); }, 12000);
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; if (output.length > 65536) child.kill(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); try { const result = JSON.parse(output.trim()); result.ok ? resolve(result.result) : reject(new Error(result.error || '目标应用操作失败。')); } catch { reject(new Error('目标应用返回状态不明确。请核对原对话，不会自动重发。')); } });
      child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input) + '\n');
    });
  }
  async send(id: string, prompt: string) {
    if (this.running || this.disposed) throw new Error('已有接续操作正在进行。');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) throw new Error('请输入有效的接续要求。');
    if (this.intent && ['uncertain', 'preparing'].includes(this.intent.state.status)) throw new Error('上次发送结果尚未核对，请先核对原对话，避免重复发送。');
    const project = this.project(id);
    if (!(await stat(project.directory)).isDirectory()) throw new Error('项目目录不存在，请更新关联。');
    this.running = true; const generation = ++this.generation;
    const check = () => { if (this.disposed || generation !== this.generation) throw new Error('接续操作已停止，原应用内已发送的任务需在原应用停止。'); };
    let mayHaveSent = false;
    try {
      const thread = await this.options.readThread(project.threadId); check();
      if (thread.name !== project.threadTitle) throw new Error('原对话标题已变化，请重新关联后发送。');
      const fingerprint = threadFingerprint(thread);
      const uniqueTitle = await this.options.uniqueTitle?.(project.threadId, project.threadTitle) ?? false; check();
      this.intent = { state: { id: randomUUID(), projectId: id, threadId: project.threadId, status: 'preparing', message: '', startedAt: Date.now(), updatedAt: Date.now() }, title: project.threadTitle, fingerprint, prompt: prompt.trim(), baseline: userMessages(thread).map(m => m.id) };
      this.intent.uniqueTitle = uniqueTitle;
      this.update('preparing', '正在打开并核对原对话…'); await this.saving; check();
      await this.open(id);
      let state: DesktopState | undefined;
      for (let attempt = 0; attempt < 6; attempt++) {
        check();
        try { state = await this.helper({ operation: 'inspect', title: project.threadTitle, fingerprint, uniqueTitle }); break; }
        catch (error) { if (attempt === 5) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
      }
      check(); if (!state) throw new Error('未找到原对话。');
      if (state.needsResponse) { this.update('needs-response', '原对话正在等待回应或批准，请到原应用处理。'); return; }
      let allowBusy = false, appendDraft = false;
      if (state.busy) {
        this.update('needs-response', '原对话正在工作，需要选择等待或追加。');
        const choice = await this.options.choose('原对话正在工作。', ['暂不发送，等待结束', '追加这次要求']); check();
        if (choice !== '追加这次要求') { this.update('failed', '本次未发送。原任务继续在应用中执行。'); return; } allowBusy = true;
      }
      if (state.draftLength) {
        this.update('needs-response', '原对话有未发送草稿，需要确认。');
        const choice = await this.options.choose('原对话有未发送的草稿，要连同新要求一起发送吗？', ['保留草稿，暂不发送', '在草稿后追加并一起发送']); check();
        if (choice !== '在草稿后追加并一起发送') { this.update('failed', '保留原草稿，本次未发送。'); return; } appendDraft = true;
      }
      check(); this.update('preparing', '正在向核对过的原对话发送…'); await this.saving; check();
      mayHaveSent = true;
      const sent = await this.helper({ operation: 'send', title: project.threadTitle, fingerprint, uniqueTitle, prompt: this.intent.prompt, draftHash: state.draftHash, allowBusy, appendDraft });
      if (sent?.messageHash) this.intent.messageHash = sent.messageHash;
      this.update('uncertain', '已调用发送，正在核对原对话消息记录。');
      for (let attempt = 0; attempt < 8; attempt++) { await this.refresh(); if (this.intent.state.status !== 'uncertain') break; await new Promise(resolve => setTimeout(resolve, 750)); }
      if (['sent', 'running', 'needs-response'].includes(this.intent.state.status)) this.schedulePoll();
      this.options.notify(this.intent.state.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.update(mayHaveSent ? 'uncertain' : 'failed', message);
      if (mayHaveSent) await this.refresh().catch(() => {});
      throw new Error(this.intent?.state.message || message);
    } finally { this.running = false; }
  }
  refresh(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.reconcile().finally(() => { this.polling = null; }); return this.polling;
  }
  private async reconcile() {
    const intent = this.intent; if (!intent || this.disposed) return;
    const thread = await this.options.readThread(intent.state.threadId);
    if (this.intent !== intent || this.disposed) return;
    // Chromium's accessible editor can contribute one terminal newline to the
    // submitted message. Preserve all other content, including appended drafts.
    const matching = userMessages(thread).find(message => !intent.baseline.includes(message.id) && (intent.messageHash ? [message.text, message.text.replace(/\r?\n$/, '')].some(text => hash(text) === intent.messageHash) : normalize(message.text) === normalize(intent.prompt)));
    if (!matching) { if (intent.state.status === 'uncertain') this.update('uncertain', '尚未在原对话记录中确认这次要求。请打开原对话核对；不会自动重发。'); return; }
    intent.turnId = matching.turn.id;
    if (matching.turn.status === 'completed' && matching.turn.items.some(item => item.type === 'agentMessage' && item.text.trim() && item.phase !== 'commentary')) {
      // Rollout summaries can lag the owning app. Completion needs a final reply
      // and a matching app view that is neither busy nor awaiting approval.
      try {
        const state = await this.helper({ operation: 'inspect', title: intent.title, fingerprint: intent.fingerprint, uniqueTitle: intent.uniqueTitle });
        this.update(state.needsResponse ? 'needs-response' : state.busy ? 'running' : 'completed', state.needsResponse ? '原应用需要回应或批准，请在原应用中处理。' : state.busy ? '原对话仍在执行。' : '原对话已返回最终回复并结束执行，可打开原对话查看结果。');
      } catch { this.update('sent', '已确认原对话收到要求并返回回复；打开原对话后可继续核对完成状态。'); }
    }
    else if (['failed', 'interrupted'].includes(matching.turn.status)) this.update('failed', '原对话中的任务已失败或停止，请打开原对话查看。');
    else {
      this.update('running', '已确认要求发送到原对话，正在由原应用执行。');
      try { const state = await this.helper({ operation: 'inspect', title: intent.title, fingerprint: intent.fingerprint, uniqueTitle: intent.uniqueTitle }); if (state.needsResponse) this.update('needs-response', '原应用需要回应或批准，请在原应用中处理。'); } catch { /* App is hidden/on another thread. History remains authoritative. */ }
    }
  }
  private schedulePoll() { if (this.timer) clearTimeout(this.timer); if (this.disposed) return; this.timer = setTimeout(() => { void this.refresh().catch(() => {}).finally(() => { if (this.intent && ['sent', 'running', 'needs-response'].includes(this.intent.state.status)) this.schedulePoll(); }); }, 5000); this.timer.unref(); }
  confirmNotSent() { if (this.running) throw new Error('发送仍在核对中，请稍候。'); if (this.intent?.state.status === 'uncertain') this.update('failed', '用户已在原对话核对本次未发送；可以重新输入要求。'); }
  stop() { ++this.generation; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  async dispose() { this.disposed = true; this.stop(); await this.saving.catch(() => {}); }
}
