import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleNotifications, RESULT_MAX_AGE_MS, type ScheduleResultPayload } from "../server/schedule-notifications.ts";
import { scheduleID } from "../shared/schedule-notifications.ts";

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "paseo-schedule-notification-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "schedules"));
  let now = Date.parse("2026-11-10T01:00:00Z");
  let targets = ["phone-a", "phone-b"];
  const calls: { device: string; payload: ScheduleResultPayload; collapseId: string }[] = [];
  const fail = new Set<string>();
  const transport = {
    targets: (serverId: string) => serverId === "host-a" ? targets : [],
    send: async (device: string, payload: ScheduleResultPayload, collapseId: string) => {
      calls.push({ device, payload, collapseId });
      if (fail.has(device)) throw new Error("network unavailable");
      return true;
    },
  };
  const createMonitor = () => new ScheduleNotifications(join(home, "live-activity"), transport, () => now);
  const monitor = createMonitor();
  const run = (id: string, status = "succeeded", extra = {}) => ({
    id, status, endedAt: new Date(now).toISOString(), agentId: null, output: "完成同步", error: null, ...extra,
  });
  const saveSchedule = async (runs: ReturnType<typeof run>[] = [], extra = {}) => {
    const schedule = { id: "schedule-a", name: "每日检查", prompt: "检查项目", target: { type: "new-agent", config: { archiveOnFinish: true } }, runs, ...extra };
    await writeFile(join(home, "schedules", "schedule-a.json"), JSON.stringify(schedule));
  };
  await saveSchedule();
  return { home, monitor, createMonitor, calls, fail, run, saveSchedule,
    advance: (ms = 1_000) => { now += ms; }, setTargets: (value: string[]) => { targets = value; },
    enable: () => monitor.write("host-a", "schedule-a", true, "missing"),
  };
}

test("default off, saved preference survives restart, old completions are not replayed", async t => {
  const f = await fixture(t);
  await f.saveSchedule([f.run("old")]);
  assert.equal((await f.monitor.read("host-a", "schedule-a")).enabled, false);
  await f.monitor.poll();
  f.advance();
  const saved = await f.enable();
  assert.equal(saved.enabled, true);
  const restored = f.createMonitor();
  assert.deepEqual(await restored.read("host-a", "schedule-a"), saved);
  await restored.poll();
  assert.equal(f.calls.length, 0);
  assert.equal((await stat(join(f.home, "live-activity", "schedule-notifications.json"))).mode & 0o777, 0o600);
});

test("success and failure without an agent notify both phones, independent of archive", async t => {
  const f = await fixture(t);
  await f.enable();
  f.advance();
  await f.saveSchedule([f.run("ok", "succeeded", { agentId: "archived-agent" }),
    f.run("failed", "failed", { output: null, error: "Token quota exceeded" }), f.run("still-running", "running")]);
  await f.monitor.poll();
  assert.equal(f.calls.length, 4);
  const failure = f.calls.find(c => c.payload.runId === "failed")!.payload;
  assert.equal(failure.aps.alert.body, "Token quota exceeded");
  assert.equal(failure.aps.category, "paseo.schedule-result");
  assert.equal(failure.scheduleId, "schedule-a");
  assert.equal("agentId" in failure, false);
  assert.match(failure.aps.alert.title, /失败.*每日检查/);
  assert.equal(f.calls[0].payload.aps.alert.body, "完成同步");
  assert.equal(f.calls[0].collapseId.length, 64);
  assert.notEqual(f.calls[0].collapseId, f.calls[2].collapseId);
  await Promise.all([f.monitor.poll(), f.monitor.poll()]);
  await f.createMonitor().poll();
  assert.equal(f.calls.length, 4, "no duplicates on another poll or process restart");
});

test("transport retry is persisted per device, without resending successful deliveries", async t => {
  const f = await fixture(t);
  await f.enable(); f.advance();
  await f.saveSchedule([f.run("retry")]);
  f.fail.add("phone-b");
  await f.monitor.poll();
  const restarted = f.createMonitor();
  await restarted.poll();
  assert.equal(f.calls.length, 2);
  f.advance(60_000);
  f.fail.clear();
  await restarted.poll();
  assert.deepEqual(f.calls.map(c => c.device), ["phone-a", "phone-b", "phone-b"]);
  assert.equal(f.calls[1].collapseId, f.calls[2].collapseId);
});

test("turning off cancels pending retries and re-enabling skips runs while off", async t => {
  const f = await fixture(t);
  const on = await f.enable(); f.advance();
  await f.saveSchedule([f.run("pending")]);
  f.fail.add("phone-b");
  await f.monitor.poll();
  const off = await f.monitor.write("host-a", "schedule-a", false, on.revision);
  f.advance(60_000); f.fail.clear();
  await f.saveSchedule([f.run("while-off")]);
  await f.monitor.poll();
  assert.equal(f.calls.length, 2);
  f.advance();
  await f.monitor.write("host-a", "schedule-a", true, off.revision);
  await f.monitor.poll();
  assert.equal(f.calls.length, 2);
});

test("concurrent stale edits fail instead of overwriting the other device", async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.enable(), f.enable()]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  await assert.rejects(() => f.monitor.write("host-a", "schedule-a", false, "missing"), /其他设备/);
});

test("requires configured destination, validates paths and excludes heartbeat tasks", async t => {
  const f = await fixture(t);
  f.setTargets([]);
  assert.equal((await f.monitor.read("host-a")).ready, false);
  await assert.rejects(f.enable, /手机推送/);
  f.setTargets(["phone-a"]);
  for (const id of ["../devices", "/tmp/file", "a/b", ""]) {
    assert.equal(scheduleID.safeParse(id).success, false);
    await assert.rejects(() => f.monitor.read("host-a", id));
  }
  await f.saveSchedule([], { target: { type: "agent" } });
  await assert.rejects(f.enable, /不支持/);
});

test("unavailable phone catches up, but stale runs and other hosts never receive pushes", async t => {
  const f = await fixture(t);
  await f.enable(); f.advance();
  await f.saveSchedule([f.run("late")]);
  f.setTargets([]);
  await f.monitor.poll();
  f.setTargets(["phone-a"]);
  f.advance(15_000);
  await f.monitor.poll();
  assert.equal(f.calls.length, 1);
  await assert.rejects(() => f.monitor.read("host-b", "schedule-a"), /另一台主机/);
  f.advance(RESULT_MAX_AGE_MS + 1);
  await f.createMonitor().poll();
  assert.equal(f.calls.length, 1);
});

test("deleted or temporarily malformed schedule files do not lose the setting", async t => {
  const f = await fixture(t);
  await f.enable(); f.advance();
  const file = join(f.home, "schedules", "schedule-a.json");
  await writeFile(file, "broken");
  await f.monitor.poll();
  await rm(file);
  await f.monitor.poll();
  assert.equal(f.calls.length, 0);
  await f.saveSchedule([f.run("recovered")]);
  await f.monitor.poll();
  assert.equal(f.calls.length, 2);
});

test("invalid preferences are reported, never reset silently to disabled", async t => {
  const f = await fixture(t);
  await f.enable();
  const path = join(f.home, "live-activity", "schedule-notifications.json");
  await writeFile(path, "broken");
  await assert.rejects(() => f.createMonitor().read("host-a", "schedule-a"));
  assert.equal(await readFile(path, "utf8"), "broken");
});
