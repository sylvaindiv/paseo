# Resource retention

Retention applies per workspace. Desktop mounts at most three workspace views and releases hidden
views after five minutes. Native keeps one. Layout, drafts, attachments and scroll anchors keep
their existing persistent owners. [Timeline sync](timeline-sync.md#resume-behavior) owns conversation
release and catch-up; [agent lifecycle](agent-lifecycle.md) owns runtime safety. Browser guest
expiration and its test harness are described in [browser capture](browser-capture-harness.md).

## Local samples

Every thirty seconds the daemon writes `$PASEO_HOME/logs/resource-retention.ndjson`. Samples contain
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
