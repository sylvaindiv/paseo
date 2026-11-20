import { formatTokenCount } from "@/components/context-window-meter.utils";
import type { UsageDisplayAs } from "./preferences";
import type { UsageBalanceUnit } from "./types";

export function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function formatPct(value: number): string {
  return `${Math.round(clampPct(value))}%`;
}

/** "31%" of the window used, or "69% left" of it. */
export function formatDisplayPct(value: number, displayAs: UsageDisplayAs): string {
  return displayAs === "used" ? formatPct(value) : `${formatPct(value)} left`;
}

function relativeDuration(iso: string): string | null {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs <= 0) return "now";
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) return `${diffDays}d`;
  if (diffHours > 0) return `${diffHours}h`;
  return `${diffMinutes}m`;
}

export function formatResetLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const rel = relativeDuration(iso);
  if (!rel) return null;
  return rel === "now" ? "resetting now" : `resets ${rel}`;
}

/** A balance amount as the app's language writes it: "$1,234.50", "12,345". */
export function formatAmount(value: number, unit: UsageBalanceUnit, locale: string): string {
  switch (unit) {
    case "usd":
      return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);
    case "tokens":
      return formatTokenCount(value);
    default:
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  }
}

/** Two units keep long countdowns readable in the sidebar. */
export function formatSidebarDuration(
  iso: string | undefined,
  now: number,
  locale: string,
  showElapsed = false,
): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || (ms <= 0 && !showElapsed)) return null;
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const formatUnit = (value: number, unit: string) => formatSidebarUnit(value, unit, locale);
  if (days > 0) return `${formatUnit(days, "day")} ${formatUnit(hours % 24, "hour")}`;
  if (hours > 0) return `${formatUnit(hours, "hour")} ${formatUnit(minutes % 60, "minute")}`;
  return formatUnit(minutes, "minute");
}

export function formatSidebarUnit(value: number, unit: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: locale.startsWith("fr") ? "short" : "narrow",
  }).format(value);
}
