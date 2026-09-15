#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(join(import.meta.dirname, ".."));
const label = "sh.paseo.local-auto-build";

function paths(env) {
  const state = resolve(
    env.PASEO_LOCAL_BUILDER_HOME ??
      join(homedir(), "Library/Application Support/Paseo Local Builder"),
  );
  const launchAgents = resolve(
    env.PASEO_LOCAL_BUILDER_LAUNCH_AGENTS_DIR ?? join(homedir(), "Library/LaunchAgents"),
  );
  return {
    state,
    checkout: join(state, "checkout"),
    lock: join(state, "build.lock"),
    marker: join(state, "last-successful-commit"),
    restartMarker: join(state, "last-successful-daemon-restart-commit"),
    paseoHome: resolve(env.PASEO_LOCAL_BUILDER_PASEO_HOME ?? join(homedir(), ".paseo")),
    launchAgents,
    plist: join(launchAgents, `${label}.plist`),
    log: resolve(
      env.PASEO_LOCAL_BUILDER_LOG ?? join(homedir(), "Library/Logs/Paseo Local Builder.log"),
    ),
  };
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env,
    cwd: options.cwd,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function executeStreaming(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
}

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function writeMarker(marker, commit) {
  const temporaryMarker = `${marker}.${process.pid}.tmp`;
  writeFileSync(temporaryMarker, `${commit}\n`);
  renameSync(temporaryMarker, marker);
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchctl(env, args, allowMissing = false) {
  const command = env.PASEO_LOCAL_BUILDER_LAUNCHCTL ?? "/bin/launchctl";
  const result = spawnSync(command, args, { encoding: "utf8", env });
  const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
  if (
    result.status !== 0 &&
    !(allowMissing && result.status === 3 && /No such process/i.test(detail))
  ) {
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

function launchDomain() {
  return `gui/${process.getuid()}`;
}

function syncCheckout(checkout, env) {
  if (!existsSync(join(checkout, ".git"))) {
    throw new Error(`Dedicated checkout is missing: ${checkout}. Run the install command first.`);
  }
  if (execute("git", ["branch", "--show-current"], { cwd: checkout, env }) !== "paseo-local") {
    throw new Error("Dedicated checkout is not on paseo-local");
  }
  if (execute("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: checkout, env })) {
    throw new Error("Dedicated checkout has tracked changes");
  }

  execute("git", ["fetch", "origin", "refs/heads/paseo-local:refs/remotes/origin/paseo-local"], {
    cwd: checkout,
    env,
  });
  const remoteCommit = execute("git", ["rev-parse", "origin/paseo-local"], {
    cwd: checkout,
    env,
  });
  execute("git", ["merge", "--ff-only", "origin/paseo-local"], { cwd: checkout, env });
  const commit = execute("git", ["rev-parse", "HEAD"], { cwd: checkout, env });
  if (commit !== remoteCommit) {
    throw new Error("Dedicated checkout does not exactly match origin/paseo-local");
  }
  return commit;
}

function plistContents({ checkout, log: logPath, state }, env) {
  const values = [process.execPath, join(checkout, "scripts/paseo-local-auto-build.mjs"), "run"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${values.map((value) => `    <string>${xml(value)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(checkout)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(env.PATH ?? "")}</string>
    <key>PASEO_LOCAL_BUILDER_HOME</key>
    <string>${xml(state)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function installLocked(env) {
  const builderPaths = paths(env);
  mkdirSync(builderPaths.state, { recursive: true });
  mkdirSync(builderPaths.launchAgents, { recursive: true });
  mkdirSync(resolve(join(builderPaths.log, "..")), { recursive: true });

  const source = resolve(env.PASEO_LOCAL_BUILDER_SOURCE ?? repositoryRoot);
  const repositoryUrl = execute("git", ["remote", "get-url", "origin"], { cwd: source, env });
  let createdCheckout = false;
  if (!existsSync(join(builderPaths.checkout, ".git"))) {
    execute(
      "git",
      ["clone", "--branch", "paseo-local", "--single-branch", repositoryUrl, builderPaths.checkout],
      { env },
    );
    createdCheckout = true;
  } else {
    const branch = execute("git", ["branch", "--show-current"], {
      cwd: builderPaths.checkout,
      env,
    });
    const existingUrl = execute("git", ["remote", "get-url", "origin"], {
      cwd: builderPaths.checkout,
      env,
    });
    if (branch !== "paseo-local" || existingUrl !== repositoryUrl) {
      throw new Error("Existing dedicated checkout does not match origin/paseo-local");
    }
  }

  syncCheckout(builderPaths.checkout, env);

  if (!existsSync(join(builderPaths.checkout, "scripts/paseo-local-auto-build.mjs"))) {
    if (createdCheckout) rmSync(builderPaths.checkout, { recursive: true, force: true });
    throw new Error("origin/paseo-local does not contain scripts/paseo-local-auto-build.mjs");
  }

  const domain = launchDomain();
  launchctl(env, ["bootout", `${domain}/${label}`], true);
  const temporaryPlist = `${builderPaths.plist}.${process.pid}.tmp`;
  writeFileSync(temporaryPlist, plistContents(builderPaths, env));
  renameSync(temporaryPlist, builderPaths.plist);
  launchctl(env, ["bootstrap", domain, builderPaths.plist]);
  log(`Installed ${builderPaths.plist}`);
  return 0;
}

function uninstall(env) {
  const builderPaths = paths(env);
  launchctl(env, ["bootout", `${launchDomain()}/${label}`], true);
  rmSync(builderPaths.plist, { force: true });
  log(`Uninstalled ${builderPaths.plist}`);
  return 0;
}

function verifyLaunchd(env) {
  const verifyRoot = resolve(env.PASEO_LOCAL_BUILDER_VERIFY_DIR ?? tmpdir());
  mkdirSync(verifyRoot, { recursive: true });
  const verifyDirectory = mkdtempSync(join(verifyRoot, "paseo-local-launchd-verification-"));
  const verifyLabel = `${label}.verify.${process.pid}`;
  const completed = join(verifyDirectory, "completed");
  const plist = join(verifyDirectory, `${verifyLabel}.plist`);
  const output = join(verifyDirectory, "launchd.log");
  const domain = launchDomain();
  const verifyEnv = { ...env, PASEO_LOCAL_BUILDER_PROBE_PATH: completed };

  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${verifyLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(scriptPath)}</string>
    <string>probe</string>
    <string>${xml(completed)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(output)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(output)}</string>
</dict>
</plist>
`,
  );

  try {
    launchctl(verifyEnv, ["bootout", `${domain}/${verifyLabel}`], true);
    launchctl(verifyEnv, ["bootstrap", domain, plist]);
    for (let attempt = 0; attempt < 100 && !existsSync(completed); attempt += 1) {
      spawnSync("/bin/sleep", ["0.05"]);
    }
    if (!existsSync(completed) || readFileSync(completed, "utf8") !== "ok\n") {
      const diagnostic = existsSync(output) ? readFileSync(output, "utf8").trim() : "no output";
      throw new Error(`LaunchAgent verification timed out: ${diagnostic}`);
    }
    launchctl(verifyEnv, ["print", `${domain}/${verifyLabel}`]);
    log("LaunchAgent verification succeeded");
    return 0;
  } finally {
    launchctl(verifyEnv, ["bootout", `${domain}/${verifyLabel}`], true);
    rmSync(verifyDirectory, { recursive: true, force: true });
  }
}

function runLocked(env) {
  const { checkout, marker, paseoHome, restartMarker } = paths(env);
  const commit = syncCheckout(checkout, env);
  const successfulCommit = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
  if (successfulCommit !== commit) {
    log(`Building ${commit}`);
    executeStreaming("npm", ["ci"], { cwd: checkout, env });
    executeStreaming("npm", ["run", "build"], { cwd: checkout, env });
    writeMarker(marker, commit);
    log(`Built ${commit}`);
  } else {
    log(`Already built ${commit}`);
  }

  const restartedCommit = existsSync(restartMarker)
    ? readFileSync(restartMarker, "utf8").trim()
    : "";
  if (restartedCommit === commit) return 0;

  const cliArgs = ["run", "--silent", "cli", "--"];
  const daemon = JSON.parse(
    execute("npm", [...cliArgs, "daemon", "status", "--home", paseoHome, "--json"], {
      cwd: checkout,
      env,
    }),
  );
  if (daemon.localDaemon === "running" && daemon.desktopManaged === true) {
    const restart = JSON.parse(
      execute("npm", [...cliArgs, "daemon", "restart", "--home", paseoHome, "--json"], {
        cwd: checkout,
        env,
      }),
    );
    if (restart.action !== "restarted" || restart.acknowledged !== true) {
      throw new Error("Paseo Local daemon restart was not acknowledged");
    }
    log("Restarted Paseo Local daemon");
  }
  writeMarker(restartMarker, commit);
  return 0;
}

function withLock(command, env, busyExitCode) {
  const { state, lock } = paths(env);
  mkdirSync(state, { recursive: true });
  const result = spawnSync(
    "/usr/bin/lockf",
    ["-k", "-s", "-t", "0", lock, process.execPath, scriptPath, command],
    { env, stdio: "inherit" },
  );
  if (result.status === 75) {
    log("Another builder operation is already running");
    return busyExitCode;
  }
  return result.status ?? 1;
}

function run(env) {
  return withLock("run-locked", env, 0);
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const [command, argument] = argv;
  if (command === "run") return run(env);
  if (command === "run-locked") return runLocked(env);
  if (command === "install") return withLock("install-locked", env, 1);
  if (command === "install-locked") return installLocked(env);
  if (command === "uninstall") return uninstall(env);
  if (command === "verify-launchd") return verifyLaunchd(env);
  if (command === "probe" && argument) {
    mkdirSync(dirname(argument), { recursive: true });
    writeFileSync(argument, "ok\n");
    return 0;
  }
  throw new Error(`Unknown command: ${command ?? ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
