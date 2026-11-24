# Resource retention

Retention applies per workspace. Desktop mounts at most three workspace views and releases hidden
views after five minutes. Native keeps one. Layout, drafts, attachments and scroll anchors keep
their existing persistent owners. [Timeline sync](timeline-sync.md#resume-behavior) owns conversation
release and catch-up; [agent lifecycle](agent-lifecycle.md) owns runtime safety. Browser guest
expiration and its test harness are described in [browser capture](browser-capture-harness.md).

## Local samples

Every thirty seconds the daemon writes `$PASEO_HOME/logs/resource-retention.ndjson`. It records
estimated process RSS by agent and for the daemon, shared runtimes and unassigned descendants. A
shared process enters the total once. On macOS the browser guard also supplies verified ownership
for detached browsers. Each entry includes the highest daemon-side sample since startup, its time
and the largest tool processes on that sample. The diagnostics sheet reads the latest cached sample.

The desktop records interface memory and its sampled peak separately in `resource-retention.ndjson`
under Electron's user-data directory. Its sample includes mounted workspaces and browser guests.
Closing the window ends its sampling. Each journal has two segments of at most five MiB each.
`.1` is the previous segment. Slow samples are skipped rather than queued.

## Codex sessions

Codex 0.171.0 and later must affirm an idle thread, no background terminals, no active goal and
no other loaded thread before Paseo releases the runtime. Pending work, a reader on any client,
an active workspace terminal or an incomplete response retains it. **Put to sleep** in host diagnostics skips the inactivity
delay and uses the same proof and durable save. It requires workspace write access.

On macOS, a memory warning lets one agent start immediately and starts waiting agents one
at a time while the warning persists. Critical pressure queues launches in order and checks
once a second. The first waiting launch can start as soon as a reading reports warning or normal
pressure. Paseo checks pressure before each launch. An unavailable reading keeps a confirmed
critical state in effect until a new reading clears it.

Warning and critical pressure trigger the same safe inactivity check without the 15-minute delay.
A connected creation client resubmits waiting creation receipts after a daemon restart.

Paseo gives Codex a dedicated, named agent-browser session. Browse on demand and use the integrated
browser for an existing Paseo page. On turn completion, Paseo closes the dedicated session only
when Codex confirms it has no remaining work. The macOS guard retains ownership evidence for
orphaned browser processes.

Use the REA CLI on demand. Set `PASEO_CODEX_CHROME_DEVTOOLS=1` or `PASEO_CODEX_REA_MCP=1` in a
Codex provider profile to use the corresponding configured MCP server on launch. Paseo applies
its defaults at launch and when opening a thread, so the global Codex configuration and running sessions are preserved.

Samples contain
process RSS for the daemon and descendants, Node memory, resident runtime counts, cumulative releases
and counts by retention reason. `provider-unverified` means no provider proof is available, including
a refused or timed-out check. A retained runtime is expected in that case.

The desktop preload reports mounted workspace views and browser guest counts. The main process writes
`resource-retention.ndjson` under Electron's user-data directory with those counts, guest release totals,
retention reasons and Electron process memory. Closing the window ends its sampling. Each journal has
two segments of at most five MiB each; `.1` is the previous segment. Slow samples are skipped rather
than queued. Sampling errors leave the retention safety rules intact.

Samples contain no conversation content, command arguments or heap dumps. RSS can remain above its
initial value after resource release because allocators and Chromium keep shared caches. Compare
resident counts over repeated cycles as well as memory; a one-off RSS reading does not explain an OOM.
