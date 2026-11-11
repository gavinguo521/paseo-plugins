import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BarkDelivery, parseBarkURL } from "../server/bark.ts";
import { ScheduleNotifications, scheduleResultPayload } from "../server/schedule-notifications.ts";
import { LiveActivity } from "../server/engine.ts";
import { Store } from "../server/store.ts";
import type { Api } from "../server/sources.ts";
import { ApnsClient } from "../server/apns.ts";
import type { NotificationDecision } from "../server/notification-decision.ts";

const key = "private_test_key_DO_NOT_ECHO";
const pushURL = `https://api.day.app/${key}/sample-title/sample-body?url=https://example.org`;
const task = { id: "task-a", name: "每日同步", prompt: "检查代码", target: { type: "new-agent" }, runs: [] };

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "paseo-bark-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let now = Date.parse("2026-11-10T12:00:00Z");
  let response = () => Promise.resolve(new Response(JSON.stringify({ code: 200 }), { status: 200 }));
  const calls: { url: string; input: RequestInit }[] = [];
  const request: typeof fetch = async (url, input) => { calls.push({ url: String(url), input: input! }); return response(); };
  const create = () => new BarkDelivery(join(home, "live-activity"), request, () => now);
  const bark = create();
  await bark.ready;
  return { home, bark, create, calls, request, advance: () => { now += 1000; }, now: () => now,
    fail: (value: typeof response) => { response = value; } };
}

test("pasted Bark test URL becomes HTTPS POST endpoint, rejects unsafe addresses without echoing secrets", () => {
  assert.deepEqual(parseBarkURL(`  ${pushURL}\n`), { endpoint: "https://api.day.app/push", deviceKey: key });
  for (const url of [`http://api.day.app/${key}`, `https://user:${key}@api.day.app/key`, "file:///tmp/a", "not-a-url",
    "https://api.day.app/", "https://api.day.app/push", "https://api.day.app/key%2fpath"]) {
    assert.throws(() => parseBarkURL(url), error => error instanceof Error && !error.message.includes(key));
  }
});

test("conversation opt-in survives restart and only sends new completions with a conversation link", async t => {
  const f = await fixture(t);
  await f.bark.configure("host-a", pushURL);
  const target = f.bark.targetFor("host-a")!;
  const event = (): NotificationDecision => ({ agentId: "chat-a", reason: "finished", timestamp: new Date(f.now()).toISOString(),
    shouldPush: false, notification: { title: "完成 · 登录修复", body: "已修复并通过验证。" } });
  assert.equal(await f.bark.sendCompletion(target, "host-a", event()), false);
  const old = event(); f.advance();
  const status = await f.bark.setNotifyOnFinish("host-a", true);
  assert.equal(status.notifyOnFinish, true);
  assert.ok(!JSON.stringify(status).includes(key));
  const restored = f.create(); await restored.ready;
  assert.equal(restored.completionTargetFor("host-a"), target);
  assert.equal(await restored.sendCompletion(target, "host-a", old), false);
  assert.equal(await restored.sendCompletion(target, "host-b", event()), false);
  assert.equal(await restored.sendCompletion(target, "host-a", { ...event(), reason: "permission" }), false);
  assert.equal(await restored.sendCompletion(target, "host-a", { ...event(), reason: "error" }), false);
  assert.equal(await restored.sendCompletion(target, "host-a", event()), true);
  const body = JSON.parse(f.calls[0].input.body as string);
  assert.equal(body.title, event().notification.title);
  assert.equal(body.body, event().notification.body);
  assert.equal(body.group, "Paseo 会话");
  assert.equal(body.url, "paseonative://agent/host-a/chat-a");
  await restored.sendCompletion(target, "host-a", event());
  assert.equal(JSON.parse(f.calls[1].input.body as string).id, body.id);
  f.advance();
  await restored.sendCompletion(target, "host-a", event());
  assert.notEqual(JSON.parse(f.calls[2].input.body as string).id, body.id);
  await restored.configure("host-a", pushURL);
  assert.equal(restored.status().notifyOnFinish, true);
  await restored.setNotifyOnFinish("host-a", false);
  const disabled = event(); f.advance();
  await restored.setNotifyOnFinish("host-a", true);
  assert.equal(await restored.sendCompletion(target, "host-a", disabled), false);
  await restored.configure("host-a", "https://api.day.app/replacement-key");
  assert.equal(restored.status().notifyOnFinish, false, "new recipient must opt in separately");
});

test("older Bark configuration defaults conversations off while keeping scheduled results configured", async t => {
  const f = await fixture(t);
  await f.bark.configure("host-a", pushURL);
  const path = join(f.home, "live-activity", "bark.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  delete config.completionEnabledAt;
  await writeFile(path, JSON.stringify(config));
  const restored = f.create(); await restored.ready;
  assert.equal(restored.status().notifyOnFinish, false);
  assert.ok(restored.targetFor("host-a"));
});

test("live completion reaches Bark with an active Mac, deduplicates, skips scheduled/child agents, and preserves APNs policy", async t => {
  const f = await fixture(t);
  await f.bark.configure("host-a", pushURL);
  await f.bark.setNotifyOnFinish("host-a", true);
  t.mock.method(globalThis, "fetch", f.request);
  const apns: unknown[] = [];
  t.mock.method(ApnsClient.prototype, "configuredFor", () => true);
  t.mock.method(ApnsClient.prototype, "send", async (...args: unknown[]) => {
    apns.push(args); return { ok: true, status: 200, reason: null };
  });
  let update!: (message: unknown) => void;
  const agent = (id: string, labels: Record<string, string> = {}) => ({ id, title: id, labels, status: "idle",
    workspaceId: "workspace-a", pendingPermissions: [], updatedAt: new Date().toISOString() });
  const agents = [agent("chat-a"), agent("task-a", { "paseo.schedule-id": "task-a" }),
    agent("child-a", { "paseo.parent-agent-id": "chat-a" })];
  const api = {
    hosts: { async list() { return { self: { serverId: "host-a" }, hosts: [] }; } },
    observeEvents(_events: string[], options: unknown) {
      assert.deepEqual(options, { notifications: false });
      return { ready: Promise.resolve({}), subscribe(observer: { update(value: unknown): void }) {
        update = observer.update; return () => {};
      }, async release() {} };
    },
    agents: { async list() { return { entries: agents.map(agent => ({ agent })),
      subscription: { subscribe() { return () => {}; }, async release() {} } }; },
      ref(id: string) { return { async refresh() { return { agent: agent(id, { "paseo.schedule-id": "archived-task" }) }; } }; } },
    workspaces: { async list() { return { entries: [{ id: "workspace-a", title: "测试项目", projectDisplayName: "Test" }] }; } },
  } as unknown as Api;
  const engine = new LiveActivity(new Store(join(f.home, "live-activity")));
  t.after(() => engine.dispose());
  await engine.ensureStarted(api);
  await engine.register({ deviceId: "phone", bundleId: "com.test.paseo", environment: "development",
    alertToken: "ab12", hosts: [{ serverId: "host-a", label: "Mac" }] });
  engine.reportPresence("mac", 0, ["host-a"]);
  let stamp = Date.now();
  const wire = (agentId = "chat-a", shouldPush: boolean | undefined = false, reason = "finished") => ({
    type: "agent_attention_required", payload: { agentId, shouldPush, reason,
      timestamp: new Date(stamp++).toISOString(), notification: { title: "原始标题", body: "本次回复摘要" } },
  });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const done = wire(); update(done); update(done);
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.calls[0].input.body as string).title, "完成 · 测试项目");
  assert.equal(JSON.parse(f.calls[0].input.body as string).body, "本次回复摘要");
  update(wire("task-a")); update(wire("child-a")); update(wire("already-archived-task"));
  update(wire("chat-a", true, "error"));
  await flush();
  assert.equal(f.calls.length, 1, "scheduled completion does not duplicate the task-result notification");
  update(wire("chat-a", true));
  await flush();
  assert.equal(f.calls.length, 2, "another turn produces a new notification");
  assert.equal(apns.length, 0, "no duplicate completion through APNs");
  update(wire("chat-a", true, "permission"));
  await flush();
  assert.equal(apns.length, 1, "permission APNs remains unchanged");
  assert.equal(f.calls.length, 2);
  await engine.bark.setNotifyOnFinish("host-a", false);
  update(wire("chat-a", false));
  const legacy = wire(); delete (legacy.payload as { shouldPush?: boolean }).shouldPush;
  update(legacy);
  await flush();
  assert.equal(apns.length, 1, "official suppression and legacy active-device fallback remain intact");
  update(wire("chat-a", true));
  await flush();
  assert.equal(apns.length, 2, "APNs resumes for eligible completions when Bark opt-in is off");
  assert.equal(f.calls.length, 2);
});

test("configuration is private, host-scoped, durable, and removal survives restart", async t => {
  const f = await fixture(t);
  assert.equal(f.bark.targetFor("host-a"), null);
  const saved = await f.bark.configure("host-a", pushURL);
  assert.equal(saved.configured, true);
  assert.equal(saved.serverURL, "https://api.day.app");
  assert.ok(!JSON.stringify(saved).includes(key));
  assert.equal(f.bark.targetFor("other-host"), null);
  const target = f.bark.targetFor("host-a")!;
  const since = f.bark.availableSince(target);
  f.advance();
  await f.bark.configure("host-a", pushURL);
  assert.equal(f.bark.availableSince(target), since, "re-saving same destination does not skip pending runs");
  const path = join(f.home, "live-activity", "bark.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, "utf8")).deviceKey, key);
  const restored = f.create(); await restored.ready;
  assert.equal(restored.targetFor("host-a"), target);
  await restored.clear();
  const empty = f.create(); await empty.ready;
  assert.equal(empty.status().configured, false);
});

test("success and pre-session failure send readable messages and task-history deep links", async t => {
  const f = await fixture(t);
  await f.bark.configure("host-a", pushURL);
  for (const status of ["succeeded", "failed"] as const) {
    const payload = scheduleResultPayload("host-a", task, { id: status, status, endedAt: new Date(f.now()).toISOString(),
      agentId: null, output: "两个仓库已更新", error: "Token quota exceeded" });
    assert.equal(await f.bark.sendResult(f.bark.targetFor("host-a")!, payload, status), true);
    const { url, input } = f.calls.at(-1)!;
    const body = JSON.parse(input.body as string);
    assert.equal(url, "https://api.day.app/push");
    assert.equal(input.method, "POST");
    assert.equal(input.redirect, "error");
    assert.equal(body.device_key, key);
    assert.equal(body.id, status);
    assert.equal(body.body, status === "succeeded" ? "两个仓库已更新" : "Token quota exceeded");
    const link = new URL(body.url);
    assert.equal(link.protocol, "paseonative:");
    assert.equal(link.hostname, "schedule");
    assert.equal(link.searchParams.get("serverId"), "host-a");
    assert.equal(link.searchParams.get("scheduleId"), "task-a");
  }
  assert.equal(await f.bark.sendResult("stale-target", scheduleResultPayload("host-a", task, {
    id: "stale", status: "failed", endedAt: null }), "stale"), false);
  assert.equal(f.calls.length, 2);
});

test("test notifications distinguish HTTP/API/transport failure and never expose response secrets", async t => {
  const f = await fixture(t);
  await f.bark.configure("host-a", pushURL);
  assert.equal((await f.bark.test("host-a")).ok, true);
  assert.equal(JSON.parse(f.calls[0].input.body as string).url, undefined);
  for (const response of [
    () => Promise.resolve(new Response(JSON.stringify({ code: 400, message: key }), { status: 200 })),
    () => Promise.resolve(new Response(JSON.stringify({ code: 500, message: key }), { status: 500 })),
    () => Promise.resolve(new Response("<html>not a Bark server</html>", { status: 200 })),
    () => Promise.reject(new Error(key)),
  ]) {
    f.fail(response);
    const result = await f.bark.test("host-a");
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(key));
    assert.ok(!JSON.stringify(f.bark.status()).includes(key));
  }
});

test("Bark results retry after network failure and do not duplicate across plugin restarts", async t => {
  const f = await fixture(t);
  await mkdir(join(f.home, "schedules"));
  const save = (runs: unknown[]) => writeFile(join(f.home, "schedules", "task-a.json"), JSON.stringify({ ...task, runs }));
  await save([]);
  await f.bark.configure("host-a", pushURL);
  const monitor = () => new ScheduleNotifications(join(f.home, "live-activity"), {
    targets: serverId => { const target = f.bark.targetFor(serverId); return target ? [target] : []; },
    availableSince: target => f.bark.availableSince(target),
    send: (target, payload, id) => f.bark.sendResult(target, payload, id),
  }, f.now);
  const first = monitor();
  await first.write("host-a", "task-a", true, "missing");
  f.advance();
  await save([{ id: "run-a", status: "failed", endedAt: new Date(f.now()).toISOString(), error: "Network unavailable" }]);
  f.fail(() => Promise.reject(new Error("offline")));
  await first.poll();
  assert.equal(f.calls.length, 1);
  const restored = monitor();
  await restored.poll();
  assert.equal(f.calls.length, 1);
  for (let i = 0; i < 61; i++) f.advance();
  f.fail(() => Promise.resolve(new Response(JSON.stringify({ code: 200 }), { status: 200 })));
  await restored.poll();
  await monitor().poll();
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(f.calls[0].input.body as string).id, JSON.parse(f.calls[1].input.body as string).id);
  // A replacement destination must not replay old history to a different phone.
  await f.bark.configure("host-a", "https://api.day.app/replacement-key");
  await restored.poll();
  assert.equal(f.calls.length, 2);
});

test("the installed engine can enable task notifications with Bark and no APNs key or registered phone", async t => {
  const f = await fixture(t);
  await mkdir(join(f.home, "schedules"));
  await writeFile(join(f.home, "schedules", "task-a.json"), JSON.stringify(task));
  await f.bark.configure("host-a", pushURL);
  const engine = new LiveActivity(new Store(join(f.home, "live-activity")));
  t.after(() => engine.dispose());
  await engine.ready;
  assert.equal(engine.configured, false);
  assert.equal(engine.deviceCount, 0);
  assert.equal((await engine.scheduleNotifications.read("host-a")).ready, true);
  assert.equal((await engine.scheduleNotifications.read("host-b")).ready, false);
  assert.equal((await engine.scheduleNotifications.write("host-a", "task-a", true, "missing")).enabled, true);
});
