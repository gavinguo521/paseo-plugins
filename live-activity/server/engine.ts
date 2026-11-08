// 调度：汇总状态 → 去抖 → 按设备决定推送 → 调 APNs → 回写设备记录。
import type { LastPush, RegisterInput } from "../shared/contracts.ts";
import { ApnsClient, validateKey, type ApnsKey, type ApnsKeys } from "./apns.ts";
import { applyRegister, applyResult, decide, isDeadToken, newDevice, settleIdle, type Device, type Environment } from "./decide.ts";
import { alertsEnabled, alertTargets, buildAlertPayload, ALERT_MAX_AGE_MS, type AlertEvent } from "./notify.ts";
import { Presence } from "./presence.ts";
import { Sources, type Api } from "./sources.ts";
import { Store } from "./store.ts";
import { buildState, type WorkspaceInfo } from "./summary.ts";

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
  lastPush: LastPush | null = null;
  readonly ready: Promise<void>;

  constructor(private readonly store = new Store()) {
    this.ready = this.load();
  }

  private async load() {
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
    const sources = new Sources(paseo, () => this.schedule(), log, (serverId, event, workspaces) => this.notify(serverId, event, workspaces));
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
  private notify(serverId: string, event: AlertEvent, workspaces: ReadonlyMap<string, WorkspaceInfo>) {
    if (this.disposed) return;
    const now = Date.now();
    const key = `${serverId}:${event.agent.id}:${event.timestamp}`;
    if (this.alerted.has(key)) return;
    for (const [k, at] of this.alerted) if (now - at > 2 * ALERT_MAX_AGE_MS) this.alerted.delete(k);
    this.alerted.set(key, now);
    this.alertChain = this.alertChain
      .then(() => this.sendAlerts(serverId, event, workspaces))
      .catch(error => log(`发送通知出错：${(error as Error).message}`));
  }

  /** 「完成」通知正文用会话最后一条回复；取不到返回 null（退回原正文，照常发通知）。 */
  private async lastReply(serverId: string, agentId: string): Promise<string | null> {
    try {
      return await this.sources?.lastReply(serverId, agentId) ?? null;
    } catch (error) {
      log(`取会话 ${agentId.slice(0, 8)} 最后回复失败，正文退回项目名：${(error as Error).message}`);
      return null;
    }
  }

  reportPresence(deviceId: string, idleMs: number, servers: readonly string[]) {
    this.presence.report(deviceId, idleMs, servers, Date.now());
  }

  private async sendAlerts(serverId: string, event: AlertEvent, workspaces: ReadonlyMap<string, WorkspaceInfo>) {
    // 官方规则：有设备在用，daemon 会让它在应用内弹（正看着这个会话时谁都不弹），远程推送就不发。
    const active = this.presence.activeOn(serverId, Date.now());
    if (active) {
      log(`通知（${event.reason}）不推送：设备 ${active.slice(0, 8)} 正在使用，交给 daemon 选中的设备`);
      return;
    }
    let dirty = false;
    const targets = alertTargets(this.devices.values(), serverId);
    // 有设备真的会收到时才去取最后回复（所有设备共用一次）。
    const sendable = targets.some(t => this.apns.configuredFor(t.device.environment));
    const assistantMessage = event.reason === "finished" && sendable ? await this.lastReply(serverId, event.agent.id) : null;
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
      const payload = buildAlertPayload({ serverId, hostLabel, agent: event.agent, reason: event.reason, workspaces, requestId: event.requestId, assistantMessage });
      const result = await this.apns.send(device.environment, token, device.bundleId, 10, payload, {
        pushType: "alert", collapseId: event.agent.id,
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
    void this.sources?.close();
    this.apns.close();
  }
}
