import type { AggregatedSchedule } from "@/schedules/aggregated-schedules";
import { scheduleBucket, type ScheduleDerivedState } from "@/schedules/schedule-derivation";
import type { ScheduleProject } from "@/schedules/schedule-project-targets";
import { resolveScheduleTitle } from "@/utils/schedule-format";

export type ScheduleStatusFilter = "all" | "active" | "paused" | "ended";
export type ScheduleSort = "next" | "name" | "recent";

export interface ScheduleRowView {
  schedule: AggregatedSchedule;
  project: ScheduleProject | null;
  targetLabel: string;
  provider: string | null;
  state: ScheduleDerivedState;
  showHost: boolean;
}

export interface ScheduleGroup extends ScheduleProject {
  rows: ScheduleRowView[];
}

interface ScheduleListOptions {
  host: string | null;
  status: ScheduleStatusFilter;
  project: string;
  sort: ScheduleSort;
  locale: string;
  unassignedLabel: string;
}

export const ALL_SCHEDULE_PROJECTS = "all";
export const SCHEDULES_MAX_WIDTH = 1440;
const UNASSIGNED_PROJECT = "unassigned";

function scheduleProject(row: ScheduleRowView, unassignedLabel: string): ScheduleProject {
  return row.project ?? { id: UNASSIGNED_PROJECT, label: unassignedLabel };
}

export function listScheduleProjects(
  rows: readonly ScheduleRowView[],
  locale: string,
  unassignedLabel: string,
): ScheduleProject[] {
  const projects = new Map<string, ScheduleProject>();
  for (const row of rows) {
    const project = scheduleProject(row, unassignedLabel);
    projects.set(project.id, project);
  }
  return sortProjects([...projects.values()], locale);
}

function sortProjects<T extends ScheduleProject>(projects: T[], locale: string): T[] {
  return projects.sort(
    (a, b) =>
      Number(a.id === UNASSIGNED_PROJECT) - Number(b.id === UNASSIGNED_PROJECT) ||
      a.label.localeCompare(b.label, locale) ||
      a.id.localeCompare(b.id),
  );
}

function nextRun(row: ScheduleRowView): number {
  const timestamp =
    row.state === "active" && row.schedule.nextRunAt ? Date.parse(row.schedule.nextRunAt) : NaN;
  return Number.isFinite(timestamp) ? timestamp : Infinity;
}

export function buildScheduleGroups(
  rows: readonly ScheduleRowView[],
  { host, status, project, sort, locale, unassignedLabel }: ScheduleListOptions,
): ScheduleGroup[] {
  const groups = new Map<string, ScheduleGroup>();
  for (const row of rows) {
    if (host !== null && row.schedule.serverId !== host) continue;
    if (
      status !== "all" &&
      (status === "ended" ? scheduleBucket(row.state) !== "ended" : status !== row.state)
    ) {
      continue;
    }
    const ref = scheduleProject(row, unassignedLabel);
    if (project !== ALL_SCHEDULE_PROJECTS && project !== ref.id) continue;
    const group = groups.get(ref.id);
    if (group) group.rows.push(row);
    else groups.set(ref.id, { ...ref, rows: [row] });
  }

  for (const group of groups.values()) {
    group.rows.sort((a, b) => {
      let order = 0;
      if (sort === "next") order = nextRun(a) - nextRun(b);
      else if (sort === "recent")
        order = Date.parse(b.schedule.createdAt) - Date.parse(a.schedule.createdAt);
      return (
        order ||
        resolveScheduleTitle(a.schedule).localeCompare(resolveScheduleTitle(b.schedule), locale) ||
        a.schedule.serverId.localeCompare(b.schedule.serverId) ||
        a.schedule.id.localeCompare(b.schedule.id)
      );
    });
  }
  return sortProjects([...groups.values()], locale);
}

export function scheduleColumnCount(width: number, sectionCount: number): number {
  const columns = width >= 1040 ? 3 : 1 + Number(width >= 650);
  return Math.max(1, Math.min(sectionCount, columns));
}

export function placeScheduleSections(heights: readonly number[], columns: number, gap: number) {
  const ends = Array.from({ length: columns }, () => 0);
  const positions = heights.map((height) => {
    const top = Math.min(...ends);
    const column = ends.indexOf(top);
    ends[column] = top + height + gap;
    return { column, top };
  });
  return { positions, height: Math.max(0, Math.max(...ends) - gap) };
}
