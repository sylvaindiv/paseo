import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "playwright/test";
import { savePersistedConfig } from "@getpaseo/server/configuration";
import { readDaemonRecovery, requestDaemonRecovery } from "@getpaseo/server/daemon-control";
import { warmMetro } from "../../app/e2e/support/metro-warmup.mjs";
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const output = path.join(repo, "packages/desktop/capture-harness/out/daemon-recovery");
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), "paseo-recovery-ui-"));
const home = path.join(root, "home");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("PASEO_") && key !== "ELECTRON_RUN_AS_NODE",
  ),
);
async function freePort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
const port = await freePort();
const metroPort = await freePort();
assert.notEqual(port, 6767);
savePersistedConfig(home, {
  daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false } },
  features: {
    dictation: { enabled: false },
    voiceMode: { enabled: false },
    webUi: { enabled: false },
  },
});
const fakeBin = path.join(root, "bin");
await mkdir(fakeBin);
await writeFile(
  path.join(fakeBin, "paseo"),
  "#!/bin/sh\necho unexpected-global-cli >&2\nexit 77\n",
  { mode: 0o755 },
);
const fixture = path.join(root, "main.cjs");
await writeFile(
  fixture,
  `const { app, BrowserWindow } = require("electron"); app.setActivationPolicy("accessory"); app.dock.hide(); BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive; require(${JSON.stringify(path.join(repo, "packages/desktop/dist/main.js"))});`,
);
const metro = spawn(
  process.execPath,
  [
    path.join(repo, "node_modules/expo/bin/cli"),
    "start",
    "--web",
    "--port",
    String(metroPort),
    "--offline",
  ],
  {
    cwd: path.join(repo, "packages/app"),
    env: {
      ...env,
      EXPO_NO_DOTENV: "1",
      CI: "1",
      PASEO_WEB_PLATFORM: "electron",
      EXPO_PUBLIC_LOCAL_DAEMON: `127.0.0.1:${port}`,
    },
    stdio: "ignore",
    detached: true,
  },
);
let desktop;
const helper = path.join(repo, "packages/server/dist/server/server/paseo-browser-resource");
function signal(identity, signalName) {
  execFileSync(helper, ["signal", String(identity.pid), identity.startedAt, signalName]);
}
try {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${metroPort}/status`)).ok;
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await warmMetro(metroPort);
  desktop = await electron.launch({
    args: [fixture, "--no-sandbox"],
    env: {
      ...env,
      HOME: root,
      PATH: `${fakeBin}:${env.PATH}`,
      PASEO_HOME: home,
      EXPO_DEV_URL: `http://127.0.0.1:${metroPort}`,
      PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1",
      PASEO_ELECTRON_USER_DATA_DIR: path.join(root, "user-data"),
    },
  });
  desktop.process().stdout?.on("data", (chunk) => process.stdout.write(chunk));
  desktop.process().stderr?.on("data", (chunk) => process.stderr.write(chunk));
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.route(/:(6767|6768)\b/, (route) => route.abort());
  page.on("pageerror", (error) => console.log("Renderer:", error.message));
  console.log("Recovery UI: renderer connected");
  await page.waitForFunction(() => Boolean(window.paseoDesktop?.invoke), { timeout: 30_000 });
  await page.evaluate(async () => {
    await window.paseoDesktop.invoke("patch_desktop_settings", {
      daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: true },
    });
    await window.paseoDesktop.invoke("start_desktop_daemon");
  });
  await expect
    .poll(async () => (await readDaemonRecovery(home))?.status, { timeout: 90_000 })
    .toBe("healthy");
  console.log("Recovery UI: daemon started, opening settings");
  await page.getByRole("button", { name: "Paramètres", exact: true }).click({ timeout: 60_000 });
  console.log("Recovery UI: settings opened");
  const enable = page.getByRole("button", { name: "Activer le daemon intégré", exact: true });
  if (await enable.isVisible()) await enable.click();
  await page.getByTestId("daemon-recovery-controls").scrollIntoViewIfNeeded();
  const controls = page.getByTestId("daemon-recovery-controls");
  await controls.screenshot({ path: path.join(output, "healthy.png") });
  // Suspend the recorded worker, then recover through the renderer -> IPC -> bundled CLI.
  const state = await readDaemonRecovery(home);
  const lock = JSON.parse(await readFile(path.join(home, "paseo.pid"), "utf8"));
  const native = JSON.parse(execFileSync(helper, ["snapshot"], { encoding: "utf8" }));
  const worker = native.find((p) => p.parent === lock.pid);
  assert.ok(worker);
  process.kill(worker.pid, "SIGSTOP");
  await controls.getByRole("button", { name: "Relancer", exact: true }).click();
  await expect(controls.getByText("Rétablissement en cours", { exact: true })).toBeVisible();
  await controls.screenshot({ path: path.join(output, "recovering.png") });
  await expect(controls.getByText("Connexion rétablie", { exact: true })).toBeVisible({
    timeout: 110_000,
  });
  await controls.screenshot({ path: path.join(output, "restored.png") });
  assert.notEqual((await readDaemonRecovery(home)).generation, state.generation);
  const manifestPath = path.join(home, "daemon-recovery-launch.json");
  const manifest = await readFile(manifestPath, "utf8");
  signal((await readDaemonRecovery(home)).coordinator, "SIGKILL");
  await writeFile(
    manifestPath,
    JSON.stringify({ ...JSON.parse(manifest), fingerprint: "changed-for-isolated-failure-test" }),
  );
  await controls.getByRole("button", { name: "Relancer", exact: true }).click();
  await expect(controls.getByText("Rétablissement impossible", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await controls.screenshot({ path: path.join(output, "failed.png") });
  await writeFile(manifestPath, manifest);
  await desktop.close();
  desktop = null;
  // Manual CLI recovery remains available after the interface and coordinator have exited.
  const { managedDaemonCommand } = await import("@getpaseo/server/daemon-control");
  await managedDaemonCommand(home, "recover");
  assert.equal((await readDaemonRecovery(home)).status, "healthy");
  const closedGeneration = await readDaemonRecovery(home);
  const closedLock = JSON.parse(await readFile(path.join(home, "paseo.pid"), "utf8"));
  const closedProcesses = JSON.parse(execFileSync(helper, ["snapshot"], { encoding: "utf8" }));
  process.kill(closedProcesses.find((p) => p.parent === closedLock.pid).pid, "SIGSTOP");
  await expect
    .poll(
      async () => {
        const current = await readDaemonRecovery(home);
        return current?.status === "healthy" && current.generation !== closedGeneration.generation;
      },
      { timeout: 110_000 },
    )
    .toBe(true);
  await managedDaemonCommand(home, "stop");
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        passed: true,
        rendererToBundledCli: true,
        globalCliIgnored: true,
        coordinatorRecoveryAfterQuit: true,
        screenshots: ["healthy.png", "recovering.png", "restored.png", "failed.png"],
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (desktop) {
    const page = await desktop.firstWindow();
    await page.screenshot({ path: path.join(output, "failure-context.png") }).catch(() => {});
    await writeFile(
      path.join(output, "failure-context.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
  }
  throw error;
} finally {
  if (desktop) await desktop.close().catch(() => {});
  await requestDaemonRecovery(home, "stop").catch(() => {});
  const state = await readDaemonRecovery(home).catch(() => null);
  if (state?.coordinator) {
    try {
      signal(state.coordinator, "SIGTERM");
    } catch {}
  }
  try {
    process.kill(-metro.pid, "SIGTERM");
  } catch {}
  await rm(root, { recursive: true, force: true });
}
console.log(`PASS: isolated recovery UI evidence: ${output}`);
