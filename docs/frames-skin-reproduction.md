# 默认逐帧素材的可复现构建

默认皮肤位于 `assets/skins/silver-dragon-frames/`，包含待机与思考两张 6×4 图集、对应48张272×272透明PNG及 `provenance.json`。每个动作24播放帧、12fps、2秒循环。思考使用20张来源图及4帧持姿重复。

普通 `npm run build` 和 `npm test` 直接使用仓库里的素材，不需要 Chrome、FFmpeg，也不需要先生成任何导出包。

## 已保存的输入

- 待机原图：`assets/animation-redraw-v1/raw/idle-extracted-v1.png`，由 ImageGen 按外观参考提取透明角色。
- 待机配方：`assets/animation-redraw-v1/review/idle-source-rects.json`，保存24个完整人物裁框、整数位置和全动作统一的0.96比例。
- 思考选帧：`assets/animation-redraw-v1/selected/thinking/frame-01.png` 至 `frame-24.png`，按已审定播放顺序保存原始字节，包含持姿重复。
- 思考选帧说明：同目录 `selection.json`，保存每帧SHA-256、原图帧号与编排记录位置。
- 外观参考：`assets/animation-redraw-v1/references/appearance-master.png`。

上述输入均应随代码提交。生成器、默认皮肤的来源记录和合同测试直接引用这些文件；临时导出目录不是构建输入。

## 重建素材

重建素材需要安装 Chrome 和 FFmpeg。先在独立目录验证，避免覆盖当前素材：

```powershell
node scripts/create-frames-skin.mjs --output .local/frames-skin-rebuild
```

默认使用已安装的 Chrome（Playwright `chrome` 通道）及PATH上的 `ffmpeg`。可以显式指定工具：

```powershell
node scripts/create-frames-skin.mjs --output .local/frames-skin-rebuild --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe" --ffmpeg "D:\Tools\ffmpeg.exe"
```

工具路径也可通过环境变量设置，优先级为命令行、项目环境变量、通用环境变量、默认值：

| 工具 | 项目环境变量 | 通用环境变量 | 默认值 |
| --- | --- | --- | --- |
| Chrome可执行文件 | `DRAGON_PET_CHROME` | `CHROME_PATH` | 使用通道 |
| Chrome通道 | `DRAGON_PET_CHROME_CHANNEL` | — | `chrome` |
| FFmpeg | `DRAGON_PET_FFMPEG` | `FFMPEG_PATH` | `ffmpeg` |

`--chrome-channel` 可覆盖通道；设置可执行文件后优先使用该文件。工具参数只启动本地程序，不会自动下载浏览器或编码器。

省略 `--output` 会写回默认皮肤目录。`--idle`、`--idle-directory`、`--idle-source-rects` 和 `--thinking-directory` 供后续更换经过审查的输入使用；当前配方无需这些参数。

## 核验与预览

```powershell
npx tsx --test tests/bundled-skin.test.ts
node scripts/preview-frames-skin.mjs --skin .local/frames-skin-rebuild --output .local/frames-skin-rebuild-preview
```

预览脚本支持同样的 Chrome参数和环境变量。合同测试用Node解码PNG，逐像素核对两张图集与48张选帧，校验透明度、来源字节、持姿数量及待机配方。

重新编码的PNG压缩字节可能随工具版本变化。本次本机核验重建的两张图集、48帧和皮肤配置，字节均与现有素材一致；需要完全相同的文件时，应比较 `provenance.json` 的SHA-256并保留已提交的素材。
