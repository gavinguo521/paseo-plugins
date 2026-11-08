// 实时活动推送插件：App 不在前台时，经 APNs 把本机与已关联机器上的会话汇总推到 iOS 灵动岛 / 锁屏。
import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { activityConfigure, activityRegister, activityStatus, activityUnregister, presenceReport } from "./shared/contracts.ts";
import { LiveActivity } from "./server/engine.ts";

// hooks 只当「状态可能变了」的触发器，真正的数据来自会话列表订阅。
const TRIGGERS = [
  "agent.turn.before",
  "agent.turn.after",
  "agent.permission.before",
  "agent.permission.after",
  "agent.create.after",
  "agent.archive.after",
  "agent.close.after",
] as const;

export default function contribute(server: PluginServerContext) {
  const engine = new LiveActivity();

  const trigger = async (_event: unknown, { paseo }: PluginHookContext) => {
    void engine.ensureStarted(paseo);
    engine.schedule();
  };
  const removers = TRIGGERS.map(name => server.addHook(name, trigger));

  server.handle(activityRegister, async (input, { paseo }) => {
    await engine.ensureStarted(paseo);
    await engine.register(input);
    return {
      configured: engine.configuredFor(input.environment),
      serverId: await engine.selfServerId(paseo),
      alerts: engine.alertsFor(input.deviceId),
      followsOfficialPolicy: true,
    };
  });

  server.handle(presenceReport, async ({ deviceId, idleMs, servers }, { paseo }) => {
    void engine.ensureStarted(paseo);
    engine.reportPresence(deviceId, idleMs, servers);
    return { ok: true };
  });

  server.handle(activityUnregister, async ({ deviceId }, { paseo }) => {
    void engine.ensureStarted(paseo);
    return { ok: await engine.unregister(deviceId) };
  });

  server.handle(activityConfigure, async (input, { paseo }) => {
    void engine.ensureStarted(paseo);
    await engine.configure(input);
    return { configured: true };
  });

  server.handle(activityStatus, async (_input, { paseo }) => {
    void engine.ensureStarted(paseo);
    await engine.ready;
    return {
      configured: engine.configured,
      ...engine.keyInfo,
      devices: engine.deviceCount,
      lastPush: engine.lastPush,
    };
  });

  return () => {
    for (const remove of removers) remove();
    engine.dispose();
  };
}
