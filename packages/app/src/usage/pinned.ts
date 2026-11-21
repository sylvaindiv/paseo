import { formatPct } from "./format";
import { displayPercent } from "./model";
import { effectiveUsagePins, type UsagePreferences } from "./preferences";
import type { UsageReportEntry } from "./types";

/** One summary window of one account, as the sidebar Usage item shows it. */
export interface PinnedUsageWindow {
  key: string;
  /** Accessible description, including the source, account, window and percent meaning. */
  label: string;
  /** The window's short name ("5h"), empty for none, or its label when the source sends none. */
  shortLabel: string;
  percentText: string;
  codexResetsAt?: string;
}

/** One account's summary windows, under its source's icon. */
export interface PinnedUsageSource {
  key: string;
  icon: string | null;
  sourceId: string;
  windows: PinnedUsageWindow[];
  credits?: number;
  resetCredits?: { count: number; expiresAt?: string };
}

function describe(entry: UsageReportEntry, windowLabel: string): string {
  const account = entry.account.label ? ` (${entry.account.label})` : "";
  return `${entry.sourceLabel}${account} ${windowLabel}`;
}

/** Reports with every account of a source together, sources in the order they first appear. */
function groupBySource(reports: readonly UsageReportEntry[]): UsageReportEntry[] {
  const sourceIds = [...new Set(reports.map((entry) => entry.sourceId))];
  return sourceIds.flatMap((sourceId) => reports.filter((entry) => entry.sourceId === sourceId));
}

/**
 * The sidebar Usage item's summary: one group per account, grouped by source, each with its
 * windows in its report's order. Accounts with nothing to show are left out.
 */
export function resolvePinnedUsage(
  reports: readonly UsageReportEntry[],
  preferences: UsagePreferences,
): PinnedUsageSource[] {
  const pins = effectiveUsagePins(preferences, reports);
  const meaning = preferences.displayAs === "remaining" ? "left" : "used";
  return groupBySource(reports).flatMap((entry) => {
    if (entry.report.status !== "available") return [];
    const windows = entry.report.windows
      .filter(
        (window) =>
          displayPercent(window, preferences.displayAs) !== null &&
          pins.some((pin) => pin.sourceId === entry.sourceId && pin.windowId === window.id),
      )
      .map((window) => {
        const percent = displayPercent(window, preferences.displayAs) ?? 0;
        const percentText = formatPct(percent);
        return {
          key: `${entry.id}/${window.id}`,
          label: `${describe(entry, window.label)} ${percentText} ${meaning}`,
          shortLabel: window.shortLabel ?? window.label,
          percentText,
          codexResetsAt: entry.sourceId === "codex" ? (window.resetsAt ?? undefined) : undefined,
        };
      });
    if (windows.length === 0) return [];
    const codex = entry.sourceId === "codex" ? entry.report : null;
    const credits = codex?.balances?.find((balance) => balance.id === "credits")?.remaining;
    return [
      {
        key: entry.id,
        icon: entry.icon ?? null,
        sourceId: entry.sourceId,
        windows,
        ...(credits != null ? { credits } : {}),
        ...(codex?.resetCredits ? { resetCredits: codex.resetCredits } : {}),
      },
    ];
  });
}
