import type { RigPose } from './rig';

export type RigTextures = ReadonlyMap<string, CanvasImageSource>;
export interface RigViewTransform { scale?: number; x?: number; y?: number }
/** Draw a sampled pose at an explicit time; also used by deterministic exports. */
export function drawRigPose(context: CanvasRenderingContext2D, pose: RigPose, textures: RigTextures, view: RigViewTransform = {}): void {
  context.save();
  context.translate(view.x ?? 0, view.y ?? 0); context.scale(view.scale ?? 1, view.scale ?? 1);
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  for (const layer of pose.layers) {
    const image = textures.get(layer.file);
    if (!image || layer.opacity <= .001) continue;
    context.save(); context.transform(...layer.matrix); context.globalAlpha *= layer.opacity;
    const region = layer.sourceRegion;
    if (region.outline?.length) {
      context.beginPath();
      for (let i = 0; i < region.outline.length; i++) {
        const [x, y] = region.outline[i], px = x / region.width * layer.width, py = y / region.height * layer.height;
        i === 0 ? context.moveTo(px, py) : context.lineTo(px, py);
      }
      context.closePath(); context.clip('evenodd');
    }
    context.drawImage(image, region.x, region.y, region.width, region.height, 0, 0, layer.width, layer.height);
    context.restore();
  }
  context.restore();
}
