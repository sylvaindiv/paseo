import { describe, expect, it } from "vitest";
import {
  buildScheduleGroups,
  placeScheduleSections,
  scheduleColumnCount,
  type ScheduleRowView,
} from "@/schedules/schedule-list";
import { resolveSchedulesScreenBodyState } from "./schedules-screen-state";

describe("resolveSchedulesScreenBodyState", () => {
  it("routes failed loading state to the retry UI instead of the spinner", () => {
    expect(
      resolveSchedulesScreenBodyState({
        loadState: { status: "loading" },
        showLoadError: true,
      }),
    ).toEqual({ kind: "load-error" });
  });
});

describe("schedule groups", () => {
  const alpha = { id: "project:alpha", label: "Alpha", root: "/alpha", host: "Mac" } as const;
  const beta = { id: "project:beta", label: "Beta", root: "/beta", host: "Mac" } as const;
  const items = [
    row("Paused", alpha, "mac", "paused", "2026-11-22"),
    row("Later", alpha, "mac", "active", "2026-11-24"),
    row("Soon", alpha, "mac", "active", "2026-11-23"),
    row("Other host", alpha, "linux", "active", "2026-11-22"),
    row("Other project", beta, "mac", "active", "2026-11-22"),
    row("Loose", null, "mac", "expired", null),
  ];
  const options = {
    host: "mac",
    status: "all",
    project: alpha.id,
    sort: "next",
    locale: "en",
    unassignedLabel: "No project",
  } as const;

  it("combines project, host and status filters and leaves paused rows after real upcoming runs", () => {
    expect(buildScheduleGroups(items, options)[0]?.rows.map((r) => r.schedule.id)).toEqual([
      "Soon",
      "Later",
      "Paused",
    ]);
    expect(
      buildScheduleGroups(items, { ...options, status: "paused" })[0]?.rows.map(
        (r) => r.schedule.id,
      ),
    ).toEqual(["Paused"]);
    expect(
      buildScheduleGroups(items, { ...options, status: "ended", project: "all" })[0],
    ).toMatchObject({
      id: "unassigned",
      rows: [{ schedule: { id: "Loose" } }],
    });
  });

  it("supports alphabetical and most recently created sorting inside a project", () => {
    expect(
      buildScheduleGroups(items, { ...options, sort: "name" })[0]?.rows.map((r) => r.schedule.id),
    ).toEqual(["Later", "Paused", "Soon"]);
    expect(
      buildScheduleGroups(items, { ...options, sort: "recent" })[0]?.rows.map((r) => r.schedule.id),
    ).toEqual(["Later", "Soon", "Paused"]);
  });
});

function row(
  id: string,
  project: ScheduleRowView["project"],
  serverId: string,
  state: ScheduleRowView["state"],
  nextRunAt: string | null,
): ScheduleRowView {
  return {
    schedule: {
      id,
      name: id,
      serverId,
      serverName: serverId,
      prompt: id,
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "codex", cwd: "/" } },
      status: state === "paused" ? "paused" : "active",
      createdAt: nextRunAt ?? "2026-11-21",
      updatedAt: "2026-11-21",
      nextRunAt,
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
    },
    project,
    state,
    provider: null,
    targetLabel: "/",
    showHost: true,
  };
}

describe("schedule masonry", () => {
  it("uses the available pane width and caps the columns at the number of sections", () => {
    expect([649, 650, 1039, 1040].map((width) => scheduleColumnCount(width, 5))).toEqual([
      1, 2, 2, 3,
    ]);
    expect(scheduleColumnCount(1440, 1)).toBe(1);
    expect(scheduleColumnCount(1440, 2)).toBe(2);
  });

  it("moves cards into the shortest column when a section is collapsed", () => {
    expect(placeScheduleSections([190, 95, 95, 70], 2, 8)).toEqual({
      positions: [
        { column: 0, top: 0 },
        { column: 1, top: 0 },
        { column: 1, top: 103 },
        { column: 0, top: 198 },
      ],
      height: 268,
    });
    expect(placeScheduleSections([34, 95, 95, 70], 2, 8)).toEqual({
      positions: [
        { column: 0, top: 0 },
        { column: 1, top: 0 },
        { column: 0, top: 42 },
        { column: 1, top: 103 },
      ],
      height: 173,
    });
  });
});
