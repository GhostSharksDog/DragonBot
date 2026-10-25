# 完整角色动画的机械导出

只读取完整角色源图，不修改原图。使用原生 alpha；没有绿底编码、去背景、去噪、身体拼接或逐帧缩放。右跑只镜像左跑的完整帧。

默认 6×4 源网格，24个播放帧。不能整除时用整数 `floor` 边界分格，所有源格落在同一尺寸画布中，四周共同加 8px 留白。`--scale` 只允许全体共享同一个等比缩放系数；默认1。

```powershell
node scripts/export-redraw-sequences.mjs `
  --thinking assets/animation-redraw-v1/raw/thinking-v5-alpha.png `
  --running-left assets/animation-redraw-v1/raw/running-left-v2-alpha.png `
  --order approved-playback-order.json `
  --offsets approved-translations.json `
  --out .local/review-preview
```

实际动作稿与配置均须另行复核；以上路径示例不代表候选素材已通过。

`--order` 明确使用 **1-based 原图来源帧编号**，每动作24项。省略动作表示使用1到24原顺序；右跑继承左跑顺序。每个重复来源帧的第二次及以后出现，必须为对应输出帧写出重复持姿的说明。以下仅为配置格式示例，未批准：

```json
{
  "approvedByRoot": false,
  "indexBase": 1,
  "reason": "复核后的选帧理由",
  "actions": {
    "thinking": {
      "sourceIndices": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,14,16,17,20,21,18,19,22,23,24],
      "holds": [{"outputFrame":15,"sourceFrame":14,"reason":"用正常持姿替换额外表情帧"}]
    }
  }
}
```

`--offsets` 只接受已经复核的整数纯平移；`frames.thinking` 与 `frames.running-left` 都按**原图来源帧1到24**保存24项 `{x,y}`。先按来源帧应用位移，再按播放表选帧；重复帧使用完全相同的位移。格式为 `{approvedByRoot:true,reason:"...",frames:{thinking:[24项],"running-left":[24项]}}`。

每个来源格先检查 alpha≥128 的最大8连通主体轮廓。主体触源格边界时直接拒绝导出，避免用留白或平移掩盖已经截断的角色；位移也不能把主体移出输出画布。检查不重画或删除任何像素，也不替代对脚部、尾巴、发梢与实际动作的视觉检查。

如果生成器把完整角色画到了格线外，只有经过视觉复核、与原PNG SHA匹配的 `--source-rects` 才可绕过固定格子裁切；不能先裁掉身体再平移。配置使用以下结构（示例未批准，frames必须24项并按原始来源1到24排序）：

```json
{
  "approvedByRoot": false,
  "indexBase": 1,
  "reason": "复核完整角色框与邻居间距的理由",
  "sources": {
    "running-left": {
      "sourceSha256": "完整原PNG的SHA256",
      "frames": [{"sourceRect":{"x":0,"y":0,"width":250,"height":250},"destination":{"x":11,"y":11}}]
    }
  }
}
```

`sourceRect` 是原图绝对整数坐标，`destination` 是共同逻辑画布中最终整数左上角，已经包含留白；同动作禁止再提供offset列表。完整rect必须在原图内，且原尺寸放进共同内容区，四周保留指定padding。源图中24个最大的 alpha≥128、8连通主体会先做标签分析：每rect必须完整包含唯一主体，不包含另一个主体；不同rect的相交区域不能出现alpha≥128前景；主体也不能触原PNG最外边。所有rect必须各对应不同主体，重复持姿通过播放表实现。主体分类与视觉复核共同用于判断邻居，不能把自动分析描述为理解了人体部位。

每输出帧记录实际 `sourceRect`、`destination`、全人平移 `fullCharacterTranslation`、来源索引与后续镜像。变换只作用于完整角色，不拼身体、不改原图、不按帧缩放。

思考 WebP 24帧的83/84ms分配精确合计2000ms；GIF 80/90ms分配同样精确2000ms。跑步 WebP 每帧75ms，GIF 70/80ms交替，均1800ms。三个GIF共享同一固定全局色板，无抖动。所有WebP单帧VP8L与PNG用同一软件解码器核对可见RGBA和完整alpha；最终动画复用这些原块并验证结构和实际浏览器加载。

输出目录包含72张PNG、三个统一图集、GIF/WebP、原样所选源PNG、播放表、位移表、manifest与源SHA、边缘合成检查图、离线200px/400px/深浅/慢放/逐帧预览和ZIP。manifest逐输出帧记录 `sourceFrame`、`sourceIndex0`、`duplicatedHold`、原因与实际来源帧数量，不宣称24个独立姿势。

实际提示词、两张用户参考与poseguide可由交付者复制到输出目录，并用 `README.md` 说明。不会覆盖用户参考或源图。补齐文档后可只重建ZIP，无需重新编码：

```powershell
node scripts/export-redraw-sequences.mjs --zip-only --out release/animation-redraw-v1
```

`--zip-only` 会先校验包内所选源PNG的SHA，再收录输出目录全部普通文件（不包含ZIP自身）。它不会读取登录凭据、修改全局配置、运行桌宠或执行网络操作。
