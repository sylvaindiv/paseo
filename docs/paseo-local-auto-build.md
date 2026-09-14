# Paseo Local automatic builds

Use the macOS LaunchAgent to rebuild `Paseo Local.app` after `origin/paseo-local` advances. It owns a stable checkout under `~/Library/Application Support/Paseo Local Builder/checkout` and updates that checkout with `git merge --ff-only`. It never checks out or fetches another branch.

Each run fetches the exact `paseo-local` ref, acquires a process lock, fast-forwards the clean checkout, and compares the remote commit with `last-successful-commit`. A changed commit runs `npm ci` followed by `npm run build`. The success marker is replaced atomically only after the build installs the app, so a failed build is retried at the next interval.

The job does not open, close, or restart Paseo Local. Reopen the app yourself when you are ready to use a new build; the running app and daemon on port 6767 are left untouched.

## Commands

```bash
npm run paseo-local:auto-build:install
npm run paseo-local:auto-build:uninstall
npm run paseo-local:auto-build:verify-launchd
```

Installation is idempotent and loads `~/Library/LaunchAgents/sh.paseo.local-auto-build.plist`. Uninstallation unloads the job and removes the plist. It keeps the checkout, success marker, and log for a fast reinstall and diagnosis.

Install after this automation has reached `origin/paseo-local`. The installer refuses to load a job when the remote checkout does not contain its runtime script.

The LaunchAgent runs at login and every five minutes. Read the log with:

```bash
tail -f "$HOME/Library/Logs/Paseo Local Builder.log"
```

`verify-launchd` loads a temporary LaunchAgent that writes a probe file, then unloads and removes it. The probe uses the real `launchctl` path without building the app or connecting to the daemon.
