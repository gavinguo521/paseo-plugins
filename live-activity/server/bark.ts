import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeSecret } from "./store.ts";
import type { ScheduleResultPayload } from "./schedule-notifications.ts";
import type { NotificationDecision } from "./notification-decision.ts";
import { ALERT_MAX_AGE_MS } from "./notify.ts";

const configSchema = z.object({
  version: z.literal(1), serverId: z.string().min(1), endpoint: z.string().url(),
  deviceKey: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), configuredAt: z.number().finite(),
  completionEnabledAt: z.number().finite().nullable().default(null),
});
type Config = z.infer<typeof configSchema>;
export type BarkResult = { at: number; ok: boolean; status: number | null; reason: string | null };

// Accept the address or a test URL copied from Bark. Never retain its sample
// message/query. Use POST /push so device keys do not appear in request URLs.
export function parseBarkURL(input: string) {
  const invalid = () => new Error("请粘贴 Bark 首页的 HTTPS 推送地址（服务器地址/设备密钥）。");
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw invalid(); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw invalid();
  const key = url.pathname.split("/")[1];
  if (!key || !/^[A-Za-z0-9_-]{1,256}$/.test(key) || key === "push") throw invalid();
  return { endpoint: `${url.origin}/push`, deviceKey: key };
}

export function scheduleBarkURL(payload: Pick<ScheduleResultPayload, "serverId" | "scheduleId">) {
  const url = new URL("paseonative://schedule");
  url.searchParams.set("serverId", payload.serverId);
  url.searchParams.set("scheduleId", payload.scheduleId);
  return url.toString();
}

export class BarkDelivery {
  private config: Config | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  private lastPush: BarkResult | null = null;
  readonly ready: Promise<void>;

  constructor(private dir: string, private request: typeof fetch = fetch, private now = Date.now) {
    this.path = join(dir, "bark.json");
    this.ready = this.load();
  }

  private async load() {
    try {
      const config = configSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
      const endpoint = new URL(config.endpoint);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password
          || config.endpoint !== `${endpoint.origin}/push`) throw new Error("Invalid endpoint");
      this.config = config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("无法读取 Bark 配置，请检查主机上的配置文件。");
    }
  }

  private serial<T>(work: () => Promise<T>) {
    const result = this.chain.then(async () => { await this.ready; return work(); });
    this.chain = result.catch(() => {});
    return result;
  }

  private target(config: Config) {
    return "bark:" + createHash("sha256").update(JSON.stringify([config.serverId, config.endpoint, config.deviceKey])).digest("hex");
  }

  targetFor(serverId: string) { return this.config?.serverId === serverId ? this.target(this.config) : null; }
  completionTargetFor(serverId: string) {
    return this.config?.completionEnabledAt != null ? this.targetFor(serverId) : null;
  }
  availableSince(target: string) { return this.config && target === this.target(this.config) ? this.config.configuredAt : 0; }

  status() {
    return { configured: this.config !== null, serverURL: this.config ? new URL(this.config.endpoint).origin : null,
      notifyOnFinish: this.config?.completionEnabledAt != null, lastPush: this.lastPush };
  }

  configure(serverId: string, pushURL: string) {
    return this.serial(async () => {
      const parsed = parseBarkURL(pushURL);
      const same = this.config?.serverId === serverId && this.config.endpoint === parsed.endpoint
        && this.config.deviceKey === parsed.deviceKey;
      const next: Config = { version: 1, serverId, ...parsed, configuredAt: same ? this.config!.configuredAt : this.now(),
        completionEnabledAt: same ? this.config!.completionEnabledAt : null };
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeSecret(this.path, next);
      this.config = next;
      if (!same) this.lastPush = null;
      return this.status();
    });
  }

  setNotifyOnFinish(serverId: string, enabled: boolean) {
    return this.serial(async () => {
      if (!this.config || this.config.serverId !== serverId) throw new Error("请先保存这台主机的 Bark 推送地址。");
      const next = { ...this.config, completionEnabledAt: enabled ? this.config.completionEnabledAt ?? this.now() : null };
      await writeSecret(this.path, next);
      this.config = next;
      return this.status();
    });
  }

  clear() {
    return this.serial(async () => {
      // Removing the file also makes a restart behave like a fresh installation.
      await rm(this.path, { force: true });
      this.config = null;
      this.lastPush = null;
      return this.status();
    });
  }

  test(serverId: string) {
    return this.serial(async () => {
      const config = this.config;
      if (!config || config.serverId !== serverId) throw new Error("请先保存这台主机的 Bark 推送地址。");
      return this.send(config, { title: "Paseo · Bark 测试", body: "这是一条连接测试通知，收到后可开启会话完成通知或计划任务结果通知。",
        group: "Paseo", id: `paseo-test-${randomUUID()}` });
    });
  }

  sendResult(target: string, payload: ScheduleResultPayload, collapseId: string) {
    return this.serial(async () => {
      const config = this.config;
      if (!config || config.serverId !== payload.serverId || this.target(config) !== target) return false;
      const result = await this.send(config, { title: payload.aps.alert.title, body: payload.aps.alert.body,
        group: "Paseo 计划任务", id: collapseId, url: scheduleBarkURL(payload) });
      return result.ok;
    });
  }

  sendCompletion(target: string, serverId: string, event: NotificationDecision) {
    return this.serial(async () => {
      const config = this.config;
      const at = Date.parse(event.timestamp);
      if (!config || config.serverId !== serverId || this.target(config) !== target
          || config.completionEnabledAt === null || event.reason !== "finished"
          || !Number.isFinite(at) || at < Math.max(config.configuredAt, config.completionEnabledAt)
          || this.now() - at >= ALERT_MAX_AGE_MS) return false;
      // One ID per completed turn, shared by duplicate deliveries. A later turn
      // in the same conversation must still produce a new notification.
      const id = "paseo-finished-" + createHash("sha256")
        .update(JSON.stringify([serverId, event.agentId, event.timestamp])).digest("hex").slice(0, 48);
      const url = `paseonative://agent/${encodeURIComponent(serverId)}/${encodeURIComponent(event.agentId)}`;
      return (await this.send(config, { title: event.notification.title, body: event.notification.body,
        group: "Paseo 会话", id, url })).ok;
    });
  }

  private async send(config: Config, message: Record<string, string>): Promise<BarkResult> {
    let result: BarkResult;
    try {
      const response = await this.request(config.endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error",
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ ...message, device_key: config.deviceKey, level: "active" }),
      });
      const value = await response.json().catch(() => null) as { code?: unknown } | null;
      const ok = response.ok && value?.code === 200;
      result = { at: this.now(), ok, status: response.status,
        // Server messages and fetch errors may contain the supplied key. Never
        // echo them through plugin RPCs, logs, or the settings UI.
        reason: ok ? null : response.ok ? "Bark 未接受推送，请检查设备密钥。" : `Bark 请求失败（HTTP ${response.status}）。` };
    } catch {
      result = { at: this.now(), ok: false, status: null, reason: "无法连接 Bark，请检查主机网络和服务器地址。" };
    }
    this.lastPush = result;
    return result;
  }
}
