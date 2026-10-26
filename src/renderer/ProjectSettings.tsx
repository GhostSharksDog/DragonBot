import { useState } from 'react';
import type { AppSnapshot, ProjectCandidate, Settings } from '../shared/types';

export function ProjectSettings({ snapshot, disabled, update, perform }: { snapshot: AppSnapshot; disabled: boolean; update(patch: Partial<Settings>): Promise<boolean>; perform(key: string, fn: () => Promise<unknown>): Promise<boolean> }) {
  const { settings, projectHandoff } = snapshot;
  const [candidates, setCandidates] = useState<ProjectCandidate[]>([]);
  const [candidate, setCandidate] = useState('');
  const [directory, setDirectory] = useState('');
  const [name, setName] = useState('DragonBot');
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const projects = settings.projects ?? [];
  async function discover() {
    setSearching(true);
    try { await perform('project-discover', async () => { const items = await window.pet.discoverProjects(); setCandidates(items); setSearched(true); if (items.length === 1) { setCandidate(items[0].threadId); setDirectory(items[0].directory); } }); } finally { setSearching(false); }
  }
  async function associate() {
    const selected = candidates.find(item => item.threadId === candidate); if (!selected) return;
    const id = projects.find(p => p.threadId === candidate)?.id ?? crypto.randomUUID();
    if (await update({ projects: [...projects.filter(p => p.id !== id), { id, name: name.trim() || 'DragonBot', application: 'codex', threadId: candidate, threadTitle: selected.title, directory }], activeProjectId: id })) { setCandidate(''); setCandidates([]); setSearched(false); }
  }
  return <section className="setting-section project-settings"><div className="setting-title"><h3>项目接续</h3><span>长期保存</span></div>
    <p className="field-hint">关联原应用开发对话后，说“继续桌宠项目”即可把要求发到原对话。桌宠自身开发任务也会使用所选项目目录，项目内修改与本地构建可继续执行。</p>
    <label className="project-access-choice"><input type="checkbox" checked={settings.projectReadAccess !== false} disabled={disabled} onChange={event => { void update({ projectReadAccess: event.target.checked }); }} />兼容本机 Windows 沙箱：允许原生命令读取项目外文件</label>
    <p className="field-hint">写入仍限制在当前项目，网络与扩大写入需批准。关闭此选项需要系统支持 Codex MXC 沙箱；不支持时原生命令无法启动。</p>
    <label className="field-heading" htmlFor="active-project">当前项目</label><select id="active-project" className="field-input" value={settings.activeProjectId ?? ''} disabled={disabled} onChange={e => { void update({ activeProjectId: e.target.value || null }); }}><option value="">普通任务（按任务授权文件夹）</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
    {projects.map(project => <div className="project-entry" key={project.id}><strong>{project.name}</strong><p>{project.directory}</p><p>{project.threadTitle}</p><small>{project.threadId}</small><div className="setting-actions"><button className="button small" onClick={() => { void perform('project-open', () => window.pet.openProject(project.id)); }}>打开原对话</button><button className="text-button" disabled={disabled} onClick={() => { void update({ projects: projects.filter(p => p.id !== project.id) }); }}>移除关联</button></div></div>)}
    <button className="button small" disabled={disabled || searching} onClick={() => { void discover(); }}>{searching ? '正在查找…' : '查找桌宠开发对话'}</button>
    {searched && !candidates.length && <p className="field-hint">未找到匹配对话，请确认原对话标题包含“桌宠”或“Dragon”。</p>}
    {!!candidates.length && <div className="project-link-form"><label className="field-heading" htmlFor="project-candidate">选择原对话</label><select id="project-candidate" className="field-input" value={candidate} disabled={disabled} onChange={e => { setCandidate(e.target.value); setDirectory(candidates.find(item => item.threadId === e.target.value)?.directory ?? ''); }}><option value="">请选择…</option>{candidates.map(item => <option value={item.threadId} key={item.threadId}>{item.title} · {item.threadId.slice(-6)}</option>)}</select>
      <label className="field-heading">项目名称<input className="field-input" value={name} disabled={disabled} onChange={e => setName(e.target.value)} /></label>
      <label className="field-heading">本地项目目录<input className="field-input" value={directory} disabled={disabled} onChange={e => setDirectory(e.target.value)} /></label>
      <div className="setting-actions"><button className="button small" disabled={disabled} onClick={() => { void window.pet.chooseFolder().then(value => { if (value) setDirectory(value); }); }}>选择目录</button><button className="button primary small" disabled={disabled || !candidate || !directory} onClick={() => { void associate(); }}>保存关联</button></div>
    </div>}
    {projectHandoff && <div className="project-entry" role="status"><p>{projectHandoff.message}</p><div className="setting-actions"><button className="button small" onClick={() => { void perform('project-refresh', () => window.pet.refreshProject()); }}>核对接续状态</button><button className="text-button" onClick={() => { void perform('project-open', () => window.pet.openProject(projectHandoff.projectId)); }}>打开原对话</button>{projectHandoff.status === 'uncertain' && <button className="text-button" onClick={() => { void perform('project-confirm', () => window.pet.confirmProjectNotSent()); }}>我已核对，未发送</button>}</div></div>}
    <p className="field-hint">原应用的审批需在原应用处理。删除、发布、扩大范围等重要操作仍需批准。</p>
  </section>;
}
