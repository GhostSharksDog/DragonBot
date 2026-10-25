import type { TaskGrant } from './types';
export interface ApprovalInput { title: string; description: string; details: string[] }
export interface ToolContext { getGrant(): TaskGrant; getTaskId?(): string | null; requestApproval(input: ApprovalInput): Promise<boolean>; onBrowserChange(status: 'disconnected' | 'connecting' | 'connected'): void }
export interface DynamicTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ToolOutput { contentItems: ({ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string })[]; success: boolean }
