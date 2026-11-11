import { z } from "zod";

export const scheduleID = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
export const scheduleNotificationState = z.object({
  version: z.literal(1), enabled: z.boolean(), revision: z.string(), ready: z.boolean(),
});
