import { connect } from "node:net";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const recoveryStateSchema = z.object({
  generation: z.string().uuid(),
  operationId: z.string().uuid().optional(),
  lastStop: z
    .object({
      action: z.enum(["stopped", "not_running"]),
      pid: z.number().nullable(),
      forced: z.boolean(),
      usedLifecycleRpc: z.boolean(),
    })
    .optional(),
  coordinator: z
    .object({
      pid: z.number(),
      startedAt: z.string().regex(/^\d+:\d+$/),
      uid: z.number().optional(),
      executable: z.string().optional(),
    })
    .optional(),
  desired: z.boolean(),
  monitoring: z.boolean(),
  attempts: z.number().int().min(0).max(3),
  status: z.enum(["starting", "healthy", "recovering", "failed", "stopped", "disabled"]),
  error: z.string().nullable(),
  processes: z.array(
    z.object({
      pid: z.number().int().min(2),
      startedAt: z.string().regex(/^\d+:\d+$/),
      uid: z.number().optional(),
      executable: z.string().optional(),
      generation: z.string().optional(),
      parent: z.number().optional(),
      shared: z.string().optional(),
    }),
  ),
});
export type RecoveryState = z.infer<typeof recoveryStateSchema>;
export function publicRecoveryState(state: RecoveryState): RecoveryState {
  const coordinator = state.coordinator;
  return {
    ...state,
    ...(coordinator && {
      coordinator: { pid: coordinator.pid, uid: coordinator.uid, startedAt: coordinator.startedAt },
    }),
    error: state.error?.slice(0, 1024) ?? null,
    // Older socket clients require this field.
    processes: [],
  };
}

export async function readDaemonRecoveryStatus(home: string): Promise<RecoveryState | null> {
  const state = await readDaemonRecovery(home);
  return state && publicRecoveryState(state);
}

export type RecoveryCommand =
  | "status"
  | "start"
  | "stop_force"
  | "stop"
  | "recover"
  | "restart"
  | "disable";
export const recoverySocket = (home: string) => join(home, "daemon-recovery.sock");
export async function readDaemonRecovery(home: string): Promise<RecoveryState | null> {
  try {
    return recoveryStateSchema.parse(
      JSON.parse(await readFile(join(home, "daemon-recovery.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function writeRecoveryJson(home: string, name: string, value: unknown): Promise<void> {
  const temporary = join(home, `${name}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, join(home, name));
}
export function requestDaemonRecovery(
  home: string,
  command: RecoveryCommand,
): Promise<RecoveryState> {
  return new Promise((resolve, reject) => {
    const socket = connect(recoverySocket(home));
    let buffer = "";
    let bytes = 0;
    socket.setEncoding("utf8");
    const timer = setTimeout(
      () =>
        finish(
          Object.assign(new Error("Daemon recovery command timed out"), {
            code: "RECOVERY_COORDINATOR_TIMEOUT",
          }),
        ),
      command === "status" ? 2_000 : 170_000,
    );
    const finish = (error?: Error, state?: RecoveryState) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(state!);
    };
    socket.on("connect", () => socket.write(`${JSON.stringify({ command })}\n`));
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      if (!buffer.includes("\n"))
        finish(
          Object.assign(new Error("Recovery connection closed"), {
            code: "RECOVERY_CONNECTION_CLOSED",
          }),
        );
    });
    socket.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024)
        return finish(
          Object.assign(new Error("Recovery response too large"), {
            code: "RECOVERY_RESPONSE_TOO_LARGE",
          }),
        );
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      try {
        const result = JSON.parse(buffer.split("\n")[0]);
        if (result.error && typeof result.error === "object")
          finish(Object.assign(new Error(result.error.message), { code: result.error.code }));
        else finish(undefined, publicRecoveryState(recoveryStateSchema.parse(result)));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
