import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import type { ProjectSummary } from "@/utils/projects";
import { shortenPath } from "@/utils/shorten-path";

export const PROJECT_OPTION_PREFIX = "project:";

export interface ScheduleProjectTarget {
  optionId: string;
  serverId: string;
  serverName: string;
  projectViewKey: string;
  projectName: string;
  cwd: string;
  isGit: boolean;
}

export function buildProjectOptionId(serverId: string, projectViewKey: string): string {
  return `${PROJECT_OPTION_PREFIX}${serverId}:${projectViewKey}`;
}

/**
 * The project roots the schedule form can target: one per online host of each
 * project, keyed by (serverId, cwd). The schedules list reuses this set to name
 * a schedule's stored cwd; the two surfaces must agree on what "a project" is.
 */
export function buildScheduleProjectTargets(
  projects: readonly ProjectSummary[],
): ScheduleProjectTarget[] {
  const targets: ScheduleProjectTarget[] = [];
  for (const project of projects) {
    for (const host of project.hosts) {
      const cwd = host.repoRoot.trim();
      if (!host.isOnline || !cwd) {
        continue;
      }
      targets.push({
        optionId: buildProjectOptionId(host.serverId, project.viewKey),
        serverId: host.serverId,
        serverName: host.serverName,
        projectViewKey: project.viewKey,
        projectName: host.projectName,
        cwd,
        isGit: Boolean(host.gitRuntime),
      });
    }
  }
  return targets;
}

function projectNameKey(serverId: string, cwd: string): string {
  return `${serverId}:${cwd.trim()}`;
}

/** Map (serverId, cwd) -> project name for naming a schedule's stored cwd. */
export function buildProjectNameByCwd(
  targets: readonly ScheduleProjectTarget[],
): Map<string, string> {
  const byCwd = new Map<string, string>();
  for (const target of targets) {
    byCwd.set(projectNameKey(target.serverId, target.cwd), target.projectName);
  }
  return byCwd;
}

/**
 * Name a stored cwd for display: the matching project name when the client
 * knows this root on this host, otherwise the shortened path itself. Never
 * blank, never a claim the client cannot back up.
 */
export function describeScheduleCwd(input: {
  serverId: string;
  cwd: string;
  projectNameByCwd: ReadonlyMap<string, string>;
}): string {
  return (
    input.projectNameByCwd.get(projectNameKey(input.serverId, input.cwd)) ?? shortenPath(input.cwd)
  );
}

export interface ScheduleProject {
  id: string;
  label: string;
}

export interface ScheduleProjectLookup {
  roots: ReadonlyMap<string, ScheduleProject | null>;
  workspaces: ReadonlyMap<string, ScheduleProject>;
}

export interface ScheduleAgentPlacement {
  workspaceId?: string | null;
  cwd: string;
  projectRoot?: string | null;
}

export function buildScheduleProjectLookup(
  projects: readonly ProjectSummary[],
): ScheduleProjectLookup {
  const roots = new Map<string, ScheduleProject | null>();
  const workspaces = new Map<string, ScheduleProject>();
  const labelCounts = new Map<string, number>();
  for (const { projectName } of projects) {
    labelCounts.set(projectName, (labelCounts.get(projectName) ?? 0) + 1);
  }

  for (const project of projects) {
    const firstHost = project.hosts[0];
    const disambiguation =
      firstHost && (labelCounts.get(project.projectName) ?? 0) > 1
        ? [firstHost.serverName, shortenPath(firstHost.repoRoot)].filter(Boolean).join(" · ")
        : "";
    const ref: ScheduleProject = {
      id: `${PROJECT_OPTION_PREFIX}${project.viewKey}`,
      label: disambiguation ? `${project.projectName} · ${disambiguation}` : project.projectName,
    };
    for (const host of project.hosts) {
      if (host.repoRoot.trim()) {
        const key = projectNameKey(host.serverId, host.repoRoot);
        const existing = roots.get(key);
        roots.set(key, existing === undefined || existing?.id === ref.id ? ref : null);
      }
      for (const workspace of host.workspaces) {
        workspaces.set(JSON.stringify([host.serverId, workspace.id]), ref);
      }
    }
  }
  return { roots, workspaces };
}

export function resolveScheduleProject(
  lookup: ScheduleProjectLookup,
  serverId: string,
  target: ScheduleSummary["target"],
  agent?: ScheduleAgentPlacement,
): ScheduleProject | null {
  if (target.type === "new-agent") {
    return lookup.roots.get(projectNameKey(serverId, target.config.cwd)) ?? null;
  }
  if (!agent) return null;
  const workspace = agent.workspaceId
    ? lookup.workspaces.get(JSON.stringify([serverId, agent.workspaceId]))
    : undefined;
  return (
    workspace ??
    (agent.projectRoot ? lookup.roots.get(projectNameKey(serverId, agent.projectRoot)) : null) ??
    lookup.roots.get(projectNameKey(serverId, agent.cwd)) ??
    null
  );
}
