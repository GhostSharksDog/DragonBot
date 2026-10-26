import type { DynamicTool, ToolContext, ToolOutput } from '../../shared/tools';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BrowserTools, browserDefinitions, type BrowserOptions } from './browser';
import { FileTools, fileDefinitions, type FileOptions } from './files';
import type { BrowserConnectionConfig } from '../../shared/types';

export class ToolHost {
  private files: FileTools;
  private browser: BrowserTools;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private taskScope = new AsyncLocalStorage<{ taskId: string | null }>();
  constructor(context: ToolContext, options: { files?: FileOptions; browser?: BrowserOptions } = {}) {
    const check = () => {
      const scope = this.taskScope.getStore();
      if (this.disposed || (scope && context.getTaskId && (!scope.taskId || context.getTaskId() !== scope.taskId))) throw new Error('原任务已停止或切换，此操作已取消。');
    };
    const guarded: ToolContext = {
      getGrant: () => { check(); return context.getGrant(); },
      getTaskId: context.getTaskId ? () => context.getTaskId!() : undefined,
      requestApproval: async input => { check(); const result = await context.requestApproval(input); check(); return result; },
      onBrowserChange: status => context.onBrowserChange(status),
    };
    this.files = new FileTools(guarded, options.files);
    this.browser = new BrowserTools(guarded, options.browser);
    this.context = context;
  }
  private context: ToolContext;
  definitions(): DynamicTool[] { return [{ name: 'pet_task_scope', description: '查看用户为本次任务设置的文件夹、网站与网页输入权限。开始文件或网页任务前先调用；这些权限不代表用户已指定具体操作。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, ...fileDefinitions, ...browserDefinitions]; }

  async call(name: string, args: unknown): Promise<ToolOutput> {
    // Serial execution prevents approval/overwrite races between assistant tool calls.
    const taskId = this.context.getTaskId?.() ?? null;
    const run = this.queue.then(() => this.taskScope.run({ taskId }, async () => {
      if (this.disposed) throw new Error('工具会话已结束。');
      if (this.context.getTaskId && (!taskId || this.context.getTaskId() !== taskId)) throw new Error('原任务已停止或切换，此操作已取消。');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象。');
      if (!this.definitions().some(tool => tool.name === name)) throw new Error('不允许使用该工具。');
      const result = name === 'pet_task_scope' ? structuredClone(this.context.getGrant()) : name.startsWith('pet_files_') ? await this.files.call(name, args as Record<string, unknown>) : await this.browser.call(name, args as Record<string, unknown>);
      if (name === 'pet_browser_screenshot' && result && typeof result === 'object' && 'screenshot' in result) {
        const item = result.screenshot as { data?: string; mimeType?: string };
        if (item?.data && item.mimeType === 'image/png') return { contentItems: [{ type: 'inputImage' as const, imageUrl: `data:image/png;base64,${item.data}` }], success: true };
      }
      return { contentItems: [{ type: 'inputText' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }], success: true };
    }));
    this.queue = run.catch(() => undefined);
    try { return await run; }
    catch (error) { return { contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : '操作失败。' }], success: false }; }
  }
  async connectBrowser(config?: BrowserConnectionConfig) { await this.browser.connect(config); }
  async disconnectBrowser() { await this.browser.disconnect(); }
  async showBrowser() { await this.browser.show(); }
  async dispose() { this.disposed = true; await this.browser.dispose(); }
}
