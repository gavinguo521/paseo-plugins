// 调度：汇总状态 → 去抖 → 按设备决定推送 → 调 APNs → 回写设备记录。
import type { LastPush, RegisterInput } from "../shared/contracts.ts";
import { ApnsClient, validateKey, type ApnsKey, type ApnsKeys } from "./apns.ts";
import { applyRegister, applyResult, decide, isDeadToken, newDevice, settleIdle, type Device, type Environment } from "./decide.ts";
import { alertsEnabled, alertTargets, buildAlertPayload, ALERT_MAX_AGE_MS } from "./notify.ts";
import { Presence } from "./presence.ts";
import { Sources, type Api } from "./sources.ts";
import { Store } from "./store.ts";
import { buildState } from "./summary.ts";
import { ScheduleNotifications, type ScheduleResultPayload } from "./schedule-notifications.ts";
import { BarkDelivery } from "./bark.ts";

import { decisionPayload, type NotificationDecision } from "./notification-decision.ts";

const DEBOUNCE_MS = 1500;
const TICK_MS = 60_000;

const log = (line: string) => console.log(`live-activity: ${line}`);
const short = (token: string) => `${token.slice(0, 8)}…`;

export class LiveActivity {
  private devices = new Map<string, Device>();
  private keys: ApnsKeys = {};
  private apns = new ApnsClient();
  private sources: Sources | null = null;
  private started: Promise<void> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** 普通通知独立排队，不阻塞灵动岛的 evaluate。 */
  private alertChain: Promise<void> = Promise.resolve();
  /** 已排队的通知（serverId:agentId:时间戳 → 排队时间），重复事件去重。 */
  private alerted = new Map<string, number>();
  /** 设备记录的写盘串行化，后写的总是最新状态。 */
  private saving: Promise<void> = Promise.resolve();
  /** 已经提示过「没配这个环境的密钥」的环境，免得每次都打日志。 */
  private warnedUnconfigured = new Set<Environment>();
  private disposed = false;
  private presence = new Presence();
  private scheduleTick: ReturnType<typeof setInterval> | null = null;
  readonly scheduleNotifications: ScheduleNotifications;
  readonly bark: BarkDelivery;
  lastPush: LastPush | null = null;
  readonly ready: Promise<void>;

  constructor(private readonly store = new Store()) {
    this.bark = new BarkDelivery(store.dir);
    this.scheduleNotifications = new ScheduleNotifications(store.dir, {
      targets: serverId => {
        if (this.disposed) return [];
        const bark = this.bark.targetFor(serverId);
        // One selected transport for task results; do not notify the same phone
        // through both Bark and the app's APNs registration.
        return bark ? [bark] : alertTargets(this.devices.values(), serverId)
          .filter(({ device }) => this.alertsFor(device.deviceId)).map(({ device }) => device.deviceId);
      },
      availableSince: target => this.bark.availableSince(target),
      send: (deviceId, payload, collapseId) => deviceId.startsWith("bark:")
        ? this.bark.sendResult(deviceId, payload, collapseId) : this.sendScheduleResult(deviceId, payload, collapseId),
    }, Date.now, log);
    this.ready = this.load();
    // Start without waiting for a hook or a foreground phone. A run can fail before
    // creating an agent, including immediately after the daemon restarts.
    void this.ready.then(() => {
      if (this.disposed) return;
      const poll = () => { void this.scheduleNotifications.poll().catch(() => log("计划任务通知检查失败，将稍后重试")); };
      this.scheduleTick = setInterval(poll, 15_000);
      this.scheduleTick.unref();
      poll();
    }).catch(() => log("推送配置读取失败，请检查主机配置文件"));
  }

  private async sendScheduleResult(deviceId: string, payload: ScheduleResultPayload, collapseId: string): Promise<boolean> {
    const device = this.devices.get(deviceId);
    if (this.disposed || !device || !this.alertsFor(deviceId)
        || !device.hosts.some(h => h.serverId === payload.serverId)) return false;
    const token = device.alertToken!;
    // This is a per-schedule opt-in. Unlike ordinary chat completion notifications,
    // it is not suppressed when a Mac is active or the run's agent was archived.
    const result = await this.apns.send(device.environment, token, device.bundleId, 10, payload, { pushType: "alert", collapseId });
    this.lastPush = { at: Date.now(), ok: result.ok, status: result.status, reason: result.reason };
    if (!result.ok && isDeadToken(result.status, result.reason) && device.alertToken === token) {
      device.alertToken = null;
      await this.persist();
    }
    log(`计划任务结果通知：${result.ok ? "成功" : `失败 ${result.status ?? "-"}，等待重试`}`);
    return result.ok;
  }

  private async load() {
    try {
      await this.bark.ready;
      if (this.bark.loadError) log(this.bark.loadError);
    } catch (error) { log(`读取 Bark 配置失败：${(error as Error).message}`); }
    try {
      for (const device of await this.store.loadDevices()) this.devices.set(device.deviceId, device);
    } catch (error) { log(`读取设备记录失败：${(error as Error).message}`); }
    try {
      this.keys = await this.store.loadKeys();
      this.apns.setKeys(this.keys);
    } catch { log("读取 APNs 密钥失败，按未配置处理"); }
  }

  get configured() { return this.apns.configured; }
  get deviceCount() { return this.devices.size; }
  configuredFor(env: Environment) { return this.apns.configuredFor(env); }
  get keyInfo() {
    const brief = (k?: ApnsKey) => k ? { teamId: k.teamId, keyId: k.keyId } : null;
    const first = this.keys.development ?? this.keys.production;
    return {
      teamId: first?.teamId ?? null, keyId: first?.keyId ?? null,
      keys: { development: brief(this.keys.development), production: brief(this.keys.production) },
    };
  }

  /** 第一次拿到 paseo（hook / RPC 回调）时启动数据源订阅。 */
  ensureStarted(paseo: Api): Promise<void> {
    if (!this.started) {
      this.started = this.start(paseo).catch(error => {
        log(`启动失败：${(error as Error).message}`);
        this.started = null;
      });
    }
    return this.started;
  }

  private async start(paseo: Api) {
    await this.ready;
    const sources = new Sources(paseo, () => this.schedule(), log, (serverId, event) => this.notify(serverId, event));
    this.sources = sources;
    await sources.init();
    await sources.sync(this.allHosts());
    if (this.disposed) { await sources.close(); return; }
    this.tick = setInterval(() => {
      void sources.healthCheck().catch(() => {}).then(() => this.evaluateAll());
    }, TICK_MS);
    log(`已启动，本机 serverId=${sources.selfId}，设备 ${this.devices.size} 台`);
    this.evaluateAll();
  }

  private allHosts() {
    return [...this.devices.values()].flatMap(d => d.hosts);
  }

  /** 状态可能变了：去抖 1.5 秒后重算。 */
  schedule() {
    if (this.disposed) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; this.evaluateAll(); }, DEBOUNCE_MS);
  }

  evaluateAll() {
    this.enqueue(async () => {
      for (const device of [...this.devices.values()]) await this.evaluate(device);
    });
  }

  private enqueue(task: () => Promise<void>) {
    this.chain = this.chain.then(task).catch(error => log(`处理出错：${(error as Error).message}`));
  }

  private async evaluate(device: Device) {
    const sources = this.sources;
    if (!sources || this.disposed || this.devices.get(device.deviceId) !== device) return;
    const hosts = device.hosts.map(h => sources.hostData(h));
    // 一台机器的数据都还没拿到时不能据此结束活动。
    if (!hosts.some(h => h.agents)) return;
    const now = Date.now();
    const state = buildState(hosts, now / 1000);
    if (settleIdle(device, state, now)) await this.persist();
    const steps = decide(device, state, now);
    if (!steps.length) return;
    if (!this.apns.configuredFor(device.environment)) {
      if (!this.warnedUnconfigured.has(device.environment)) {
        log(`未配置 ${device.environment} 环境的 APNs 密钥，不给这类设备推送（App 设置里配置后生效）`);
      }
      this.warnedUnconfigured.add(device.environment);
      return;
    }
    let dirty = false;
    for (const step of steps) {
      const result = await this.apns.send(device.environment, step.token, device.bundleId, step.priority, step.payload);
      const at = Date.now();
      this.lastPush = { at, ok: result.ok, status: result.status, reason: result.reason };
      log(`${step.kind} → ${step.tokenKind === "activity" ? "activity" : "push-to-start"} ${short(step.token)}（设备 ${device.deviceId.slice(0, 8)}，优先级 ${step.priority}）：`
        + (result.ok ? "成功" : `失败 ${result.status ?? "-"} ${result.reason ?? ""}`));
      dirty = applyResult(device, step, result, at) || dirty;
      if (!result.ok) break;
    }
    if (dirty) await this.persist();
  }

  private persist(): Promise<void> {
    const write = this.saving.then(() => this.store.saveDevices([...this.devices.values()]));
    this.saving = write.catch(() => {});
    return write.catch(error => log(`保存设备记录失败：${(error as Error).message}`));
  }

  /** daemon 的提醒信号有新时间戳：给相关设备发普通通知（同一会话同一时间戳只发一次）。 */
  private notify(serverId: string, event: NotificationDecision) {
    if (this.disposed) return;
    const now = Date.now();
    const key = `${serverId}:${event.agentId}:${event.reason}:${event.permissionRequestId ?? ""}:${event.timestamp}`;
    if (this.alerted.has(key)) return;
    for (const [k, at] of this.alerted) if (now - at > 2 * ALERT_MAX_AGE_MS) this.alerted.delete(k);
    this.alerted.set(key, now);
    this.alertChain = this.alertChain
      .then(() => this.sendAlerts(serverId, event))
      .catch(error => log(`发送通知出错：${(error as Error).message}`));
  }

  reportPresence(deviceId: string, idleMs: number, servers: readonly string[]) {
    this.presence.report(deviceId, idleMs, servers, Date.now());
  }

  private async sendAlerts(serverId: string, event: NotificationDecision) {
    if (this.disposed) return;
    const barkTarget = event.reason === "finished" ? this.bark.completionTargetFor(serverId) : null;
    if (barkTarget) {
      // Bark is an explicit phone subscription, independent of which desktop is
      // active. Observe only; the daemon still delivers its original Mac alert.
      const context = await this.sources?.resolveNotificationContext(serverId, event.agentId);
      if (this.disposed) return;
      if (!context) { log("会话完成通知暂未发送：无法读取会话信息"); return; }
      const labels = context.agent.labels;
      // Scheduled runs have their own result notification, including failures
      // before agent creation. Child agents should notify through their parent.
      if (labels["paseo.schedule-id"] || labels["paseo.schedule-run"] || labels["paseo.parent-agent-id"]) return;
      const title = buildAlertPayload({ serverId, hostLabel: "", ...context, reason: "finished" }).aps.alert.title;
      const ok = await this.bark.sendCompletion(barkTarget, serverId, { ...event,
        notification: { ...event.notification, title } });
      log(`Bark 会话完成通知：${ok ? "成功" : "未发送或发送失败"}`);
      // A configured completion subscription replaces APNs for this event only.
      return;
    }
    if (event.shouldPush === false || event.reason === "error") return;
    // 打过通知补丁的 daemon 给了 shouldPush，照它的；
    // 没给（未打补丁）就按 App 上报的在用状态兜底：有设备在用，daemon 会让它在应用内弹，不再推。
    if (event.shouldPush === undefined) {
      const active = this.presence.activeOn(serverId, Date.now());
      if (active) {
        log(`通知（${event.reason}）不推送：设备 ${active.slice(0, 8)} 正在使用，交给 daemon 选中的设备`);
        return;
      }
    }
    let dirty = false;
    const targets = alertTargets(this.devices.values(), serverId);
    if (this.disposed) return;
    for (const { device, hostLabel } of targets) {
      if (this.disposed) return;
      const token = device.alertToken;
      if (!token) continue;
      if (!this.apns.configuredFor(device.environment)) {
        if (!this.warnedUnconfigured.has(device.environment)) {
          log(`未配置 ${device.environment} 环境的 APNs 密钥，不给这类设备推送（App 设置里配置后生效）`);
        }
        this.warnedUnconfigured.add(device.environment);
        continue;
      }
      const payload = decisionPayload(serverId, event);
      // 保留已有工作区标题，正文使用该次事件的官方快照，避免再次拉取时串到下一回合。
      const context = this.sources?.notificationContext(serverId, event.agentId);
      if (context) payload.aps.alert = { ...event.notification, title: buildAlertPayload({
        serverId, hostLabel, ...context, reason: event.reason, requestId: event.permissionRequestId,
      }).aps.alert.title };
      const result = await this.apns.send(device.environment, token, device.bundleId, 10, payload, {
        pushType: "alert", collapseId: event.agentId,
      });
      const at = Date.now();
      this.lastPush = { at, ok: result.ok, status: result.status, reason: result.reason };
      log(`通知（${event.reason}）→ alert ${short(token)}（设备 ${device.deviceId.slice(0, 8)}）：`
        + (result.ok ? "成功" : `失败 ${result.status ?? "-"} ${result.reason ?? ""}`));
      // 令牌失效只清 alertToken；推送期间 App 可能已登记新令牌，只清刚用过的那个。其他失败不重试。
      if (!result.ok && isDeadToken(result.status, result.reason) && device.alertToken === token) {
        device.alertToken = null;
        dirty = true;
      }
    }
    if (dirty) await this.persist();
  }

  /** register 输出的 alerts：插件会不会给这台设备发普通通知。 */
  alertsFor(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    return !!device && alertsEnabled(device, env => this.apns.configuredFor(env));
  }

  async register(input: RegisterInput): Promise<void> {
    await this.ready;
    const now = Date.now();
    const old = this.devices.get(input.deviceId);
    // 就地修改已有记录：正在进行的推送回写的是同一个对象。
    const device = applyRegister(old ?? newDevice(input), input, now);
    this.devices.set(device.deviceId, device);
    await this.persist();
    log(`设备 ${device.deviceId.slice(0, 8)} 已登记（${device.environment}，机器 ${device.hosts.length} 台，`
      + `activity ${device.activityToken ? short(device.activityToken) : "无"}，push-to-start ${device.pushToStartToken ? short(device.pushToStartToken) : "无"}，`
      + `alert ${device.alertToken ? short(device.alertToken) : "无"}）`);
    // 不等新机器连上再回复（连不上时要等几十秒，App 会当作超时）；数据到了订阅会触发重算。
    void this.sources?.sync(this.allHosts()).catch(error => log(`同步机器失败：${(error as Error).message}`));
    // 注册后立即按当前状态推一次（如需要）。
    this.enqueue(() => this.evaluate(device));
  }

  async unregister(deviceId: string): Promise<boolean> {
    await this.ready;
    const existed = this.devices.delete(deviceId);
    if (existed) {
      await this.persist();
      await this.sources?.sync(this.allHosts());
      log(`设备 ${deviceId.slice(0, 8)} 已移除`);
    }
    return existed;
  }

  /** environment 省略 = 两个环境都用这把（兼容旧版 App）。 */
  async configure(input: ApnsKey & { environment?: Environment }): Promise<void> {
    await this.ready;
    const key = validateKey(input);
    const envs: Environment[] = input.environment ? [input.environment] : ["development", "production"];
    const next: ApnsKeys = { ...this.keys };
    for (const env of envs) next[env] = key;
    await this.store.saveKeys(next);
    this.keys = next;
    this.apns.setKeys(next);
    for (const env of envs) this.warnedUnconfigured.delete(env);
    log(`APNs 密钥已配置（Key ID ${key.keyId}，${envs.join(" + ")}）`);
    this.evaluateAll();
  }

  async selfServerId(paseo: Api): Promise<string> {
    if (this.sources?.selfId) return this.sources.selfId;
    return (await paseo.hosts.list()).self.serverId;
  }

  dispose() {
    this.disposed = true;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.tick) clearInterval(this.tick);
    if (this.scheduleTick) clearInterval(this.scheduleTick);
    void this.sources?.close();
    this.apns.close();
  }
}
