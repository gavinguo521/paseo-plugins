// 对固定版本增加可选通知字段；不改官方决策，也不启动 / 重启 daemon。
import { createHash } from "node:crypto";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hashes = {
  session: ["8501c67dc2281740bfa5947457cb252fb00151707f27791bad7820f3b45c626b"],
  server: ["4f5a770d175334cb06cf7dbbba42714a2bf5fd5d6f16aae9682226a7ce64d466"], // 0.15.2
  protocol: ["7fae4753f56af42b9c418904d191eeb63339e0caebc52493864602009098b589", // 0.15.2
    "2f6c0065d83bce09e1d138b89c0d84be4849faf071f569600b157f9b87929a6f"], // 0.15.0
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const serverInsertion = (indent: string) => `${indent}// paseo-native-notification-decision-v1\n${indent}shouldPush: plan.shouldPush,\n${indent}permissionRequestId: findLatestPermissionRequest(agent.pendingPermissions)?.id,\n`;
const sessionAnchor = 'type: "session.events.set_subscription.response",\n                    payload: { requestId: msg.requestId, subscriptionId: owner.responseId';
const responseAnchor = 'type: z.literal("session.events.set_subscription.response"),\n    payload: z.object({ requestId: z.string(), subscriptionId: z.string().optional()';
const capability = ', notificationDecision: "official-v1"';
const capabilitySchema = ', notificationDecision: z.literal("official-v1").optional()';
const protocolInsertion = "        // paseo-native-notification-decision-v1\n        shouldPush: z.boolean().optional(),\n        permissionRequestId: z.string().optional(),\n";

export function patchSource(kind: keyof typeof hashes, source: string): string {
  let original = source;
  if (kind === "server") {
    for (const indent of ["                ", "                            "]) original = original.replace(serverInsertion(indent), "");
  } else if (kind === "session") original = original.replace(sessionAnchor + capability, sessionAnchor);
  else original = original.replaceAll(protocolInsertion, "").replace(responseAnchor + capabilitySchema, responseAnchor);
  if (!hashes[kind].includes(digest(original))) throw new Error(`不支持的 ${kind} 文件，停止修改；需要针对当前官方版本重新验证`);
  let patched = original;
  if (kind === "server") {
    for (const indent of ["                ", "                            "]) {
      const anchor = `${indent}shouldNotify,\n${indent}notification,`;
      if (patched.split(anchor).length !== 2) throw new Error("通知决策插入位置不唯一");
      patched = patched.replace(anchor, `${indent}shouldNotify,\n${serverInsertion(indent)}${indent}notification,`);
    }
  } else if (kind === "session") {
    if (patched.split(sessionAnchor).length !== 2) throw new Error("通知能力插入位置不匹配");
    patched = patched.replace(sessionAnchor, sessionAnchor + capability);
  } else {
    if (patched.split(responseAnchor).length !== 2) throw new Error("通知能力协议位置不匹配");
    patched = patched.replace(responseAnchor, responseAnchor + capabilitySchema);
    // modern attention + legacy agent_stream attention；terminal 的字段形状不同，不会命中。
    const anchor = "        shouldNotify: z.boolean(),\n        notification: z";
    if (patched.split(anchor).length !== 3) throw new Error("通知协议插入位置不匹配");
    patched = patched.replaceAll(anchor, `        shouldNotify: z.boolean(),\n${protocolInsertion}        notification: z`);
  }
  if (source !== original && source !== patched) throw new Error("已有通知补丁不完整，停止修改");
  return patched;
}

async function main(args: string[]) {
  const apply = args.includes("--apply");
  const files: { kind: keyof typeof hashes; path: string }[] = [];
  const runtimeAt = args.indexOf("--runtime");
  if (runtimeAt >= 0) {
    const runtime = args[runtimeAt + 1];
    if (!runtime || runtime.startsWith("--")) throw new Error("--runtime 需要运行时根目录");
    files.push({ kind: "session", path: resolve(runtime, "node_modules/@getpaseo/server/dist/server/server/session.js") },
      { kind: "server", path: resolve(runtime, "node_modules/@getpaseo/server/dist/server/server/websocket-server.js") },
      { kind: "protocol", path: resolve(runtime, "node_modules/@getpaseo/protocol/dist/messages.js") });
  }
  if (!files.length) throw new Error("用法：prepare.ts --runtime <runtime目录>；加 --apply 才写入");
  // 全部核验通过后才开始写；旧版本或其他改动绝不被覆盖。
  const changes = await Promise.all(files.map(async file => {
    const before = await readFile(file.path, "utf8");
    return { ...file, before, after: patchSource(file.kind, before) };
  }));
  for (const file of changes) {
    if (file.before === file.after) { console.log(`已应用：${file.kind}`); continue; }
    if (!apply) { console.log(`核验通过，待应用：${file.kind}`); continue; }
    const backup = `${file.path}.before-notification-${digest(file.before).slice(0, 12)}`;
    await copyFile(file.path, backup, constants.COPYFILE_EXCL).catch(async error => {
      if (error.code !== "EEXIST" || await readFile(backup, "utf8") !== file.before) throw error;
    });
    const tmp = `${file.path}.notification-${process.pid}.tmp`;
    await writeFile(tmp, file.after);
    await rename(tmp, file.path);
    console.log(`已应用并保留原文件备份：${file.kind}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
