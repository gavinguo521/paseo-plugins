// 持久化：<PASEO_HOME 或 ~/.paseo>/live-activity/ 下的 devices.json 与 apns-key.json（均 0600）。
// 不放进插件 settings：settings 会被客户端读到。
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApnsKey, ApnsKeys } from "./apns.ts";
import type { Device } from "./decide.ts";

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PASEO_HOME || join(homedir(), ".paseo"), "live-activity");
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 先写临时文件（0600）再改名，避免写一半被读到。 */
export async function writeSecret(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export class Store {
  readonly dir: string;
  constructor(dir: string = dataDir()) { this.dir = dir; }

  private async ensureDir() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  async loadDevices(): Promise<Device[]> {
    const raw = await readJson(join(this.dir, "devices.json"));
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { devices?: unknown }).devices)) return [];
    return ((raw as { devices: Partial<Device>[] }).devices).filter(d => d && typeof d.deviceId === "string").map(d => ({
      deviceId: d.deviceId!,
      bundleId: d.bundleId ?? "",
      environment: d.environment === "development" ? "development" : "production",
      pushToStartToken: d.pushToStartToken ?? null,
      activityToken: d.activityToken ?? null,
      // 旧记录没有该字段，按 null 读。
      alertToken: d.alertToken ?? null,
      hosts: Array.isArray(d.hosts) ? d.hosts : [],
      activityStartedAt: d.activityStartedAt ?? null,
      lastStartAt: d.lastStartAt ?? null,
      lastSent: d.lastSent ?? null,
      lastSentWaiting: d.lastSentWaiting ?? 0,
    }));
  }

  async saveDevices(devices: readonly Device[]) {
    await this.ensureDir();
    await writeSecret(join(this.dir, "devices.json"), { version: 1, devices });
  }

  /** 新格式 {version:2, keys:{development?, production?}}；旧格式（单把 {teamId,keyId,p8}）当作两个环境都用。 */
  async loadKeys(): Promise<ApnsKeys> {
    const raw = await readJson(join(this.dir, "apns-key.json")) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return {};
    const one = (v: unknown): ApnsKey | undefined => {
      const k = v as Partial<ApnsKey> | null;
      return k && typeof k.teamId === "string" && typeof k.keyId === "string" && typeof k.p8 === "string"
        ? { teamId: k.teamId, keyId: k.keyId, p8: k.p8 } : undefined;
    };
    const legacy = one(raw);
    if (legacy) return { development: legacy, production: legacy };
    const keys = (raw.keys ?? {}) as Record<string, unknown>;
    const result: ApnsKeys = {};
    const dev = one(keys.development), prod = one(keys.production);
    if (dev) result.development = dev;
    if (prod) result.production = prod;
    return result;
  }

  async saveKeys(keys: ApnsKeys) {
    await this.ensureDir();
    await writeSecret(join(this.dir, "apns-key.json"), { version: 2, keys });
  }
}
