import fs from 'node:fs/promises';
import path from 'node:path';
import type { SkinAnimation, SkinData, SkinManifest } from '../shared/types';
import { RIG_ROLES, rigFiles, validateRigImageSize, type RigDefinition } from '../shared/rig';
const imageExtension = /\.(png|webp)$/i;
export function validateRigDefinition(value: unknown): asserts value is RigDefinition {
  const rig = value as RigDefinition;
  if (!rig || rig.version !== 1 || !rig.views || typeof rig.views !== 'object' || Array.isArray(rig.views) || Object.keys(rig.views).some(key => !['front', 'left', 'right'].includes(key))) throw new Error('连续角色需提供版本 1 和正面、左、右三套部件。');
  const validNumber = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  for (const facing of ['front', 'left', 'right'] as const) {
    const view = rig.views[facing];
    if (!view || !Array.isArray(view.layers) || !view.layers.length || view.layers.length > 64) throw new Error('每个角色朝向需提供 1–64 个固定部件。');
    const ids = new Set<string>();
    for (const layer of view.layers) {
      if (!layer || typeof layer.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(layer.id) || ids.has(layer.id) || !RIG_ROLES.includes(layer.role)) throw new Error('角色部件需提供唯一编号及有效动作角色。');
      ids.add(layer.id);
      if (typeof layer.file !== 'string' || !/\.png$/i.test(layer.file)) throw new Error('连续角色部件必须使用固定 PNG 图片。');
      const crop = layer.sourceRegion;
      if (!crop || ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 8192 || crop.y + crop.height > 8192) throw new Error('角色部件的原图裁切区域无效。');
      if (crop.outline !== undefined && (!Array.isArray(crop.outline) || crop.outline.length < 3 || crop.outline.length > 2048 || crop.outline.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || point[0] < 0 || point[1] < 0 || point[0] > crop.width || point[1] > crop.height))) throw new Error('角色部件轮廓需位于原图裁切区域内。');
      if (!validNumber(layer.width, .01, 4096) || !validNumber(layer.height, .01, 4096) || !validNumber(layer.x, -8192, 8192) || !validNumber(layer.y, -8192, 8192) || !layer.pivot || !validNumber(layer.pivot.x, -8192, 8192) || !validNumber(layer.pivot.y, -8192, 8192) || !Number.isInteger(layer.z) || Math.abs(layer.z) > 1000) throw new Error('角色部件的尺寸、枢轴或图层顺序无效。');
      if (layer.rotation !== undefined && !validNumber(layer.rotation, -3600, 3600) || layer.scaleX !== undefined && !validNumber(layer.scaleX, .001, 10) || layer.scaleY !== undefined && !validNumber(layer.scaleY, .001, 10) || layer.opacity !== undefined && !validNumber(layer.opacity, 0, 1)) throw new Error('角色部件的旋转、缩放或透明度无效。');
      if (layer.parent !== undefined && (typeof layer.parent !== 'string' || !layer.parent)) throw new Error('角色骨骼的父层编号无效。');
    }
    const layers = new Map(view.layers.map(layer => [layer.id, layer]));
    for (const layer of view.layers) {
      const seen = new Set([layer.id]); let current = layer;
      while (current.parent) {
        if (seen.has(current.parent)) throw new Error('角色骨骼层级存在循环。');
        seen.add(current.parent);
        const parent = layers.get(current.parent);
        if (!parent) throw new Error(`角色骨骼父层 ${current.parent} 不存在。`);
        current = parent;
      }
    }
  }
  if (rig.timing !== undefined) {
    if (!rig.timing || typeof rig.timing !== 'object' || Array.isArray(rig.timing)) throw new Error('角色动作时间配置无效。');
    for (const key of ['walkMs', 'runMs', 'breathMs', 'transitionMs'] as const) {
      const number = rig.timing[key];
      if (number !== undefined && !validNumber(number, key === 'transitionMs' ? 0 : 500, key === 'transitionMs' ? 3000 : 30000)) throw new Error('角色动作周期需提供有效毫秒数。');
    }
  }
  if (rig.gait !== undefined && (!rig.gait || !validNumber(rig.gait.stride, 1, 200) || !validNumber(rig.gait.footLift, 0, 100) || !validNumber(rig.gait.hipDrop, 0, 50))) throw new Error('角色步幅、抬脚及髋部补偿配置无效。');
}
export function validateSkinImageSize(manifest: SkinManifest, animation: SkinAnimation, frame: string, size: { width: number; height: number }) {
  const width = manifest.width * (animation.atlas?.columns ?? 1), height = manifest.height * (animation.atlas?.rows ?? 1);
  if (animation.atlas) {
    if (animation.atlas.regions) {
      const expected = animation.atlas.sourceSizes?.[animation.frames.indexOf(frame)] ?? { width: animation.atlas.sourceWidth, height: animation.atlas.sourceHeight };
      if (size.width !== expected.width || size.height !== expected.height) throw new Error(`图集 ${frame} 的实际尺寸必须与配置的原图尺寸一致。`);
      return;
    }
    if (size.width < 1 || size.height < 1 || size.width > 8192 || size.height > 8192 || Math.abs((size.width / size.height) / (width / height) - 1) > .01) throw new Error(`图集 ${frame} 的宽高比例必须与 ${width} × ${height} 的逻辑画布一致（误差不超过 1%），总宽高不能超过 8192 像素。`);
    return;
  }
  if (size.width !== width || size.height !== height) throw new Error(`动作图片 ${frame} 的尺寸必须为 ${width} × ${height} 像素。`);
}
export async function loadSkin(manifestPath: string): Promise<SkinData> {
  const stat = await fs.stat(manifestPath);
  if (stat.size > 1024 * 1024) throw new Error('角色配置过大。');
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as SkinManifest;
  if (!raw || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 100 || !Number.isInteger(raw.width) || !Number.isInteger(raw.height) || raw.width < 16 || raw.height < 16 || raw.width > 2048 || raw.height > 2048) throw new Error('角色配置需要名称与有效的画布尺寸（16–2048）。');
  if (!raw.anchor || !Number.isFinite(raw.anchor.x) || !Number.isFinite(raw.anchor.y) || raw.anchor.x < 0 || raw.anchor.x > raw.width || raw.anchor.y < 0 || raw.anchor.y > raw.height) throw new Error('角色落脚点超出画布。');
  const possibleRig = (raw as SkinManifest & { rig?: unknown }).rig;
  if (possibleRig !== undefined) {
    validateRigDefinition(possibleRig);
    const root = await fs.realpath(path.dirname(manifestPath));
    for (const file of rigFiles(possibleRig)) {
      if (path.isAbsolute(file) || file.includes('\\') || file.includes(':') || file.includes('%') || file.split('/').some(part => part === '..' || part === '.')) throw new Error('角色部件必须使用素材文件夹内的 PNG 相对路径。');
      const real = await fs.realpath(path.join(root, file)), relative = path.relative(root, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('角色部件不能链接到素材文件夹之外。');
      if ((await fs.stat(real)).size > 16 * 1024 * 1024) throw new Error('单张角色部件图片不能超过 16 MB。');
      const handle = await fs.open(real, 'r'), header = Buffer.alloc(24);
      try {
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (bytesRead < 24 || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || header.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`角色部件图片 ${file} 不是有效 PNG。`);
        validateRigImageSize(possibleRig, file, { width: header.readUInt32BE(16), height: header.readUInt32BE(20) });
      } finally { await handle.close(); }
    }
    raw.animations ??= {};
    return { manifest: raw, baseUrl: 'pet-skin://asset/' };
  }
  if (!raw.animations || typeof raw.animations !== 'object' || Array.isArray(raw.animations) || !raw.animations.idle) throw new Error('角色素材必须提供 idle 待机动作。');
  const root = await fs.realpath(path.dirname(manifestPath));
  if (Object.keys(raw.animations).length > 40) throw new Error('动作数量过多。');
  for (const animation of Object.values(raw.animations)) {
    if (!animation || !Array.isArray(animation.frames) || !animation.frames.length || animation.frames.length > 120 || !Number.isFinite(animation.fps) || animation.fps < 1 || animation.fps > 60) throw new Error('每个动作需提供 1–120 帧图片及 1–60 的播放帧率。');
    if (animation.loop !== undefined && typeof animation.loop !== 'boolean' || animation.flipX !== undefined && typeof animation.flipX !== 'boolean') throw new Error('动作循环与左右翻转设置必须为布尔值。');
    if (animation.atlas !== undefined) {
      const atlas = animation.atlas;
      if (!atlas || !Number.isInteger(atlas.columns) || !Number.isInteger(atlas.rows) || atlas.columns < 1 || atlas.rows < 1 || atlas.columns > 16 || atlas.rows > 16 || atlas.columns * atlas.rows > 120 || !Array.isArray(atlas.indices) || atlas.indices.length < 1 || atlas.indices.length > 120 || atlas.indices.some(i => !Number.isInteger(i) || i < 0 || i >= atlas.columns * atlas.rows)) throw new Error('图集需提供有效网格和 1–120 个格子编号。');
      if (atlas.frameSources !== undefined) {
        if (!atlas.regions || !Array.isArray(atlas.frameSources) || atlas.frameSources.length !== atlas.columns * atlas.rows || atlas.frameSources.some(index => !Number.isInteger(index) || index < 0 || index >= animation.frames.length)) throw new Error('多图集需为每个裁切区域指定有效的图片编号。');
      } else if (animation.frames.length !== 1) throw new Error('多张图集图片需提供 frameSources 映射。');
      if (atlas.sourceSizes !== undefined && (!atlas.frameSources || !Array.isArray(atlas.sourceSizes) || atlas.sourceSizes.length !== animation.frames.length || atlas.sourceSizes.some(size => !size || ![size.width, size.height].every(n => Number.isInteger(n) && n >= 1 && n <= 8192)))) throw new Error('每张源图需提供 1–8192 像素的真实宽高。');
      if (raw.width * atlas.columns > 8192 || raw.height * atlas.rows > 8192) throw new Error('图集的总宽高不能超过 8192 像素。');
      if (atlas.regions !== undefined || atlas.sourceWidth !== undefined || atlas.sourceHeight !== undefined) {
        if (!Number.isInteger(atlas.sourceWidth) || !Number.isInteger(atlas.sourceHeight) || atlas.sourceWidth! < 1 || atlas.sourceHeight! < 1 || atlas.sourceWidth! > 8192 || atlas.sourceHeight! > 8192 || !Array.isArray(atlas.regions) || atlas.regions.length !== atlas.columns * atlas.rows) throw new Error('自定义图集区域需提供完整格子列表及 1–8192 像素的原图尺寸。');
        if (atlas.regions.some((region, index) => { const size = atlas.sourceSizes?.[atlas.frameSources?.[index] ?? 0] ?? { width: atlas.sourceWidth!, height: atlas.sourceHeight! }; return !region || ![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > size.width || region.y + region.height > size.height; })) throw new Error('图集裁切区域必须完整位于原图内。');
        if (atlas.regions.some(region => region.outline !== undefined && (!Array.isArray(region.outline) || region.outline.length < 3 || region.outline.length > 2048 || region.outline.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || point[0] < 0 || point[0] > region.width || point[1] < 0 || point[1] > region.height)))) throw new Error('角色轮廓需提供裁切区内的 3–2048 个有效坐标点。');
      }
    }
    for (const frame of animation.frames) {
      if (typeof frame !== 'string' || !imageExtension.test(frame) || path.isAbsolute(frame) || frame.includes('\\') || frame.includes(':') || frame.includes('%') || frame.split('/').some(p => p === '..' || p === '.')) throw new Error('动作图片必须是角色文件夹内的 PNG/WebP 相对路径。');
      const real = await fs.realpath(path.join(root, frame));
      const relative = path.relative(root, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('角色图片不能链接到素材文件夹之外。');
      if ((await fs.stat(real)).size > 16 * 1024 * 1024) throw new Error('单张图片不能超过 16 MB。');
    }
  }
  return { manifest: raw, baseUrl: 'pet-skin://asset/' };
}
