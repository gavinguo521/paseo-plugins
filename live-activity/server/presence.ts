// 各 App 上报的「刚刚有人在用」：普通通知按 daemon 官方规则（agent-attention-policy）决定发不发——
// 3 分钟内有设备活跃，就由 daemon 选的那台在应用内弹通知，不再远程推送；都不活跃才推。
// 插件拿不到 daemon 的决策（0.15.x 不下发 shouldPush），只能靠 App 自己报：连着哪些机器、多久没操作了。

/** 同 daemon 的 PRESENCE_THRESHOLD_MS。 */
export const PRESENCE_MS = 180_000;
/** App 每 15 秒报一次；超过这么久没报（退到后台被挂起、退出了）就不算在用。 */
export const FRESH_MS = 45_000;

interface Seen {
  lastActivityAt: number;
  receivedAt: number;
  servers: ReadonlySet<string>;
}

export class Presence {
  private seen = new Map<string, Seen>();

  /** idleMs 由 App 算（距上次操作多久），这里按收到的时间换算，不依赖两边时钟一致。 */
  report(deviceId: string, idleMs: number, servers: readonly string[], now: number) {
    const idle = Math.max(0, idleMs);
    this.seen.set(deviceId, { lastActivityAt: now - idle, receivedAt: now, servers: new Set(servers) });
    for (const [id, s] of this.seen) if (now - s.receivedAt > FRESH_MS) this.seen.delete(id);
  }

  /** 连着这台机器、且 3 分钟内用过的设备（有就返回其中一台的 id）：这时 daemon 会让它在应用内弹，不该再推。 */
  activeOn(serverId: string, now: number): string | null {
    for (const [id, s] of this.seen) {
      if (now - s.receivedAt > FRESH_MS) continue;
      if (now - s.lastActivityAt > PRESENCE_MS) continue;
      if (s.servers.has(serverId)) return id;
    }
    return null;
  }
}
