import { useEffect, useRef } from 'react';
import type { SkinData } from '../shared/types';
import { rigFiles, sampleRigPose, type RigPlayback } from '../shared/rig';
import { drawRigPose, type RigViewTransform } from '../shared/render-rig';

export interface RigCanvasProps {
  skin: SkinData;
  playback: RigPlayback;
  width: number;
  height: number;
  view?: RigViewTransform;
  className?: string;
  onReady?: () => void;
  onError?: (message: string) => void;
}
export function RigCanvas({ skin, playback, width, height, view, className, onReady, onError }: RigCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null), renderCount = useRef(0), latest = useRef({ skin, playback, width, height, view, onReady, onError });
  latest.current = { skin, playback, width, height, view, onReady, onError };
  const rig = skin.manifest.rig;
  // IPC snapshots clone objects frequently; identical rig data must not reload
  // textures, reset the clock, or clear the canvas while assistant tokens stream.
  const signature = JSON.stringify({ rig, baseUrl: skin.baseUrl });
  useEffect(() => {
    const element = canvas.current;
    if (!element || !rig) return;
    element.dataset.rigReady = 'false';
    const context = element.getContext('2d', { alpha: true });
    if (!context) { latest.current.onError?.('无法启动角色画布。'); return; }
    let cancelled = false, scheduled = 0;
    const textures = new Map<string, HTMLImageElement>();
    void Promise.all(rigFiles(rig).map(async file => {
      const image = new Image(); image.src = new URL(file, skin.baseUrl.endsWith('/') ? skin.baseUrl : `${skin.baseUrl}/`).href;
      textures.set(file, image); await image.decode();
    })).then(() => {
      if (cancelled) return;
      latest.current.onReady?.();
      const render = () => {
        if (cancelled) return;
        const current = latest.current, manifest = current.skin.manifest;
        const ratio = Math.min(window.devicePixelRatio || 1, 2), w = Math.max(1, Math.round(current.width * ratio)), h = Math.max(1, Math.round(current.height * ratio));
        if (element.width !== w || element.height !== h) { element.width = w; element.height = h; }
        context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, current.width, current.height);
        const scale = Math.min(current.width / manifest.width, current.height / manifest.height);
        const placement = current.view ?? { scale, x: (current.width - manifest.width * scale) / 2, y: current.height - manifest.height * scale };
        const now = Date.now(), pose = sampleRigPose(rig, current.playback, now);
        drawRigPose(context, pose, textures, placement);
        const control = current.playback.control, activity = control.activity === 'idle' ? control.motion : control.activity;
        element.dataset.rigFacing = pose.facing;
        element.dataset.rigLayers = String(pose.layers.length);
        element.dataset.rigAnimation = activity === 'walking' || activity === 'running' ? `${activity}-${control.direction}` : activity;
        element.dataset.rigTime = String(Math.max(0, now - current.playback.startedAt));
        element.dataset.rigRenderCount = String(++renderCount.current);
        element.dataset.rigReady = 'true';
        scheduled = window.requestAnimationFrame(render);
      };
      render();
    }).catch(error => { if (!cancelled) latest.current.onError?.(`角色部件加载失败：${error instanceof Error ? error.message : String(error)}`); });
    return () => { cancelled = true; window.cancelAnimationFrame(scheduled); for (const image of textures.values()) image.src = ''; };
  }, [signature]);
  return <canvas ref={canvas} className={['rig-canvas', className].filter(Boolean).join(' ')} role="img" aria-label={skin.manifest.name} style={{ position: 'absolute', inset: 0, width, height, pointerEvents: 'none' }} />;
}
