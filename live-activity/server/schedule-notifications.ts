// The SDK does not expose schedules. Read the daemon's persisted run history on this
// execution host; never change its schedule files or depend on an agent surviving archive.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { scheduleID } from "../shared/schedule-notifications.ts";
import { buildNotificationPreview } from "./preview.ts";
import { clipChars } from "./summary.ts";
import { writeSecret } from "./store.ts";

const preferenceSchema = z.object({
  serverId: z.string().min(1), enabled: z.boolean(), revision: z.string(), enabledAt: z.number(),
});
const deliverySchema = z.object({ at: z.number(), sent: z.boolean(), attempts: z.number(), nextAttemptAt: z.number() });
const stateSchema = z.object({
  version: z.literal(1), preferences: z.record(scheduleID, preferenceSchema), deliveries: z.record(z.string(), deliverySchema),
});
const runSchema = z.object({
  id: z.string(), status: z.enum(["running", "succeeded", "failed"]), endedAt: z.string().nullable(),
  agentId: z.string().nullable().optional(), output: z.string().nullable().optional(), error: z.string().nullable().optional(),
});
const scheduleSchema = z.object({
  id: scheduleID, name: z.string().nullable().optional(), prompt: z.string(),
  target: z.object({ type: z.string(), config: z.object({ title: z.string().nullable().optional() }).optional() }),
  runs: z.array(runSchema),
});
type StoredSchedule = z.infer<typeof scheduleSchema>;
type Run = z.infer<typeof runSchema>;
type State = z.infer<typeof stateSchema>;

// Bounded recovery after transient network failures, without replaying old history.
export const RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export function scheduleResultPayload(serverId: string, schedule: StoredSchedule, run: Run) {
  const failed = run.status === "failed";
  const name = clipChars(schedule.name?.trim() || schedule.target.config?.title?.trim() || schedule.prompt.trim() || "计划任务", 80);
  return {
    aps: {
      alert: {
        title: `${failed ? "计划任务失败" : "计划任务完成"} · ${name}`,
        body: buildNotificationPreview(failed ? run.error : run.output)
          ?? (failed ? "任务未能完成，点开查看运行记录。" : "任务已完成，点开查看运行结果。"),
      },
      sound: "default", category: "paseo.schedule-result", "thread-id": `${serverId}:schedule:${schedule.id}`,
    },
    reason: "schedule_result", serverId, scheduleId: schedule.id, runId: run.id,
    ...(run.agentId ? { agentId: run.agentId } : {}),
  };
}
export type ScheduleResultPayload = ReturnType<typeof scheduleResultPayload>;

export interface ScheduleDelivery {
  targets(serverId: string): string[];
  availableSince?(target: string): number;
  send(deviceId: string, payload: ScheduleResultPayload, collapseId: string): Promise<boolean>;
}

export class ScheduleNotifications {
  private state: State = { version: 1, preferences: {}, deliveries: {} };
  private loaded = false;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly path: string;

  constructor(private dir: string, private delivery: ScheduleDelivery, private now = Date.now,
              private log: (message: string) => void = () => {}) {
    this.path = join(dir, "schedule-notifications.json");
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work);
    this.chain = result.catch(() => {});
    return result;
  }

  private async load() {
    if (this.loaded) return;
    try { this.state = stateSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.loaded = true;
  }

  private async persist(state = this.state) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeSecret(this.path, state);
  }

  private async schedule(id: string): Promise<StoredSchedule | null> {
    scheduleID.parse(id);
    try {
      const schedule = scheduleSchema.parse(JSON.parse(await readFile(join(dirname(this.dir), "schedules", `${id}.json`), "utf8")));
      if (schedule.id !== id) throw new Error("Schedule ID does not match its file");
      return schedule;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private snapshot(serverId: string, id?: string) {
    const pref = id && Object.hasOwn(this.state.preferences, id) ? this.state.preferences[id] : undefined;
    if (pref && pref.serverId !== serverId) throw new Error("通知设置属于另一台主机，请重新配置推送。");
    return { version: 1 as const, enabled: pref?.enabled ?? false, revision: pref?.revision ?? "missing",
      ready: this.delivery.targets(serverId).length > 0 };
  }

  read(serverId: string, id?: string) {
    return this.serial(async () => {
      if (id !== undefined) scheduleID.parse(id);
      await this.load();
      return this.snapshot(serverId, id);
    });
  }

  write(serverId: string, id: string, enabled: boolean, expectedRevision: string) {
    return this.serial(async () => {
      await this.load();
      scheduleID.parse(id);
      const current = this.snapshot(serverId, id);
      if (current.revision !== expectedRevision) throw new Error("通知设置已在其他设备修改，请重新打开任务后再保存。");
      if (enabled && !current.ready) throw new Error("请先在任务所在主机配置手机推送，并在手机上开启通知。");
      if (enabled) {
        const schedule = await this.schedule(id);
        if (!schedule || schedule.target.type !== "new-agent") throw new Error("计划任务不存在或不支持结果通知。");
      }
      if (enabled === current.enabled) return current;
      const next = structuredClone(this.state);
      next.preferences = { ...next.preferences, [id]: { serverId, enabled, revision: randomUUID(), enabledAt: this.now() } };
      await this.persist(next);
      this.state = next;
      return this.snapshot(serverId, id);
    });
  }

  poll() {
    return this.serial(async () => {
      await this.load();
      const now = this.now();
      let dirty = false;
      for (const [key, delivery] of Object.entries(this.state.deliveries)) {
        if (now - delivery.at > RESULT_MAX_AGE_MS) { delete this.state.deliveries[key]; dirty = true; }
      }
      for (const [id, pref] of Object.entries(this.state.preferences)) {
        if (!pref.enabled) continue;
        const devices = this.delivery.targets(pref.serverId);
        if (!devices.length) continue;
        let schedule: StoredSchedule | null;
        try { schedule = await this.schedule(id); }
        catch { this.log(`无法读取计划任务 ${id} 的运行记录，将稍后重试`); continue; }
        if (!schedule || schedule.target.type !== "new-agent") continue;
        for (const run of schedule.runs) {
          const at = Date.parse(run.endedAt ?? "");
          if (run.status === "running" || !Number.isFinite(at) || at <= pref.enabledAt || at > now
              || now - at > RESULT_MAX_AGE_MS) continue;
          const collapseId = createHash("sha256").update(JSON.stringify([pref.serverId, id, run.id])).digest("hex");
          for (const deviceId of devices) {
            // A newly configured destination must not receive older task history.
            if (at <= (this.delivery.availableSince?.(deviceId) ?? 0)) continue;
            const key = JSON.stringify([pref.serverId, id, run.id, deviceId]);
            const previous = this.state.deliveries[key];
            if (previous?.sent || (previous && previous.nextAttemptAt > now)) continue;
            let sent = false;
            try { sent = await this.delivery.send(deviceId, scheduleResultPayload(pref.serverId, schedule, run), collapseId); }
            catch { /* Preserve retry state for transport errors as well as APNs errors. */ }
            const attempts = (previous?.attempts ?? 0) + 1;
            this.state.deliveries[key] = { at, sent, attempts,
              nextAttemptAt: now + Math.min(60_000 * 2 ** Math.min(attempts - 1, 8), 30 * 60_000) };
            // Persist each delivery: another phone failing must not resend to phones already notified.
            await this.persist();
            dirty = false;
          }
        }
      }
      if (dirty) await this.persist();
    });
  }
}
