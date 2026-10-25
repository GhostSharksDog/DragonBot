# 完整角色重绘工作记录

用户外观基准保存在 `references/appearance-master.png`，第二张仅为动作参考。`raw/` 与 `prompts/` 保留本轮全部生成及返修，未覆盖原图；所选思考稿为 `thinking-v5-alpha.png`，所选跑步检查稿为 `running-left-v3-alpha.png`。生成使用内置 ImageGen。

最终可播放检查包位于 `release/animation-redraw-v1/`，其中 `README.md`、`quality-status.json` 明确记录仍未达标的动作与一致性问题。它不是已经通过流畅慢跑验收的最终角色皮肤，也未替换进桌宠。

`review/order.json` 是1-based完整帧编排；`review/translations.json` 只对整帧作整数平移；`review/source-rects-v3.json` 保全跑步完整人物再放到统一画布，不缩放或拼身体。几何检查通过不等于绘画动作通过。

可重新导出：

```powershell
node scripts/export-redraw-sequences.mjs --thinking assets/animation-redraw-v1/raw/thinking-v5-alpha.png --running-left assets/animation-redraw-v1/raw/running-left-v3-alpha.png --order assets/animation-redraw-v1/review/order.json --offsets assets/animation-redraw-v1/review/translations.json --source-rects assets/animation-redraw-v1/review/source-rects-v3.json --out .local/reexport-review
```

详细处理规则见 `scripts/export-redraw-sequences.README.md`。已拒绝的原稿保留供复核，不能把其版本号当作已验收。
