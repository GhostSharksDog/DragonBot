# Windows 逐帧版安装包检查

默认检查 `release/win-unpacked/龙娘桌宠.exe`、项目当前版本及 `银白龙娘 · 逐帧`。当前默认素材路径为 `assets/skins/silver-dragon-frames/skin.json`。只在根代理通知新包已完成后运行；包测试期间不要并发运行其他真实Codex探测。

先做无推理包检查，确认两窗口、透明角色载入、默认frames素材、idle/thinking各24个**播放帧**和打包浏览器工具。重复持姿或重复源文件是合法播放帧，不按24个不同图像判断。

```powershell
node scripts/verify-package.mjs
```

如需只读连接探测可加 `--backend --codex-home C:/Users/LCY/.codex --expect-signed-in`；不要为了本轮动画测试加 `--turn`，以免与下一步重复推理。

实际动画验收只发送一条普通聊天，经真实renderer→preload→IPC→Codex。复用现有登录，禁止启动登录；没有文件/网站授权，不回答或批准任何意外请求。隔离 `DRAGON_PET_DATA_DIR` 到项目 `.local/animation-installed-check-*`，创建自己的新Codex线程，不更改已有线程。测试前后校验本机Codex config和既有桌宠settings/chat-history的哈希，不读取或输出凭据。

```powershell
node scripts/verify-animation-installed.mjs `
  --codex-home C:/Users/LCY/.codex `
  --expected-version 0.4.1
```

实际用户环境需通过外沙箱执行授权，防止沙箱用户的空配置产生假结论。测试使用项目独立data，不覆盖当前用户安装的记录。可用 `--executable` 指向另一个明确要验证的EXE，用 `--protected-data-dir` 指定需保持不变的原有桌宠数据目录。

测试保留真实renderer的 `data-animation`、`data-frame`、实际源图URL与加载状态，支持img或Canvas，并截图idle→thinking→idle及回复。只要求播放索引前进，不要求持姿帧的像素每帧变化。新默认没有走跑素材时，保持roaming=true偏好并验证窗口位置稳定，鼠标拖动仍能移动。证据与截图写在隔离目录的result.json旁；quota重试只等待当前turn，不发起额外聊天。

旧的 `scripts/verify-installed-ui.mjs` 保留两题逐题回答、恢复草稿、拒绝/允许精确测试文件覆盖与原生右键菜单检查。本轮优先新动画，未运行这些额外推理回合；需要完整功能回归时再单独运行。

真实安装位置经只读注册表与app.asar/package.json确认是 `E:/DragonBot/dragon-pet`，检查当时应用版本为0.3.0、没有运行进程。EXE资源版本45.0.0是Electron运行时版本，不能当作应用版本。更新安装由根代理在新包验证后处理，测试脚本不安装或删除用户软件。
