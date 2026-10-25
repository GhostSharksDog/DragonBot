import { useEffect, useRef } from 'react';
import type { SkinData } from '../shared/types';
import { animationFrameAt, skinFrameLayout, skinRegionClipPath } from '../shared/types';

interface FrameSpriteProps {
  skin: SkinData;
  animationKey: string;
  startedAt?: number;
  width: number;
  height: number;
  onError?: (message: string) => void;
}

/** Holds decoded source images and swaps complete images atomically; React does not animate frames. */
export function FrameSprite(props: FrameSpriteProps) {
  const host = useRef<HTMLDivElement>(null), logical = useRef<HTMLDivElement>(null), crop = useRef<HTMLDivElement>(null);
  const latest = useRef(props); latest.current = props;
  const decoded = useRef(new Map<string, Promise<HTMLImageElement>>()), cacheBase = useRef('');
  const fallbackClock = useRef({ key: '', startedAt: 0 });
  const decodeCount = useRef(0), renderCount = useRef(0), generation = useRef(0);
  // IPC snapshots clone their objects. A value signature preserves textures and playback.
  const signature = JSON.stringify({ baseUrl: props.skin.baseUrl, manifest: props.skin.manifest });
  const latestSignature = useRef(signature); latestSignature.current = signature;
  useEffect(() => {
    const element = host.current, cell = logical.current, region = crop.current;
    if (!element || !cell || !region) return;
    const { skin } = latest.current, base = skin.baseUrl.endsWith('/') ? skin.baseUrl : `${skin.baseUrl}/`;
    if (cacheBase.current !== base) { decoded.current = new Map(); cacheBase.current = base; }
    const currentGeneration = ++generation.current;
    element.dataset.ready = 'false';
    element.dataset.preloadGeneration = String(currentGeneration);
    let cancelled = false, scheduled = 0, lastRender = '';
    const files = [...new Set(Object.values(skin.manifest.animations).flatMap(animation => animation.frames))];
    const images = new Map<string, HTMLImageElement>();
    const decode = (file: string) => {
      const url = new URL(file, base).href;
      let pending = decoded.current.get(url);
      if (!pending) {
        ++decodeCount.current;
        const image = new Image(); image.decoding = 'async'; image.draggable = false;
        image.src = url;
        pending = image.decode().then(() => image);
        decoded.current.set(url, pending);
      }
      return pending;
    };
    void Promise.all(files.map(async file => { images.set(file, await decode(file)); })).then(() => {
      if (cancelled) return;
      element.dataset.decodeCount = String(decodeCount.current);
      element.dataset.sourceCount = String(files.length);
      const render = () => {
        if (cancelled) return;
        if (latestSignature.current !== signature) { scheduled = window.requestAnimationFrame(render); return; }
        const current = latest.current, manifest = current.skin.manifest;
        const animation = manifest.animations[current.animationKey] ?? manifest.animations.idle;
        const clockKey = `${base}\0${current.animationKey}\0${JSON.stringify(animation)}`;
        if (fallbackClock.current.key !== clockKey) fallbackClock.current = { key: clockKey, startedAt: Date.now() };
        const startedAt = typeof current.startedAt === 'number' && Number.isFinite(current.startedAt) ? current.startedAt : fallbackClock.current.startedAt;
        const now = Date.now(), frame = animationFrameAt(animation, now, startedAt);
        const layout = skinFrameLayout(manifest, animation, frame), image = images.get(layout.frame);
        if (!image) { latest.current.onError?.('角色动作缺少已解码图片。'); return; }
        const key = `${current.animationKey}/${frame}/${current.width}/${current.height}/${startedAt}`;
        if (key !== lastRender) {
          lastRender = key;
          const scale = Math.min(current.width / manifest.width, (current.height - 24) / manifest.height);
          Object.assign(cell.style, { width: `${manifest.width * scale}px`, height: `${manifest.height * scale}px`, left: `${current.width / 2 - manifest.anchor.x * scale}px`, top: `${current.height - 8 - manifest.anchor.y * scale}px`, transform: animation.flipX ? 'scaleX(-1)' : '' });
          Object.assign(region.style, { left: `${layout.destination.x * scale}px`, top: `${layout.destination.y * scale}px`, width: `${layout.destination.width * scale}px`, height: `${layout.destination.height * scale}px`, clipPath: skinRegionClipPath(layout.crop) ?? '' });
          image.className = 'pet-sprite'; image.alt = manifest.name;
          Object.assign(image.style, { width: `${layout.image.width * scale}px`, height: `${layout.image.height * scale}px`, left: `${layout.image.left * scale}px`, top: `${layout.image.top * scale}px` });
          const diagnostic = { animation: current.animationKey, frame: String(frame), source: image.src, src: image.src, ready: 'true', epoch: String(startedAt), time: String(Math.max(0, now - startedAt)), renderCount: String(++renderCount.current), decodeCount: String(decodeCount.current), sourceCount: String(files.length) };
          Object.assign(image.dataset, diagnostic); Object.assign(element.dataset, diagnostic);
          // Moving an already decoded element avoids a transient empty src/undecoded frame.
          if (region.firstElementChild !== image) region.replaceChildren(image);
        }
        scheduled = window.requestAnimationFrame(render);
      };
      render();
    }).catch(error => { if (!cancelled) latest.current.onError?.(`角色图片加载失败：${error instanceof Error ? error.message : String(error)}`); });
    // Keep the previous complete picture visible while a genuinely new skin decodes.
    return () => { cancelled = true; window.cancelAnimationFrame(scheduled); };
  }, [signature]);
  return <div ref={host} className="sprite-canvas" data-ready="false"><div ref={logical} style={{ position: 'absolute', overflow: 'hidden' }}><div ref={crop} style={{ position: 'absolute', overflow: 'hidden' }} /></div></div>;
}
