import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "@/utils/projects";
import {
  buildProjectNameByCwd,
  buildScheduleProjectTargets,
  buildScheduleProjectLookup,
  resolveScheduleProject,
  describeScheduleCwd,
} from "./schedule-project-targets";

function makeProject(overrides: Partial<ProjectSummary>): ProjectSummary {
  return {
    viewKey: "proj",
    projectName: "Project",
    hosts: [],
    totalWorkspaceCount: 0,
    hostCount: 0,
    onlineHostCount: 0,
    ...overrides,
  };
}

function makeHost(overrides: Partial<ProjectSummary["hosts"][number]>) {
  return {
    serverId: "host-1",
    projectId: "project-1",
    projectName: "Project",
    projectCustomName: null,
    serverName: "Host 1",
    isOnline: true,
    repoRoot: "/tmp/project",
    workspaceCount: 0,
    workspaces: [],
    ...overrides,
  };
}

describe("buildScheduleProjectTargets", () => {
  it("emits one target per online host with a repo root", () => {
    const targets = buildScheduleProjectTargets([
      makeProject({
        projectName: "Alpha",
        hosts: [
          makeHost({ projectName: "Alpha on Host 1", repoRoot: "/tmp/alpha" }),
          makeHost({ serverId: "host-2", projectName: "Alpha on Host 2" }),
        ],
      }),
    ]);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      serverId: "host-1",
      cwd: "/tmp/alpha",
      projectName: "Alpha on Host 1",
    });
  });

  it("skips offline hosts and blank repo roots", () => {
    const targets = buildScheduleProjectTargets([
      makeProject({
        hosts: [makeHost({ isOnline: false }), makeHost({ serverId: "host-3", repoRoot: "   " })],
      }),
    ]);
    expect(targets).toHaveLength(0);
  });
});

describe("describeScheduleCwd", () => {
  it("prefers a matched project name and shortens unmatched paths", () => {
    const byCwd = buildProjectNameByCwd(
      buildScheduleProjectTargets([
        makeProject({
          projectName: "Grouped Alpha",
          hosts: [makeHost({ projectName: "Alpha on Host 1", repoRoot: "/tmp/alpha" })],
        }),
      ]),
    );
    expect(
      describeScheduleCwd({ serverId: "host-1", cwd: "/tmp/alpha", projectNameByCwd: byCwd }),
    ).toBe("Alpha on Host 1");
    expect(
      describeScheduleCwd({ serverId: "host-1", cwd: "/Users/sam/api", projectNameByCwd: byCwd }),
    ).toBe("~/api");
  });
});

describe("resolveScheduleProject", () => {
  const workspace = {
    id: "worktree-1",
    name: "Feature",
    workspaceKind: "worktree",
    status: "running",
    currentBranch: null,
    changeRequestNumber: null,
  } satisfies ProjectSummary["hosts"][number]["workspaces"][number];
  const lookup = buildScheduleProjectLookup([
    makeProject({
      viewKey: "shared",
      projectName: "Same name",
      hosts: [
        makeHost({ repoRoot: "/tmp/shared", workspaces: [workspace] }),
        makeHost({ serverId: "host-2", repoRoot: "/mnt/shared" }),
      ],
    }),
    makeProject({
      viewKey: "other",
      projectName: "Same name",
      hosts: [makeHost({ serverId: "host-2", repoRoot: "/tmp/shared" })],
    }),
  ]);
  const target = (cwd: string) =>
    ({ type: "new-agent", config: { provider: "codex", cwd } }) as const;
  const heartbeat = { type: "agent", agentId: "agent-1" } as const;

  it("merges matching project placements across hosts while distinguishing homonyms", () => {
    expect(resolveScheduleProject(lookup, "host-1", target("/tmp/shared"))?.id).toBe(
      "project:shared",
    );
    expect(resolveScheduleProject(lookup, "host-2", target("/mnt/shared"))?.id).toBe(
      "project:shared",
    );
    expect(resolveScheduleProject(lookup, "host-2", target("/tmp/shared"))?.id).toBe(
      "project:other",
    );
  });

  it("prefers the agent's workspace and falls back to its known project root", () => {
    expect(
      resolveScheduleProject(lookup, "host-1", heartbeat, {
        workspaceId: workspace.id,
        cwd: "/tmp/worktrees/feature",
        projectRoot: "/retired/root",
      })?.id,
    ).toBe("project:shared");
    expect(
      resolveScheduleProject(lookup, "host-2", heartbeat, {
        workspaceId: workspace.id,
        cwd: "/tmp/worktrees/feature",
        projectRoot: "/mnt/shared",
      })?.id,
    ).toBe("project:shared");
  });

  it("leaves missing targets and unknown paths unassigned", () => {
    expect(resolveScheduleProject(lookup, "host-2", heartbeat)).toBeNull();
    expect(resolveScheduleProject(lookup, "host-1", target("/tmp/shared-backup"))).toBeNull();
  });
});
