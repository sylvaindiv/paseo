import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/paseo-local-auto-build.mjs");
const tempDirs = [];

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "paseo-local-auto-build-"));
  tempDirs.push(root);
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const state = join(root, "state");
  const checkout = join(state, "checkout");
  const bin = join(root, "bin");
  const npmLog = join(root, "npm.log");
  const failBuild = join(root, "fail-build");

  mkdirSync(source);
  git(source, "init", "-b", "paseo-local");
  git(source, "config", "user.email", "test@example.com");
  git(source, "config", "user.name", "Test");
  writeFileSync(join(source, "version"), "one\n");
  git(source, "add", "version");
  git(source, "commit", "-m", "one");
  execFileSync("git", ["clone", "--bare", source, remote]);
  git(source, "remote", "add", "origin", remote);
  mkdirSync(state);
  execFileSync("git", ["clone", "--branch", "paseo-local", "--single-branch", remote, checkout]);

  mkdirSync(bin);
  const fakeNpm = join(bin, "npm");
  writeFileSync(
    fakeNpm,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PASEO_TEST_NPM_LOG"\nprintf "npm:%s\\n" "$*"\nif [ "$*" = "run build" ] && [ -e "$PASEO_TEST_FAIL_BUILD" ]; then exit 42; fi\n',
  );
  chmodSync(fakeNpm, 0o755);

  return {
    root,
    source,
    remote,
    state,
    checkout,
    npmLog,
    failBuild,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PASEO_LOCAL_BUILDER_HOME: state,
      PASEO_TEST_NPM_LOG: npmLog,
      PASEO_TEST_FAIL_BUILD: failBuild,
    },
  };
}

function run(fixture, command = "run") {
  const args = Array.isArray(command) ? command : [command];
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: fixture.env,
  });
}

function configureLifecycle(fixture, { publishScript = true } = {}) {
  const launchAgents = join(fixture.root, "LaunchAgents");
  const launchctlLog = join(fixture.root, "launchctl.log");
  const failBootout = join(fixture.root, "fail-bootout");
  const log = join(fixture.root, "builder.log");
  if (publishScript) {
    mkdirSync(join(fixture.source, "scripts"));
    copyFileSync(script, join(fixture.source, "scripts/paseo-local-auto-build.mjs"));
    git(fixture.source, "add", "scripts/paseo-local-auto-build.mjs");
    git(fixture.source, "commit", "-m", "add auto builder");
    git(fixture.source, "push", "origin", "paseo-local");
  }
  mkdirSync(launchAgents);
  const fakeLaunchctl = join(fixture.root, "bin", "launchctl");
  writeFileSync(
    fakeLaunchctl,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PASEO_TEST_LAUNCHCTL_LOG"\nif [ "$1" = "bootout" ] && [ -e "$PASEO_TEST_FAIL_BOOTOUT" ]; then echo "bootout failed" >&2; exit 5; fi\nif [ "$1" = "bootstrap" ] && [ -n "$PASEO_LOCAL_BUILDER_PROBE_PATH" ]; then "$PASEO_TEST_NODE" "$PASEO_TEST_SCRIPT" probe "$PASEO_LOCAL_BUILDER_PROBE_PATH"; fi\n',
  );
  chmodSync(fakeLaunchctl, 0o755);
  fixture.env = {
    ...fixture.env,
    PASEO_LOCAL_BUILDER_SOURCE: fixture.source,
    PASEO_LOCAL_BUILDER_LAUNCH_AGENTS_DIR: launchAgents,
    PASEO_LOCAL_BUILDER_LAUNCHCTL: fakeLaunchctl,
    PASEO_LOCAL_BUILDER_LOG: log,
    PASEO_TEST_LAUNCHCTL_LOG: launchctlLog,
    PASEO_TEST_FAIL_BOOTOUT: failBootout,
  };
  return { failBootout, launchAgents, launchctlLog, log };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === "darwin")("Paseo Local automatic build", () => {
  it("builds and records a remote commit that has not succeeded yet", () => {
    const fixture = createFixture();
    const commit = git(fixture.checkout, "rev-parse", "HEAD");

    const result = run(fixture);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npm:run build");
    expect(readFileSync(fixture.npmLog, "utf8")).toBe("ci\nrun build\n");
    expect(readFileSync(join(fixture.state, "last-successful-commit"), "utf8")).toBe(`${commit}\n`);
  });

  it("does not rebuild a commit that already succeeded", () => {
    const fixture = createFixture();
    expect(run(fixture).status).toBe(0);
    writeFileSync(fixture.npmLog, "");

    const result = run(fixture);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(fixture.npmLog, "utf8")).toBe("");
  });

  it("keeps the previous marker after failure and retries the new commit", () => {
    const fixture = createFixture();
    expect(run(fixture).status).toBe(0);
    const firstCommit = git(fixture.source, "rev-parse", "HEAD");

    writeFileSync(join(fixture.source, "version"), "two\n");
    git(fixture.source, "add", "version");
    git(fixture.source, "commit", "-m", "two");
    git(fixture.source, "push", "origin", "paseo-local");
    const secondCommit = git(fixture.source, "rev-parse", "HEAD");
    writeFileSync(fixture.failBuild, "fail\n");

    const failed = run(fixture);

    expect(failed.status).toBe(1);
    expect(readFileSync(join(fixture.state, "last-successful-commit"), "utf8")).toBe(
      `${firstCommit}\n`,
    );

    rmSync(fixture.failBuild);
    const retried = run(fixture);

    expect(retried.stderr).toBe("");
    expect(retried.status).toBe(0);
    expect(readFileSync(join(fixture.state, "last-successful-commit"), "utf8")).toBe(
      `${secondCommit}\n`,
    );
    expect(readFileSync(fixture.npmLog, "utf8")).toBe(
      "ci\nrun build\nci\nrun build\nci\nrun build\n",
    );
  });

  it("refuses a remote commit that cannot fast-forward the checkout", () => {
    const fixture = createFixture();
    expect(run(fixture).status).toBe(0);
    const firstCommit = git(fixture.source, "rev-parse", "HEAD");

    writeFileSync(join(fixture.source, "version"), "two\n");
    git(fixture.source, "add", "version");
    git(fixture.source, "commit", "-m", "two");
    git(fixture.source, "push", "origin", "paseo-local");
    expect(run(fixture).status).toBe(0);
    const successfulCommit = git(fixture.checkout, "rev-parse", "HEAD");

    git(fixture.source, "reset", "--hard", firstCommit);
    writeFileSync(join(fixture.source, "version"), "three\n");
    git(fixture.source, "add", "version");
    git(fixture.source, "commit", "-m", "three");
    git(fixture.source, "push", "--force", "origin", "paseo-local");
    writeFileSync(fixture.npmLog, "");

    const result = run(fixture);

    expect(result.status).toBe(1);
    expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(successfulCommit);
    expect(readFileSync(join(fixture.state, "last-successful-commit"), "utf8")).toBe(
      `${successfulCommit}\n`,
    );
    expect(readFileSync(fixture.npmLog, "utf8")).toBe("");
  });

  it("refuses to build a checkout commit that is ahead of origin/paseo-local", () => {
    const fixture = createFixture();
    expect(run(fixture).status).toBe(0);
    const successfulCommit = git(fixture.checkout, "rev-parse", "HEAD");
    git(fixture.checkout, "config", "user.email", "test@example.com");
    git(fixture.checkout, "config", "user.name", "Test");
    writeFileSync(join(fixture.checkout, "version"), "local\n");
    git(fixture.checkout, "add", "version");
    git(fixture.checkout, "commit", "-m", "local-only");
    writeFileSync(fixture.npmLog, "");

    const result = run(fixture);

    expect(result.status).toBe(1);
    expect(readFileSync(join(fixture.state, "last-successful-commit"), "utf8")).toBe(
      `${successfulCommit}\n`,
    );
    expect(readFileSync(fixture.npmLog, "utf8")).toBe("");
  });

  it("skips a run while another process holds the build lock", async () => {
    const fixture = createFixture();
    const lock = join(fixture.state, "build.lock");
    const holder = spawn("/usr/bin/lockf", ["-k", lock, "/bin/sleep", "5"], {
      detached: true,
      stdio: "ignore",
    });

    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const probe = spawnSync("/usr/bin/lockf", ["-k", "-t", "0", lock, "/usr/bin/true"], {
          stdio: "ignore",
        });
        if (probe.status === 75) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }

      const result = run(fixture);

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Another builder operation is already running");
      expect(existsSync(fixture.npmLog)).toBe(false);
    } finally {
      process.kill(-holder.pid, "SIGTERM");
      await new Promise((resolveClose) => holder.once("close", resolveClose));
    }
  });

  it("refuses installation while a build holds the checkout lock", async () => {
    const fixture = createFixture();
    const { launchAgents, launchctlLog } = configureLifecycle(fixture);
    const lock = join(fixture.state, "build.lock");
    const checkoutCommit = git(fixture.checkout, "rev-parse", "HEAD");
    const holder = spawn("/usr/bin/lockf", ["-k", lock, "/bin/sleep", "5"], {
      detached: true,
      stdio: "ignore",
    });

    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const probe = spawnSync("/usr/bin/lockf", ["-k", "-t", "0", lock, "/usr/bin/true"], {
          stdio: "ignore",
        });
        if (probe.status === 75) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }

      const result = run(fixture, "install");

      expect(result.status).toBe(1);
      expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(checkoutCommit);
      expect(existsSync(join(launchAgents, "sh.paseo.local-auto-build.plist"))).toBe(false);
      expect(existsSync(launchctlLog)).toBe(false);
    } finally {
      process.kill(-holder.pid, "SIGTERM");
      await new Promise((resolveClose) => holder.once("close", resolveClose));
    }
  });

  it("installs and uninstalls the LaunchAgent idempotently", () => {
    const fixture = createFixture();
    const { launchAgents, launchctlLog, log } = configureLifecycle(fixture);
    rmSync(fixture.checkout, { recursive: true });

    const firstInstall = run(fixture, "install");
    const secondInstall = run(fixture, "install");

    expect(firstInstall.stderr).toBe("");
    expect(firstInstall.status).toBe(0);
    expect(secondInstall.stderr).toBe("");
    expect(secondInstall.status).toBe(0);
    expect(git(fixture.checkout, "branch", "--show-current")).toBe("paseo-local");
    expect(git(fixture.checkout, "branch", "-r")).toBe("origin/paseo-local");

    const plistPath = join(launchAgents, "sh.paseo.local-auto-build.plist");
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("<string>sh.paseo.local-auto-build</string>");
    expect(plist).toContain(`<string>${process.execPath}</string>`);
    expect(plist).toContain(
      `<string>${join(fixture.checkout, "scripts/paseo-local-auto-build.mjs")}</string>`,
    );
    expect(plist).toContain("<key>StartInterval</key>\n  <integer>300</integer>");
    expect(plist).toContain(`<string>${log}</string>`);
    expect(plist).toContain(`<string>${fixture.env.PATH}</string>`);
    expect(plist).toContain("<key>PASEO_LOCAL_BUILDER_HOME</key>");
    expect(plist).toContain(`<string>${fixture.state}</string>`);
    expect(execFileSync("/usr/bin/plutil", ["-lint", plistPath], { encoding: "utf8" })).toContain(
      "OK",
    );
    expect(readFileSync(launchctlLog, "utf8")).toContain("bootstrap");

    writeFileSync(log, "diagnostic\n");
    const firstUninstall = run(fixture, "uninstall");
    const secondUninstall = run(fixture, "uninstall");

    expect(firstUninstall.stderr).toBe("");
    expect(firstUninstall.status).toBe(0);
    expect(secondUninstall.stderr).toBe("");
    expect(secondUninstall.status).toBe(0);
    expect(existsSync(join(launchAgents, "sh.paseo.local-auto-build.plist"))).toBe(false);
    expect(existsSync(fixture.checkout)).toBe(true);
    expect(readFileSync(log, "utf8")).toBe("diagnostic\n");
  });

  it("writes a harmless verification probe", () => {
    const fixture = createFixture();
    const probe = join(fixture.root, "probe", "completed");

    const result = run(fixture, ["probe", probe]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(probe, "utf8")).toBe("ok\n");
  });

  it("does not remove the plist when launchd refuses to unload the job", () => {
    const fixture = createFixture();
    const { failBootout, launchAgents } = configureLifecycle(fixture);
    expect(run(fixture, "install").status).toBe(0);
    const plist = join(launchAgents, "sh.paseo.local-auto-build.plist");
    writeFileSync(failBootout, "fail\n");

    const result = run(fixture, "uninstall");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bootout failed");
    expect(existsSync(plist)).toBe(true);
  });

  it("refuses installation when origin/paseo-local does not contain the runtime script", () => {
    const fixture = createFixture();
    const { launchAgents } = configureLifecycle(fixture, { publishScript: false });
    rmSync(fixture.checkout, { recursive: true });

    const result = run(fixture, "install");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("origin/paseo-local does not contain");
    expect(existsSync(join(launchAgents, "sh.paseo.local-auto-build.plist"))).toBe(false);
    expect(existsSync(fixture.checkout)).toBe(false);
  });

  it("loads, observes, and cleans up a verification LaunchAgent", () => {
    const fixture = createFixture();
    const { launchctlLog } = configureLifecycle(fixture);
    const verifyDirectory = join(fixture.root, "verify-launchd");
    mkdirSync(verifyDirectory);
    writeFileSync(join(verifyDirectory, "keep"), "user data\n");
    fixture.env = {
      ...fixture.env,
      PASEO_LOCAL_BUILDER_VERIFY_DIR: verifyDirectory,
      PASEO_TEST_NODE: process.execPath,
      PASEO_TEST_SCRIPT: script,
    };

    const result = run(fixture, "verify-launchd");

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LaunchAgent verification succeeded");
    expect(readFileSync(join(verifyDirectory, "keep"), "utf8")).toBe("user data\n");
    expect(readdirSync(verifyDirectory)).toEqual(["keep"]);
    const calls = readFileSync(launchctlLog, "utf8");
    expect(calls).toContain("bootstrap");
    expect(calls).toContain("bootout");
    expect(calls).toContain("print");
  });
});
