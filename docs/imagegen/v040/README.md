# 0.4.0 固定部件素材

外观依据 `assets/reference/dragon-girl-three-view.png`。使用内置 ImageGen 编辑和生成固定部件图集；每个朝向仅复用一套部件，不生成独立的全身动作帧。

选用源图：`parts-front-v2.png`、`parts-left-v1.png`、`parts-right-v1.png`，均保存在 `assets/skins/silver-dragon-rig/`。初版正面和所有提示文件也保留供复查。图集按 4×4 放置头发、头、躯干、裙摆、左右臂、左右大腿、小腿与鞋、左右翼、尾巴、眼、嘴和前发。

`front-prompt.json`、`front-cleanup-prompt.json`、`left-prompt.json`、`right-prompt.json` 保存实际提交的提示。`parts-geometry.json` 记录源图 SHA-256、尺寸、部件裁切与运行时轮廓，包含独立眉毛的位置。透明轮廓在绘制时过滤部件外的残余噪点，不改写生成的 PNG。

`scripts/inspect-rig-parts.mjs` 读取透明度并检查轮廓；`scripts/create-rig-skin.mjs` 建立部件层级；`src/shared/rig.ts` 和 `render-rig.ts` 为桌宠、透明区域检测及动画导出共享的姿态来源。`scripts/preview-rig.mjs` 渲染三朝向校准图，`scripts/export-rig-previews.mjs` 输出 GIF/WebP 和源图未改动的校验报告。
