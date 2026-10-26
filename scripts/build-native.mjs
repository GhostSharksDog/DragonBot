import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildNative() {
  if (process.platform !== 'win32') return false;
  const windows = process.env.WINDIR || 'C:\\Windows';
  const candidates = ['Framework64', 'Framework'].map(directory => path.join(windows, 'Microsoft.NET', directory, 'v4.0.30319', 'csc.exe'));
  let compiler;
  for (const candidate of candidates) {
    try { await access(candidate); compiler = candidate; break; } catch {}
  }
  if (!compiler) {
    console.warn('未找到系统 C# 编译器；外部点击收起将使用窗口失焦回退。');
    return false;
  }
  await mkdir('dist/native', { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(compiler, ['/nologo', '/target:exe', '/optimize+', '/platform:anycpu', '/reference:System.Windows.Forms.dll', `/out:${path.resolve('dist/native/raw-mouse.exe')}`, path.resolve('scripts/native/raw-mouse.cs')], { windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`鼠标辅助程序编译失败 (${code})`)));
  });
  const framework = path.dirname(compiler);
  const wpf = path.join(framework, 'WPF');
  await new Promise((resolve, reject) => {
    const child = spawn(compiler, ['/nologo', '/target:exe', '/optimize+', '/platform:anycpu', '/reference:System.Core.dll', '/reference:System.Web.Extensions.dll', ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(file => `/reference:${path.join(wpf, file)}`), `/out:${path.resolve('dist/native/desktop-chat.exe')}`, path.resolve('scripts/native/desktop-chat.cs')], { windowsHide: true, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`应用接续组件编译失败 (${code})`)));
  });
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildNative();
