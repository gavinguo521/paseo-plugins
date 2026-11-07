// 使用 daemon 在事件发生时计算的决策，不缓存 / 推算其他设备的活跃状态。
import { z } from "zod";
import { ALERT_MAX_AGE_MS } from "./notify.ts";

const schema = z.object({
  type: z.literal("agent_attention_required"),
  payload: z.object({
    agentId: z.string().min(1),
    reason: z.enum(["finished", "permission", "error"]),
    timestamp: z.string(),
    shouldPush: z.boolean().optional(),
    permissionRequestId: z.string().optional(),
    notification: z.object({ title: z.string(), body: z.string() }),
  }),
});
export type NotificationDecision = z.output<typeof schema>["payload"];

export function readNotificationDecision(message: unknown, now: number): NotificationDecision | null {
  const parsed = schema.safeParse(message);
  if (!parsed.success) return null;
  const at = Date.parse(parsed.data.payload.timestamp);
  if (!Number.isFinite(at) || now - at >= ALERT_MAX_AGE_MS) return null;
  return parsed.data.payload;
}

export function decisionPayload(serverId: string, event: NotificationDecision) {
  return {
    aps: {
      alert: event.notification,
      sound: "default",
      category: event.reason === "permission" ? "paseo.permission" : "paseo.finished",
      "thread-id": `${serverId}:${event.agentId}`,
    },
    serverId,
    agentId: event.agentId,
    reason: event.reason,
    ...(event.reason === "permission" && event.permissionRequestId ? { requestId: event.permissionRequestId } : {}),
  };
}
