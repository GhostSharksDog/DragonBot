# 完整角色重绘工作记录

用户外观基准保存在 `references/appearance-master.png`，第二张仅为动作参考。`raw/` 与 `prompts/` 保留本轮全部生成及返修，未覆盖原图；所选思考稿为 `thinking-v5-alpha.png`，所选跑步检查稿为 `running-left-v3-alpha.png`。生成使用内置 ImageGen。

当前桌宠默认待机与思考素材位于 `assets/skins/silver-dragon-frames/`。思考的24播放帧按原字节保存在 `selected/thinking/`，包含20张来源图与4帧持姿；待机沿用第一张外观参考的透明提取稿，完整人物裁框和统一0.96比例记录于 `review/idle-source-rects.json`。这两项的生成与测试不依赖临时导出目录。

跑步仍属于检查稿，几何检查通过不代表动作通过。旧可播放检查包及其质量说明属于导出结果，不是默认皮肤构建输入。

默认素材的重建、工具路径参数及核验说明见 [默认逐帧素材的可复现构建](../../docs/frames-skin-reproduction.md)。

`review/order.json` 是1-based完整帧编排；`review/translations.json` 只对整帧作整数平移；`review/source-rects-v3.json` 保全跑步完整人物再放到统一画布，不缩放或拼身体。几何检查通过不等于绘画动作通过。

可重新导出：

```powershell
node scripts/export-redraw-sequences.mjs --thinking assets/animation-redraw-v1/raw/thinking-v5-alpha.png --running-left assets/animation-redraw-v1/raw/running-left-v3-alpha.png --order assets/animation-redraw-v1/review/order.json --offsets assets/animation-redraw-v1/review/translations.json --source-rects assets/animation-redraw-v1/review/source-rects-v3.json --out .local/reexport-review
```

详细处理规则见 `scripts/export-redraw-sequences.README.md`。已拒绝的原稿保留供复核，不能把其版本号当作已验收。
