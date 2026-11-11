import assert from "node:assert/strict";
import test from "node:test";
import { AgentSource, type Api } from "../server/sources.ts";
import { decisionPayload, readNotificationDecision } from "../server/notification-decision.ts";

const event = (shouldPush?: boolean, reason: "finished" | "permission" | "error" = "finished") => ({
  type: "agent_attention_required", payload: {
    agentId: "agent-1", reason, timestamp: new Date().toISOString(), shouldPush,
    notification: { title: "真实标题", body: "服务端原始正文" }, permissionRequestId: "permission-1",
  },
});

test("事件保留官方推送决策，交由 APNs 和显式 Bark 订阅分别处理", async () => {
  const notifications: unknown[] = [];
  const options: unknown[] = [];
  let update!: (value: unknown) => void;
  let released = 0;
  const subscription = { ready: Promise.resolve({ subscriptionId: "events" }),
    subscribe(observer: { update(value: unknown): void }) { update = observer.update; return () => {}; },
    async release() { released++; },
  };
  const api = {
    observeEvents(events: string[], opts: unknown) { assert.deepEqual(events, ["agent_attention_required"]); options.push(opts); return subscription; },
    agents: { async list() { return { entries: [], subscription: { subscribe() { return () => {}; }, async release() {} } }; } },
    workspaces: { async list() { return { entries: [] }; } },
  } as unknown as Api;
  const source = new AgentSource({ serverId: "host-1", name: "测试主机", open: async () => api,
    release: async () => {}, onChange: () => {}, onAlert: (host, e) => notifications.push([host, e]), log: () => {} });
  await source.start();
  assert.deepEqual(options, [{ notifications: false }]);
  update(event(false)); // 正在 Mac 查看，或最近活跃端已接收。
  assert.equal(notifications.length, 1);
  update(event(true)); // 断连后 daemon 当场改判推送，无镜像租约等待。
  assert.equal(notifications.length, 2);
  update(event(false, "error"));
  assert.equal(notifications.length, 2);
  update(event(true, "permission"));
  assert.equal(notifications.length, 3);
  update(event(undefined)); // 旧 daemon 兼容路径，不冒充完整支持。
  assert.equal(notifications.length, 4);
  await source.close();
  assert.equal(released, 1);
});

test("保持事件正文与对应权限请求；丢弃过期事件", () => {
  const wire = event(true, "permission");
  const read = readNotificationDecision(wire, Date.now())!;
  assert.equal(decisionPayload("host-1", read).requestId, "permission-1");
  assert.deepEqual(decisionPayload("host-1", read).aps.alert, wire.payload.notification);
  assert.equal(readNotificationDecision(wire, Date.now() + 120_001), null);
  assert.equal(readNotificationDecision({ type: "agent_update", payload: {} }, Date.now()), null);
});

test("首次通知订阅失败会重建；关闭后取消重试", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  let update!: (value: unknown) => void;
  let fail!: (error: unknown) => void;
  const received: unknown[] = [];
  const api = {
    observeEvents() {
      const first = ++attempts === 1;
      return {
        ready: first ? Promise.reject(new Error("连接中断")) : Promise.resolve({ subscriptionId: "restored", notificationDecision: "official-v1" }),
        subscribe(observer: { update(value: unknown): void; snapshot(value: unknown): void; error(error: unknown): void }) {
          update = observer.update; fail = observer.error;
          if (!first) observer.snapshot({ subscriptionId: "restored", notificationDecision: "official-v1" });
          return () => {};
        },
        async release() {},
      };
    },
    agents: { async list() { return { entries: [], subscription: { subscribe() { return () => {}; }, async release() {} } }; } },
    workspaces: { async list() { return { entries: [] }; } },
  } as unknown as Api;
  const source = new AgentSource({ serverId: "host", name: "恢复测试", open: async () => api, release: async () => {},
    onChange: () => {}, onAlert: (_, e) => received.push(e), log: () => {} });
  await source.start();
  assert.equal(attempts, 1);
  assert.equal(source.notificationDecisionReady, false);
  t.mock.timers.tick(1000);
  assert.equal(attempts, 2);
  assert.equal(source.notificationDecisionReady, true);
  update(event(true));
  assert.equal(received.length, 1);
  fail(new Error("再次断开"));
  await source.close();
  t.mock.timers.tick(30_000);
  assert.equal(attempts, 2);
});
