// App（plugin.rpc.invoke）与插件之间的 RPC 契约。App 已上线，字段名与语义不得改动。
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 令牌：App 传小写 hex；这里兼容大写并统一转小写（令牌会拼进 APNs 请求路径，必须严格校验）。
const token = z.string().min(1).max(512).regex(/^[0-9a-fA-F]+$/, "令牌必须是 hex").transform(v => v.toLowerCase());

export const registerInput = z.object({
  deviceId: z.string().min(1).max(200),
  // bundleId 会拼进 apns-topic 请求头，只允许合法的 bundle 字符。
  bundleId: z.string().min(1).max(200).regex(/^[A-Za-z0-9.-]+$/, "bundleId 不合法"),
  environment: z.enum(["development", "production"]),
  // 省略 = 保持原值；null = 清除。
  pushToStartToken: token.nullable().optional(),
  activityToken: token.nullable().optional(),
  // 普通通知的设备令牌（registerForRemoteNotifications）。省略 = 保持原值；null = 清除（App 里关了通知）。
  alertToken: token.nullable().optional(),
  hosts: z.array(z.object({ serverId: z.string().min(1).max(200), label: z.string().max(200) })).max(50),
});
export type RegisterInput = z.output<typeof registerInput>;

export const activityRegister = defineRpc({
  name: "activity.register",
  input: registerInput,
  // alerts = 该设备有 alertToken 且其环境已配密钥（插件会给它发普通通知）；App 只在为 true 时停掉后台本地通知。
  // followsOfficialPolicy = 插件遵守官方规则：daemon 给了 shouldPush 就照它，没给就按 presence.report 兜底
  // （有设备在用就不推，交给 daemon 选的设备应用内弹），所以 App 被选中时即使在后台也要自己弹（旧版插件没有这个字段）。
  output: z.object({
    configured: z.boolean(), serverId: z.string(), alerts: z.boolean(), followsOfficialPolicy: z.boolean().optional(),
  }),
});

export const presenceReport = defineRpc({
  name: "presence.report",
  input: z.object({
    deviceId: z.string().min(1).max(200),
    // 距上次操作的毫秒数（App 算，避开两边时钟不一致）。
    idleMs: z.number().int().min(0).max(7 * 24 * 3600 * 1000),
    // 这台设备当前连着的机器 serverId：daemon 只会在这些机器的会话上选它弹应用内通知。
    servers: z.array(z.string().min(1).max(200)).max(50),
  }),
  output: z.object({ ok: z.boolean() }),
});

export const activityUnregister = defineRpc({
  name: "activity.unregister",
  input: z.object({ deviceId: z.string().min(1).max(200) }),
  output: z.object({ ok: z.boolean() }),
});

export const activityConfigure = defineRpc({
  name: "activity.configure",
  // environment 省略 = 两个环境都用这把（兼容旧版 App）；Apple 后台按环境分开建的密钥要指明。
  input: z.object({ teamId: z.string(), keyId: z.string(), p8: z.string(), environment: z.enum(["development", "production"]).optional() }),
  output: z.object({ configured: z.boolean() }),
});

export const lastPushSchema = z.object({
  at: z.number(), ok: z.boolean(), status: z.number().nullable(), reason: z.string().nullable(),
});
export type LastPush = z.output<typeof lastPushSchema>;

export const activityStatus = defineRpc({
  name: "activity.status",
  input: z.object({}),
  output: z.object({
    // 任一环境配了密钥即为 true；teamId / keyId 是其中一把（先 development），给旧版 App 显示用。
    configured: z.boolean(),
    teamId: z.string().nullable(),
    keyId: z.string().nullable(),
    // 每个环境的密钥（不含私钥内容）。development = Xcode 直装，production = TestFlight / Ad Hoc / App Store。
    keys: z.object({
      development: z.object({ teamId: z.string(), keyId: z.string() }).nullable(),
      production: z.object({ teamId: z.string(), keyId: z.string() }).nullable(),
    }),
    devices: z.number(),
    lastPush: lastPushSchema.nullable(),
  }),
});
