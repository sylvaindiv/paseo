import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeModule = "packages/server/dist/server/server/agent/providers/opencode/bridge.js";

// Mirrors nix/package.nix's installPhase: copy every traced path into $out.
async function installTracedDaemon(outRoot) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.join(repoRoot, "scripts/trace-daemon.mjs")],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
  );
  for (const file of stdout.split("\n").filter(Boolean)) {
    await cp(path.join(repoRoot, file), path.join(outRoot, file), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
}

test("traced daemon closure ships the OpenCode bridge plugin for every OpenCode version", async () => {
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "trace-daemon-dist-"));
  try {
    await installTracedDaemon(outRoot);
    const installedBridgeUrl = pathToFileURL(path.join(outRoot, bridgeModule)).href;
    const { loadOpenCodeBridgePluginArtifact } = await import(installedBridgeUrl);

    for (const version of [1, 2]) {
      const artifact = await loadOpenCodeBridgePluginArtifact(
        installedBridgeUrl,
        undefined,
        version,
      );
      assert.ok(artifact.byteLength > 0, `OpenCode v${version} bridge plugin is empty`);
    }
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});

test(
  "traced macOS daemon can launch its detached browser guard entrypoint",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "trace-browser-guard-dist-"));
    try {
      await installTracedDaemon(outRoot);
      const worker = path.join(outRoot, "guard-probe.mjs");
      await writeFile(
        worker,
        `export async function runBrowserResourceWorker(directory, binary) { console.log(JSON.stringify([directory, binary])); }`,
      );
      const entry = path.join(
        outRoot,
        "packages/server/dist/server/server/browser-resource-entry.cjs",
      );
      const { stdout } = await promisify(execFile)(process.execPath, [
        entry,
        worker,
        "state",
        "helper",
      ]);
      assert.deepEqual(JSON.parse(stdout), ["state", "helper"]);
    } finally {
      await rm(outRoot, { recursive: true, force: true });
    }
  },
);
