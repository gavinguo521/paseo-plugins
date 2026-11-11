# paseo-plugins

**简体中文** | [English](README.en.md)

自己写的 [Paseo](https://paseo.sh) 插件，每个子目录一个插件。

| 插件 | 作用 | 安装 |
|---|---|---|
| [`turn-speed`](turn-speed/OVERVIEW.zh-CN.md) | Claude Code / Codex 每轮结束后在对话末尾显示生成速度（tok/s、输出 token、生成耗时、请求次数）。数据取自 daemon 机器上 CLI 自己的会话日志，在本机解析，只保留时间戳和 token 数 | 已上架插件市场：`paseo plugin add 52216108/turn-speed` |
| [`usage-reset`](usage-reset/OVERVIEW.zh-CN.md) | 侧边栏底部每个账户一行，直接显示 Claude / Codex 各账户 5 小时、周限额还剩多少（用量偏快时变色提醒，列表里有分段进度条和日均可用），点开列出具体刷新时刻（如「周二 10/27 21:00 刷新 · 还有 2 天 8 小时」）。只读 Paseo 已拉取的用量报告 | 已上架插件市场：`paseo plugin add 52216108/usage-reset` |
| [`next-input`](next-input/OVERVIEW.zh-CN.md) | 打开会话时按需生成一条下一句建议，默认跟随会话选用 Claude 或 Codex（也可固定其中一个），模型可选；点纸飞机直接发送，点文字可编辑 | 已上架插件市场：`paseo plugin add 52216108/next-input` |
| [`agent-taskboard`](agent-taskboard/OVERVIEW.zh-CN.md) | 在侧边栏打开本机 [agent-taskboard](https://github.com/gavinguo521/agent-taskboard) 看板，需要先在 daemon 主机上启动看板服务 | 从本仓库安装：`paseo plugin add git:gavinguo521/paseo-plugins:agent-taskboard` |
| `live-activity` | 只有服务端：配合原生 iOS App，经 APNs 推送会话状态到灵动岛 / 锁屏；本机计划任务结果支持 Bark 或 APNs；Bark 也可单独开启普通会话完成通知，Mac 系统通知保留。Bark 无需 Apple 开发者密钥，在原生客户端中粘贴地址即可配置。任务通知插件需安装在执行主机。[任务通知说明](live-activity/SCHEDULE_NOTIFICATIONS.md)。推送凭证只保存在 daemon 本机 `~/.paseo/live-activity/`（0600） | 从本仓库安装：`paseo plugin add git:gavinguo521/paseo-plugins:live-activity` |

插件按 daemon 安装，每台机器各装一次；装之前先在 Settings → Plugins 打开 Enable plugins。

2026-10-25 起 turn-speed 的来源从 paseo-mesh 仓库搬到本仓库。之前装过的机器运行 `paseo plugin update` 会提示来源已变更，需要重装一次：`paseo plugin remove turn-speed && paseo plugin add 52216108/turn-speed`。

## 从本地目录安装 / 改代码

```bash
git clone https://github.com/gavinguo521/paseo-plugins.git
cd paseo-plugins/<插件目录>
npm install
paseo plugin install "$PWD"
```

改完源码后先 `npm run typecheck`，再 `paseo plugin reload <插件 id>`。

跨会话、跨机器协作的 skill 在另一个仓库：[paseo-mesh](https://github.com/gavinguo521/paseo-mesh)。

## License

MIT
