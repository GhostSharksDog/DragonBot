import path from 'node:path';
import os from 'node:os';
import type { Settings } from '../../shared/types';
import { contained } from '../tools/policy';

export function activeProject(settings: Settings) { return settings.projects?.find(project => project.id === settings.activeProjectId); }
/** Only the exact standard local build/test commands are covered by the project grant.
 * Shell composition, arguments, deletion, install, publishing and elevated requests remain explicit approvals. */
export function projectCommandCovered(settings: Settings, command: string | null | undefined, cwd: string | null | undefined, additionalPermissions: unknown): boolean {
  const project = activeProject(settings);
  if (!project || !cwd || !command || additionalPermissions || !contained(project.directory, cwd)) return false;
  let simple = command.trim();
  // The Windows executor reports its fixed shell wrapper, even for one command.
  // Accept only known shell locations and a single quoted literal command.
  const wrapped = /^"([^"\r\n]+)" -Command '([^'\r\n]+)'$/.exec(simple);
  if (wrapped) {
    const executable = path.win32.normalize(wrapped[1].replace(/\\\\/g, '\\')).toLowerCase();
    const shells = [path.join(process.env.WINDIR || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')];
    if (!shells.some(shell => path.win32.normalize(shell).toLowerCase() === executable)) return false;
    simple = wrapped[2];
  }
  return /^(?:npm(?:\.cmd)? (?:test|run (?:build|test|typecheck|lint))|git (?:status(?: --short)?|diff(?: --stat)?))$/.test(simple);
}
export function projectInstructions(settings: Settings): string {
  const project = activeProject(settings);
  return project ? `\n当前长期关联项目：${project.name}，目录：${path.resolve(project.directory)}。当前任务在该目录内自主读取和修改代码、运行本地构建与测试。使用原生 shell 和补丁完成项目开发，仍受 workspace-write 沙箱限制；不要使用提权或绕过沙箱。删除必须通过 pet_files_trash 请求批准。安装依赖、发布、推送、网络访问、越界操作与其他重要外部操作先请求真实审批，不把聊天同意当作审批。不要借构建脚本执行超出项目目标的动作。网页始终使用独立浏览器工具。用户要接续原应用对话时使用桌宠的项目接续入口，不在此后台恢复或驱动其线程。` : '';
}
