# 官方通知决策接口

本扩展针对 Paseo server 0.15.2。它保留官方 `computeNotificationPlan` 和 Expo 推送路径，给现有 `agent_attention_required` 事件新增可选字段：

- `shouldPush`：与官方推送使用的是同一个决策结果。
- `permissionRequestId`：该次通知对应的权限请求，便于 APNs 通知按钮准确操作。

插件用 `observeEvents(..., { notifications: false })` 观察事件，不作为通知候选端。会话列表只用于实时活动与标题，不再触发普通通知。正在查看目标会话时不推送；有近期活跃客户端时只由官方选中的客户端通知；没有活跃客户端才发 APNs。错误事件不发远程通知。全部离线时仍发给该主机的所有登记设备，这是官方行为。

## 兼容与激活顺序

此功能不是仅重载插件即可完成的修改。不要在仍运行旧 Native 客户端时启用完整链路：旧 iOS 会无条件抑制后台本地通知，在 daemon 选中它的短暂窗口可能漏提醒。

1. 先安装带 `shouldPush` 与 `followsOfficialPolicy` 协商的新 Mac、iPhone、iPad 客户端。尚未升级 daemon / 插件时继续旧的后台去重方式。
2. 在插件目录运行 `npm ci` 准备依赖。插件实际使用 daemon 提供的 SDK；协议扩展随下一步一起应用，不能只改插件自己的依赖。
3. 对每台产生通知的主机运行检查：`node --experimental-strip-types daemon/prepare.ts --runtime <runtime目录>`。确认通过后加 `--apply` 写入；保留原文件备份。必须在获准重启的维护窗口执行，不在正常运行期间修改生产安装。
4. 经用户明确同意后重启对应 daemon，重载 `live-activity` 并确认 running；客户端回到前台重新登记能力。不要在当前工作会话中直接重启其宿主。
5. 真机验证：Mac 正在看目标会话时手机和平板无提醒；Mac 看其他会话时只由最近活跃端提醒；全部离线时手机和平板均收到；权限通知能打开正确会话；断连不产生旧活跃状态租约造成的漏通知。

未打补丁的远端会省略决策字段，插件记录一次兼容告警，改用 App 上报的在用状态兜底（`presence.report`，见 `server/presence.ts`）：该机器的会话完成时，若有设备 3 分钟内用过且连着这台机器，就交给 daemon 选中的设备应用内弹，不推；超过 45 秒没上报的设备不算。这是按同一规则的估算，不是 daemon 的同次决策，可能有短暂偏差；打补丁后自动改用官方决策。因此 `activity.register` 总是返回 `followsOfficialPolicy: true`，新版 App 据此在后台被选中时自己弹本地通知；1.0.29 及更早的 App 还要求事件带 `shouldPush`，未打补丁时仍保留旧的后台去重。

实时活动的内容更新 / push-to-start 是独立功能，未把普通通知策略强加到多主机汇总活动上。

CLI npm 升级会替换官方文件：每次升级必须重新核验补丁；当前哈希不匹配就停下来适配新版本。原文件备份位于同目录 `*.before-notification-<hash>`。回滚时先退出新推送模式并协调客户端，恢复备份后在维护窗口重启；不得只回滚某一边后声称完整链路仍生效。

## 验证

```
npm run typecheck
npm test
PASEO_TEST_RUNTIME=<runtime目录> npm run test:daemon
```

最后一项加载安装版本的真实官方策略及广播方法体，在隔离的连接对象上验证决策、观察端不抢占、断连 / 超时、权限请求、错误事件、协议前后兼容以及补丁幂等。它不连接真实 daemon 或 APNs，不能代替最后一步真机验收。
