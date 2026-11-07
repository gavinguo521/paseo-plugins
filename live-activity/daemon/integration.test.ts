// 使用安装版本的真实决策函数和广播方法体，在隔离连接上验证；不连接生产 daemon / APNs。
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { patchSource } from "./prepare.ts";

const runtime = process.env.PASEO_TEST_RUNTIME;
assert.ok(runtime, "请设置 PASEO_TEST_RUNTIME 指向待验证的 0.15.2 runtime");
const dir = resolve(runtime, "node_modules/@getpaseo/server/dist/server/server");
const policy = await import(pathToFileURL(resolve(dir, "agent-attention-policy.js")).href);
const original = await readFile(resolve(dir, "websocket-server.js"), "utf8");
const patched = patchSource("server", original);
const start = patched.indexOf("    async broadcastAgentAttention(params) {");
const end = patched.indexOf("    async broadcastTerminalAttention(params)", start);
const body = patched.slice(start, end).replace("    async broadcastAgentAttention(params)", "async function(params)");
const broadcast = new Function("computeNotificationPlan", "isPushEligibleAttentionReason", "buildAgentAttentionNotificationPayload", "findLatestPermissionRequest", "wrapSessionMessage", "CLIENT_CAPS", `return (${body});`)(
  policy.computeNotificationPlan, policy.isPushEligibleAttentionReason,
  () => ({ title: "title", body: "body", data: { serverId: "host", agentId: "agent", reason: "finished" } }),
  (permissions: { id: string }[]) => permissions[0], (message: unknown) => ({ type: "session", message }), {},
);

async function exercise(states: { visible: boolean; focused: string | null; at: number }[], reason = "finished") {
  const delivered: { client: number; payload: { shouldNotify: boolean; shouldPush: boolean; permissionRequestId?: string } }[] = [];
  let pushed = 0;
  const sessions = new Map();
  // 最后一个连接为插件，只订阅事件，没有通知接收资格。
  [...states, { visible: false, focused: null, at: Date.now() }].forEach((state, client) => {
    sessions.set(client, { session: {
      delivery: { isModern: () => true }, wantsSourceEvent: () => true,
      wantsSourceNotification: () => client < states.length,
      publishToSource: (_ws: unknown, message: { payload: (typeof delivered)[number]["payload"] }) => delivered.push({ client, payload: message.payload }),
    }, state });
  });
  const context = {
    serverId: "host", sessions,
    agentManager: { getAgent: () => ({ workspaceId: "workspace", pendingPermissions: [{ id: "request" }] }), getLastAssistantMessage: async () => "reply" },
    getClientActivityState: (_session: unknown, ws: number) => {
      const state = sessions.get(ws).state;
      return { appVisible: state.visible, focusedAgentId: state.focused, focusedTerminalId: null, lastActivityAtMs: state.at };
    },
    pushNotificationSender: { send: async () => { pushed++; } },
    logger: { warn: () => {} },
  };
  await broadcast.call(context, { agentId: "agent", reason, provider: "codex" });
  return { delivered, pushed };
}

test("真实广播：正在查看时全部抑制，插件仍收到 false 决策", async () => {
  const result = await exercise([{ visible: true, focused: "agent", at: Date.now() }]);
  assert.equal(result.pushed, 0);
  assert.ok(result.delivered.every(e => !e.payload.shouldPush && !e.payload.shouldNotify));
  assert.equal(result.delivered.length, 2);
});
test("真实广播：只选最近活跃端，观察插件不能抢占", async () => {
  const now = Date.now();
  const result = await exercise([{ visible: true, focused: "other", at: now - 1000 }, { visible: false, focused: null, at: now - 2000 }]);
  assert.deepEqual(result.delivered.map(e => e.payload.shouldNotify), [true, false, false]);
  assert.equal(result.pushed, 0);
  assert.ok(result.delivered.every(e => !e.payload.shouldPush));
});
test("真实广播：断连立即移除候选，全部离线或超时允许推送，错误不推送", async () => {
  assert.equal((await exercise([])).delivered[0].payload.shouldPush, true);
  assert.equal((await exercise([{ visible: false, focused: null, at: Date.now() - 180001 }])).pushed, 1);
  assert.equal((await exercise([], "error")).pushed, 0);
  const permission = await exercise([], "permission");
  assert.equal(permission.delivered[0].payload.permissionRequestId, "request");
});
test("补丁可重复执行，拒绝未知版本；新旧解析器均接受事件", async () => {
  assert.equal(patchSource("server", patched), patched);
  assert.throws(() => patchSource("server", original + "\nchanged"), /不支持/);
  const session = await readFile(resolve(dir, "session.js"), "utf8");
  const patchedSession = patchSource("session", session);
  assert.equal(patchSource("session", patchedSession), patchedSession);
  assert.ok(patchedSession.includes('subscriptionId: owner.responseId, notificationDecision: "official-v1"'));
  const source = await readFile(resolve(runtime!, "node_modules/@getpaseo/protocol/dist/messages.js"), "utf8");
  const next = patchSource("protocol", source);
  assert.equal(patchSource("protocol", next), next);
  const parseSchema = (text: string, name = "AgentAttentionRequiredMessageSchema") => {
    const marker = `export const ${name} = `;
    const a = text.indexOf(marker) + marker.length;
    const b = text.indexOf("\nexport const ", a);
    return new Function("z", `return ${text.slice(a, b)}`)(z);
  };
  const wire = { type: "agent_attention_required", payload: { agentId: "agent", reason: "permission", timestamp: new Date().toISOString(), shouldNotify: false, shouldPush: true, permissionRequestId: "request" } };
  assert.equal(parseSchema(source).safeParse(wire).success, true);
  assert.equal(parseSchema(next).parse(wire).payload.shouldPush, true);
  const response = { type: "session.events.set_subscription.response", payload: { requestId: "r", subscriptionId: "s", notificationDecision: "official-v1" } };
  assert.equal(parseSchema(source, "SessionEventsSetSubscriptionResponseSchema").safeParse(response).success, true);
  assert.equal(parseSchema(next, "SessionEventsSetSubscriptionResponseSchema").parse(response).payload.notificationDecision, "official-v1");
});
