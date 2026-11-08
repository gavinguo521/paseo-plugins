import test from "node:test";
import assert from "node:assert/strict";
import { Presence, FRESH_MS, PRESENCE_MS } from "../server/presence.ts";
import { activityRegister, presenceReport } from "../shared/contracts.ts";

const T0 = 1_800_000_000_000;

test("3 分钟内用过、且连着这台机器的设备算在用：不推送", () => {
  const p = new Presence();
  p.report("mac", 20_000, ["mini", "studio"], T0);
  assert.equal(p.activeOn("mini", T0), "mac");
  assert.equal(p.activeOn("studio", T0 + 30_000), "mac");
  // 没连着的机器：daemon 不会选它弹应用内通知，照常推。
  assert.equal(p.activeOn("other", T0), null);
});

test("超过 3 分钟没操作不算在用", () => {
  const p = new Presence();
  p.report("mac", PRESENCE_MS - 1_000, ["mini"], T0);
  assert.equal(p.activeOn("mini", T0), "mac");
  assert.equal(p.activeOn("mini", T0 + 2_000), null);
  p.report("mac", PRESENCE_MS + 1, ["mini"], T0);
  assert.equal(p.activeOn("mini", T0), null);
});

test("停止上报（挂起、退出）超过 FRESH_MS 不算在用，新报告覆盖旧的", () => {
  const p = new Presence();
  p.report("phone", 0, ["mini"], T0);
  assert.equal(p.activeOn("mini", T0 + FRESH_MS), "phone");
  assert.equal(p.activeOn("mini", T0 + FRESH_MS + 1), null);
  p.report("phone", 0, [], T0 + 1_000);
  assert.equal(p.activeOn("mini", T0 + 1_000), null);
});

test("presence.report 契约与 register 的 followsOfficialPolicy（旧输出仍能解析）", () => {
  assert.deepEqual(presenceReport.input.parse({ deviceId: "d", idleMs: 0, servers: ["s1"] }), { deviceId: "d", idleMs: 0, servers: ["s1"] });
  assert.throws(() => presenceReport.input.parse({ deviceId: "d", idleMs: -1, servers: [] }));
  assert.throws(() => presenceReport.input.parse({ deviceId: "d", idleMs: 1.5, servers: [] }));
  assert.equal(activityRegister.output.parse({ configured: true, serverId: "s", alerts: true, followsOfficialPolicy: true }).followsOfficialPolicy, true);
  assert.equal(activityRegister.output.parse({ configured: true, serverId: "s", alerts: true }).followsOfficialPolicy, undefined);
});
