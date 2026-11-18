import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
const execute = promisify(execFile);
export const nativeProcessSchema = z.object({
  pid: z.number().int().min(2),
  parent: z.number().int().nonnegative(),
  startedAt: z.string().regex(/^\d+:\d+$/),
  generation: z.string().default(""),
  shared: z.string().optional(),
  uid: z.number().int().nonnegative(),
  executable: z.string(),
});
export type NativeProcess = z.infer<typeof nativeProcessSchema>;
export function nativeProcessHelper(): string {
  for (const candidate of [
    "./paseo-browser-resource",
    "../../server/server/paseo-browser-resource",
    "../../dist/server/server/paseo-browser-resource",
  ]) {
    const file = fileURLToPath(new URL(candidate, import.meta.url)).replace(
      /\.asar\//,
      ".asar.unpacked/",
    );
    if (existsSync(file)) return file;
  }
  throw new Error("Bundled native process helper unavailable");
}
export async function nativeProcessSnapshot(): Promise<NativeProcess[]> {
  const { stdout } = await execute(nativeProcessHelper(), ["snapshot"], {
    timeout: 2000,
    maxBuffer: 16 * 1024 ** 2,
  });
  return z.array(nativeProcessSchema).parse(JSON.parse(stdout));
}
export async function signalNativeProcess(
  process: Pick<NativeProcess, "pid" | "startedAt">,
  signal: "SIGKILL" | "SIGTERM",
): Promise<void> {
  await execute(nativeProcessHelper(), ["signal", String(process.pid), process.startedAt, signal], {
    timeout: 2000,
  });
}
