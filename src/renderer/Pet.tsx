import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot } from '../shared/types';
import { effectiveAnimationKey } from '../shared/animation-state';
import { petChatLauncherRect } from '../shared/pet-chat-launcher';
import { Egg, Icon } from './icons';
import { RigCanvas } from './RigCanvas';
import { FrameSprite } from './FrameSprite';
import { PetClickController } from './pet-click-controller';

export const activityLabels: Record<AppSnapshot['assistant']['activity'], string> = {
  idle: '在这里，随时叫我', walking: '慢跑中', running: '慢跑中', thinking: '正在想办法…', speaking: '正在回复你…', 'awaiting-input': '有件事想问你', 'awaiting-approval': '需要你的批准', success: '已经完成啦', error: '需要处理一下',
};

export function Pet({ snapshot }: { snapshot: AppSnapshot | null }) {
  const latest = useRef(snapshot); latest.current = snapshot;
  const gesture = useRef<PetClickController | null>(null);
  const delta = useRef({ x: 0, y: 0 });
  const moving = useRef(false);
  const rigStarted = useRef(Date.now());
  const [error, setError] = useState(false);
  const [failedFrame, setFailedFrame] = useState(false);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const activity = snapshot?.assistant.activity ?? 'idle';
  const state = activity === 'idle' ? snapshot?.motion ?? 'idle' : activity;
  const skin = snapshot?.skin;
  const name = effectiveAnimationKey(skin?.manifest, activity, snapshot?.motion ?? 'idle', snapshot?.direction ?? 'right');
  const spriteScale = skin ? Math.min(viewport.width / skin.manifest.width, (viewport.height - 24) / skin.manifest.height) : 1;
  useEffect(() => { setFailedFrame(false); }, [skin?.baseUrl]);
  const activateReply = () => {
    const current = latest.current;
    const hide = current?.bubbleMode === 'quick' && (current.quickView ?? 'chat') === 'chat';
    void (hide ? window.pet.setBubbleMode('hidden') : window.pet.showReply()).catch(() => setError(true));
  };
  if (!gesture.current) gesture.current = new PetClickController({
    single: activateReply,
    double: () => { void window.pet.openQuota().catch(() => setError(true)); },
    drag: (dx, dy) => { delta.current.x += dx; delta.current.y += dy; void flushDrag(); },
  });
  useEffect(() => () => gesture.current?.cancel(), []);

  async function flushDrag() {
    if (moving.current) return;
    moving.current = true;
    try {
      while (delta.current.x || delta.current.y) {
        const current = delta.current;
        delta.current = { x: 0, y: 0 };
        await window.pet.drag(current.x, current.y);
      }
    } catch { setError(true); delta.current = { x: 0, y: 0 }; }
    finally { moving.current = false; }
  }

  const launcher = petChatLauncherRect(viewport.width, viewport.height);
  const composeOpen = snapshot?.bubbleMode === 'quick' && snapshot.quickView === 'compose';
  return <main className={`pet-stage state-${state}`}>
    <button className="pet-button" aria-label="查看龙娘回复；双击查看Codex额度；拖动或按方向键移动桌宠" aria-describedby="pet-status"
      onPointerDown={event => {
        if (event.button !== 0) { gesture.current?.cancel(); return; }
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current?.down({ x: event.screenX, y: event.screenY });
      }}
      onPointerMove={event => {
        gesture.current?.move({ x: event.screenX, y: event.screenY });
      }}
      onPointerUp={event => {
        if (event.button !== 0) return;
        gesture.current?.up({ x: event.screenX, y: event.screenY });
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => gesture.current?.cancel()}
      onLostPointerCapture={() => { if (gesture.current?.pressed) gesture.current.cancel(); }}
      onContextMenu={event => { event.preventDefault(); gesture.current?.cancel(); void window.pet.showContextMenu().catch(() => setError(true)); }}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); gesture.current?.cancel(); if (!event.repeat) activateReply(); }
        const moves: Record<string, [number, number]> = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12] };
        if (moves[event.key]) { event.preventDefault(); gesture.current?.cancel(); void window.pet.drag(...moves[event.key]).catch(() => setError(true)); }
      }}>
      <span id="pet-status" className="sr-only">{failedFrame ? '动画加载失败，请检查素材' : error ? '右键打开完整对话查看状态' : activityLabels[activity]}</span>
      {skin?.manifest.rig && !failedFrame ? <RigCanvas skin={skin} playback={snapshot?.rigPlayback ?? { control: { activity, motion: snapshot?.motion ?? "idle", direction: snapshot?.direction ?? "right" }, startedAt: snapshot?.animationStartedAt ?? rigStarted.current }} width={viewport.width} height={viewport.height} view={{ scale: spriteScale, x: viewport.width / 2 - skin.manifest.anchor.x * spriteScale, y: viewport.height - 8 - skin.manifest.anchor.y * spriteScale }} onError={() => setFailedFrame(true)} /> : skin && !failedFrame ? <FrameSprite skin={skin} animationKey={name} startedAt={snapshot?.animationStartedAt} width={viewport.width} height={viewport.height} onError={() => setFailedFrame(true)} /> : <Egg className="pet-egg" />}
      {(!skin || failedFrame) && <span className="pet-placeholder-label">{failedFrame ? '素材加载失败' : '临时形象'}</span>}
    </button>
    <button className={`pet-chat-launcher${snapshot?.assistant.pending.length ? ' has-pending' : ''}`} style={{ left: launcher.x, top: launcher.y, width: launcher.width, height: launcher.height, borderRadius: launcher.radius }} aria-label="输入消息" aria-pressed={composeOpen}
      onPointerDown={event => { event.stopPropagation(); gesture.current?.cancel(); }}
      onClick={event => { event.stopPropagation(); gesture.current?.cancel(); void window.pet.openComposer().catch(() => setError(true)); }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); gesture.current?.cancel(); void window.pet.showContextMenu().catch(() => setError(true)); }}>
      <Icon name="chat" size={17} />
    </button>
  </main>;
}
