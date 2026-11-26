import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { CoachTaskProposal } from "../shared/coach.js";
import { sequenceAction, type SequenceRequest } from "../shared/sequence.js";

export function registerSequence(server: PluginServerContext) {
  const source = process.env.PASEO_THINGS_SOURCE ?? join(homedir(), "Applis/Perso/Things");
  const lifetime = new AbortController();
  let directory: string | undefined;
  let executable: Promise<string> | undefined;

  async function build() {
    const model = join(source, "Sources/Model");
    const files = (await readdir(model)).filter((name) => name.endsWith(".swift")).sort();
    directory ??= await mkdtemp(join(tmpdir(), "paseo-sequence-"));
    const binary = join(directory, "sequence");
    const args = [
      "swiftc",
      "-swift-version",
      "5",
      ...files.map((name) => join(model, name)),
      join(source, "Tools/PaseoSequence.swift"),
      "-o",
      binary,
    ];
    await run("/usr/bin/xcrun", args, undefined, 90_000);
    return binary;
  }

  function run(file: string, args: string[], input: string | undefined, timeout: number) {
    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        file,
        args,
        { signal: lifetime.signal, timeout, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout);
        },
      );
      // The process callback reports spawn and exit failures, including a closed pipe.
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  }

  async function send(
    input: SequenceRequest | { action: "coachTask"; id: string; proposal: CoachTaskProposal },
  ) {
    if (process.platform !== "darwin") return { error: "Things Local est disponible sur Mac." };
    try {
      executable ??= build().catch((error) => {
        executable = undefined;
        throw error;
      });
      const binary = await executable;
      const result = await run(binary, [], JSON.stringify(input), 20_000);
      return sequenceAction.output.parse(JSON.parse(result));
    } catch {
      return { error: "Bibliothèque Things Local inaccessible." };
    }
  }

  let reading: ReturnType<typeof send> | undefined;
  server.handle(sequenceAction, (input) => {
    if (input.action !== "read") return send(input);
    if (reading) return reading;
    const next = send(input).finally(() => {
      reading = undefined;
    });
    reading = next;
    return next;
  });
  return {
    read: () => send({ action: "read" }),
    applyCoachTask: (id: string, proposal: CoachTaskProposal) =>
      send({ action: "coachTask", id, proposal }),
    stop: async () => {
      lifetime.abort();
      await executable?.catch(() => {});
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
