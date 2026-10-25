export type Activity = 'idle' | 'walking' | 'running' | 'thinking' | 'speaking' | 'awaiting-input' | 'awaiting-approval' | 'success' | 'error';
export interface TaskGrant { folders: string[]; origins: string[]; browserInput?: boolean }
export interface Settings { scale: number; roaming: boolean; alwaysOnTop: boolean; model: string; reasoningByModel?: Record<string, string>; codexPath: string; chromeExecutablePath: string; chromeUserDataDir: string; chromeProfileDirectory: string; grant: TaskGrant; skinPath: string | null }
export type BrowserSetupStatus = 'idle' | 'detecting' | 'missing-browser' | 'missing-extension' | 'extension-disabled' | 'profile-mismatch' | 'ready' | 'awaiting-confirmation' | 'connected' | 'failed';
export interface BrowserProfile { id: string; name: string; extension: 'enabled' | 'disabled' | 'missing' | 'unknown'; lastUsed: boolean }
export interface BrowserSetupSnapshot { status: BrowserSetupStatus; message: string; profiles: BrowserProfile[]; selectedProfileId: string | null; chromeFound: boolean; canConnect: boolean }
export interface BrowserConnectionConfig { executablePath: string; userDataDir: string; profileDirectory: string }
export interface ChatMessage { id: string; role: 'user' | 'assistant' | 'system'; text: string; createdAt: number }
export interface Question { id: string; header: string; question: string; options?: { label: string; description?: string }[]; isOther?: boolean; isSecret?: boolean }
export interface ApprovalRequest { id: string; kind: 'approval'; threadId: string; turnId: string; title: string; description: string; details: string[]; supportsSession: boolean }
export interface QuestionRequest { id: string; kind: 'question'; threadId: string; turnId: string; title: string; questions: Question[] }
export type PendingInteraction = ApprovalRequest | QuestionRequest;
export interface ModelInfo { id: string; label: string; isDefault?: boolean; supportedReasoningEfforts?: { reasoningEffort: string; description: string }[]; defaultReasoningEffort?: string }
export interface QuotaWindow { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
export interface QuotaBucket { id: string; name: string | null; primary: QuotaWindow | null; secondary: QuotaWindow | null; credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null; planType: string | null }
export interface QuotaSnapshot { status: 'idle' | 'loading' | 'ready' | 'error'; buckets: QuotaBucket[]; updatedAt: number | null; stale: boolean; error: string | null }
export interface ThreadSummary { id: string; title: string; updatedAt: number }
export interface AssistantSnapshot { connected: boolean; connection?: 'disconnected' | 'connecting' | 'ready' | 'reconnecting' | 'error'; login?: 'unknown' | 'checking' | 'signed-out' | 'opening-browser' | 'waiting-browser' | 'signed-in' | 'error'; diagnostic?: { phase: string; message: string; exitCode?: number | null; signal?: string | null } | null; account: string; models: ModelInfo[]; quota?: QuotaSnapshot; threadId: string | null; activeTurnId: string | null; activity: Activity; messages: ChatMessage[]; pending: PendingInteraction[]; threads: ThreadSummary[]; browser: 'disconnected' | 'connecting' | 'connected'; error: string | null }
export interface SpriteRegion { x: number; y: number; width: number; height: number; outline?: [number, number][] }
export function skinRegionClipPath(region: SpriteRegion): string | undefined {
  return region.outline?.length ? `polygon(evenodd, ${region.outline.map(([x, y]) => `${x / region.width * 100}% ${y / region.height * 100}%`).join(', ')})` : undefined;
}
export function pointInSpriteOutline(region: SpriteRegion, x: number, y: number): boolean {
  const points = region.outline;
  if (!points) return true;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[i], [bx, by] = points[j];
    if (Math.abs((x - ax) * (by - ay) - (y - ay) * (bx - ax)) < 1e-7 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return true;
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
export interface SkinAnimation { frames: string[]; fps: number; loop?: boolean; atlas?: { columns: number; rows: number; indices: number[]; sourceWidth?: number; sourceHeight?: number; regions?: SpriteRegion[]; frameSources?: number[]; sourceSizes?: { width: number; height: number }[] }; flipX?: boolean }
export function animationFrameCount(animation: SkinAnimation): number { return animation.atlas?.indices.length ?? animation.frames.length; }
export function animationFrameAt(animation: SkinAnimation, now: number, startedAt = 0): number {
  const count = animationFrameCount(animation), elapsed = Math.floor(Math.max(0, now - startedAt) / 1000 * animation.fps);
  return animation.loop === false ? Math.min(elapsed, count - 1) : elapsed % count;
}
export function animationCellAt(animation: SkinAnimation, frameIndex: number): { frame: string; column: number; row: number } {
  const atlas = animation.atlas, index = frameIndex % animationFrameCount(animation);
  const cell = atlas?.indices[index] ?? 0;
  return { frame: animation.frames[atlas ? (atlas.frameSources?.[cell] ?? 0) : index], column: atlas ? cell % atlas.columns : 0, row: atlas ? Math.floor(cell / atlas.columns) : 0 };
}
export function skinFrameLayout(manifest: Pick<SkinManifest, 'width' | 'height'>, animation: SkinAnimation, frameIndex: number) {
  const atlas = animation.atlas, cell = animationCellAt(animation, frameIndex);
  const sourceIndex = atlas?.frameSources?.[atlas.indices[frameIndex % atlas.indices.length]] ?? 0;
  const source = atlas?.sourceSizes?.[sourceIndex] ?? { width: atlas?.sourceWidth ?? manifest.width * (atlas?.columns ?? 1), height: atlas?.sourceHeight ?? manifest.height * (atlas?.rows ?? 1) };
  const crop = atlas?.regions?.[atlas.indices[frameIndex % atlas.indices.length]] ?? { x: cell.column * manifest.width, y: cell.row * manifest.height, width: manifest.width, height: manifest.height };
  const fit = Math.min(manifest.width / crop.width, manifest.height / crop.height);
  const destination = { x: (manifest.width - crop.width * fit) / 2, y: manifest.height - crop.height * fit, width: crop.width * fit, height: crop.height * fit };
  const image = { left: -crop.x * fit, top: -crop.y * fit, width: source.width * fit, height: source.height * fit };
  return { frame: cell.frame, source, crop, destination, image };
}
export interface SkinManifest { name: string; width: number; height: number; anchor: { x: number; y: number }; animations: Record<string, SkinAnimation>; rig?: import('./rig').RigDefinition }
export interface SkinData { manifest: SkinManifest; baseUrl: string }
export type BubbleMode = 'hidden' | 'quick' | 'panel';
export type QuickView = 'chat' | 'compose' | 'quota';
export type PanelTab = 'chat' | 'settings' | 'history';
export interface AppSnapshot { settings: Settings; assistant: AssistantSnapshot; browserSetup?: BrowserSetupSnapshot; bubbleOpen: boolean; bubbleMode?: BubbleMode; quickView?: QuickView; quickShape?: import('./bubble-shape').QuickBubbleShape; panelTab?: PanelTab; skin: SkinData | null; direction: 'left' | 'right'; motion: 'idle' | 'walking' | 'running'; version: string; animationStartedAt?: number; rigPlayback?: import('./rig').RigPlayback }
export interface AnswerPayload { id: string; answers: Record<string, string[]> }
export type ApprovalDecision = 'allow' | 'deny' | 'stop' | 'session';
export interface PetBridge {
  getState(): Promise<AppSnapshot>;
  onState(listener: (state: AppSnapshot) => void): () => void;
  send(text: string): Promise<void>;
  answer(payload: AnswerPayload): Promise<void>;
  approve(id: string, decision: ApprovalDecision): Promise<void>;
  stop(): Promise<void>;
  newThread(): Promise<void>;
  resumeThread(id: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  chooseFolder(): Promise<string | null>;
  importSkin(): Promise<void>;
  setBubble(open: boolean): Promise<void>;
  setBubbleMode(mode: BubbleMode, tab?: PanelTab): Promise<void>;
  showContextMenu(): Promise<void>;
  resizeQuickBubble(height: number): Promise<void>;
  openQuota(): Promise<void>;
  openComposer(): Promise<void>;
  showReply(): Promise<void>;
  refreshQuota(): Promise<void>;
  drag(dx: number, dy: number): Promise<void>;
  connectBrowser(): Promise<void>;
  detectBrowser(): Promise<BrowserSetupSnapshot>;
  selectBrowserProfile(id: string): Promise<BrowserSetupSnapshot>;
  installBrowserExtension(): Promise<void>;
  reconnect(): Promise<void>;
  login(): Promise<void>;
  cancelLogin(): Promise<void>;
  openExternal(url: string): Promise<void>;
}
declare global { interface Window { pet: PetBridge } }
