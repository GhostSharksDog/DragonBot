# 角色动作素材

内置银白龙娘保留银白长发、淡紫配色、龙角、翅膀、白裙与鳞片尾巴。0.4.1 默认素材位于 `assets/skins/silver-dragon-frames`，以完整人物逐帧播放待机和思考。旧版 `silver-dragon` 逐帧素材、`silver-dragon-rig` 分层素材仍可导入。

默认待机和思考均为24个播放帧、12fps。未提供的动作使用 `idle`，时钟按实际播放动作切换；聊天流式更新不会重置同一动作。运行前会预解码所选皮肤全部图片。没有左右 `walking` 或左右 `running` 完整动作对的逐帧皮肤保持原地，拖放和缩放仍可使用；有完整动作对时自动漫游才会启用。

## 连续分层角色（0.4.0）

`skin.json` 保留 `name`、`width`、`height`、`anchor`，增加 `rig`。`rig.version` 为 `1`；`rig.views` 必须包含 `front`、`left`、`right`，每套 `layers` 提供 1–64 个部件。纯分层皮肤的 `animations` 可设为空对象。完整示例见内置 `silver-dragon-rig/skin.json`，可运行 `node scripts/create-rig-skin.mjs` 重建。

每层通过 `file` 和 `sourceRegion` 引用素材目录内固定 PNG，使用 `width`、`height` 设置逻辑大小。`id` 在朝向内唯一，`parent` 指向同朝向的父层，`z` 决定绘制顺序；父层可以写在子层之后，但不能形成循环。`pivot` 是部件自己的旋转中心，`x/y` 是该中心在父层未变换的左上角坐标系内的位置，根层直接使用逻辑画布坐标。可选 `rotation` 使用角度，`scaleX/scaleY` 为正比例，`opacity` 为 0–1。

`role` 选择动作曲线：`body`、`head`、`skirt`、`hair-front/hair-back`、`arm-left/arm-right`、`forearm-left/forearm-right`、`leg-left/leg-right`、`calf-left/calf-right`、`foot-left/foot-right`、`wing-left/wing-right`、`tail`、`eyes`、`mouth`、`static`。`static` 部件仍跟随父层。关节纹理应有重叠，眼睛独立于眉毛，避免眨眼时眉毛一起压缩。三个朝向分别使用固定图片，不通过整张翻转更换服饰方向。

`rig.timing` 可设置 `walkMs`、`runMs`、`breathMs` 和 `transitionMs`。默认皮肤统一慢跑周期 1800ms，切换过渡 250ms。运行时约 60Hz 按父子关节矩阵绘制，透明点击检测也使用同一姿态、裁切轮廓和 PNG 的真实透明度。`sourceRegion.outline` 可选用凹多边形，坐标相对裁切区域；裁切只在绘制时执行，保留生成的 PNG 原图。

新增部件或修改比例后，应在浅色、深色与不同尺寸下观察完整循环和转向，检查关节遮盖、落脚点与外轮廓。不要通过独立重画每一帧改变角色纹理。

每帧使用相同尺寸的透明 PNG 或 WebP，身体比例和落脚点一致。图片放在 JSON 所在文件夹内，不能引用上级目录、外部链接或指向目录外的链接。每张图片不能超过 16 MB。

## 单帧图片

```json
{
  "name": "龙娘",
  "width": 512,
  "height": 640,
  "anchor": { "x": 256, "y": 620 },
  "animations": {
    "idle": { "fps": 8, "loop": true, "frames": ["idle/01.png", "idle/02.png"] },
    "walking-left": { "fps": 10, "loop": true, "frames": ["walk-left/01.png", "walk-left/02.png"] },
    "walking-right": { "fps": 10, "loop": true, "frames": ["walk-right/01.png", "walk-right/02.png"] }
  }
}
```

动作名：`idle`、`walking-left`、`walking-right`、`running-left`、`running-right`、`speaking`、`thinking`、`awaiting-input`、`awaiting-approval`、`success`、`error`。缺少动作时使用 `idle`；`idle` 必须提供。

`anchor` 是图片中的落脚点，程序将它对齐到角色窗口底部中间。每个动作允许 1–120 帧、1–60 fps，画布尺寸 16–2048 像素。单帧图片的实际尺寸须与 `width`、`height` 相同。循环动作建议 8–12 fps；`success`、`error` 可以设置 `loop: false`，播放到最后一帧后停住。`flipX: true` 可将整个动作左右翻转。

## 网格图集

同一张透明图片可包含多个等大的格子。`frames` 此时只能放一张图，`atlas` 指定网格及播放顺序；格子从左上角开始，按行从 0 编号。`width`、`height` 和 `anchor` 仍表示单个格子的逻辑尺寸。下面的动作播放四行图集中第一行的四格：

```json
{
  "name": "银白龙娘",
  "width": 384,
  "height": 384,
  "anchor": { "x": 192, "y": 368 },
  "animations": {
    "idle": {
      "frames": ["front.png"],
      "fps": 4,
      "loop": true,
      "atlas": { "columns": 4, "rows": 4, "indices": [0, 1, 2, 3] }
    },
    "speaking": {
      "frames": ["front.png"],
      "fps": 6,
      "atlas": { "columns": 4, "rows": 4, "indices": [4, 5, 6, 7] }
    }
  }
}
```

每行和每列各允许 1–16 格，格子总数不超过 120；每个动作播放序列允许 1–120 个有效编号，可以重复编号来延长某帧。逻辑图集的总宽高与实际图片总宽高都不能超过 8192 像素；实际图片可采用不同分辨率，宽高比例须与逻辑图集一致，误差不超过 1%。原有单帧格式可继续使用。

## 不等距裁切

生成的动作图集可能出现不等距行列。此时在 `atlas` 中同时提供实际图片的 `sourceWidth`、`sourceHeight` 和 `regions`，使用源图像素坐标指定每个动作格的完整矩形。`regions` 的数量必须等于 `columns × rows`，`indices` 仍选择对应编号。矩形须完整落在源图内；源图实际尺寸须与声明一致，最大为 8192 × 8192。

```json
{
  "columns": 1,
  "rows": 1,
  "indices": [0],
  "sourceWidth": 1600,
  "sourceHeight": 1600,
  "regions": [{ "x": 25, "y": 50, "width": 300, "height": 400 }]
}
```

程序将完整裁切区等比缩放，在逻辑画布内居中并对齐底部；桌面角色、气泡预览和透明区域点击检测使用同一布局。应把角、头发、裙摆、脚和尾巴都留在矩形内，避免按整齐网格切断角色。

验收时检查透明边缘、循环接缝、角色比例、每格的落脚点与左右朝向。导入后可在设置里调节显示大小。
