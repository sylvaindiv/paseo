import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useAppSettings } from "@/hooks/use-settings";
import { useUsageHostId } from "./hosts";
import { useUsageHostReports } from "./queries";
import { UsageSourceIcon } from "./source-icon";
import { UsageMeter } from "./meter";
import { formatSidebarDuration, formatSidebarUnit } from "./format";
import {
  choosePinnedUsageLayout,
  METER_GAP,
  MIN_METER_WIDTH,
  resolvePinnedUsage,
  type PinnedUsageLayout,
  type PinnedUsageSource,
} from "./pinned";
import { UsageModal } from "./usage-modal";

export function useUsageSummary(enabled: boolean): readonly PinnedUsageSource[] {
  const { settings } = useAppSettings();
  const active = useRetainedPanelActive();
  const visible = useAppVisible();
  const hostId = useUsageHostId();
  const reports = useUsageHostReports(enabled && active && visible ? hostId : null, true);
  return useMemo(() => resolvePinnedUsage(reports, settings.usage), [settings.usage, reports]);
}

export function UsageSidebarItem({ sources }: { sources: readonly PinnedUsageSource[] }) {
  const { t } = useTranslation();
  const openUsage = useOpenSidebarUsage();
  return (
    <PinnedUsageTrigger
      label={t(builtinSidebarNavLabelKey("usage"))}
      sources={sources}
      onPress={openUsage}
    />
  );
}

const OpenSidebarUsageContext = createContext<(() => void) | null>(null);

/**
 * One owner for the footer icon and summary: both open the Usage modal over the current screen.
 * The modal mounts on first open and unmounts once it has finished closing, so its host's reports
 * load only while it is shown.
 */
export function UsageSidebarRoot({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const openUsage = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);
  const closeUsage = useCallback(() => setOpen(false), []);
  const unmountUsage = useCallback(() => setMounted(false), []);

  return (
    <OpenSidebarUsageContext.Provider value={openUsage}>
      {children}
      {mounted ? <UsageModal visible={open} onClose={closeUsage} onDismiss={unmountUsage} /> : null}
    </OpenSidebarUsageContext.Provider>
  );
}

/** Both sidebar entry points send the same open command. */
export function useOpenSidebarUsage(): () => void {
  const openUsage = useContext(OpenSidebarUsageContext);
  if (!openUsage) throw new Error("Sidebar Usage must be inside UsageSidebarRoot.");
  return openUsage;
}

function triggerStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return hovered ? [styles.trigger, styles.triggerHovered] : styles.trigger;
}

function layoutWidth(event: LayoutChangeEvent): number {
  return event.nativeEvent.layout.width;
}

/**
 * One line: each account's icon, then per window a meter and "31% 5h". Off-screen copies measure
 * the line with labels and with percents alone; the richest layout that fits is shown, and what
 * it leaves out takes no space at all.
 */
function PinnedUsageTrigger({
  label,
  sources,
  onPress,
}: {
  label: string;
  sources: readonly PinnedUsageSource[];
  onPress: () => void;
}) {
  const [available, setAvailable] = useState<number | null>(null);
  const [labelsWidth, setLabelsWidth] = useState<number | null>(null);
  const [percentsWidth, setPercentsWidth] = useState<number | null>(null);
  const handleAvailableLayout = useCallback((event: LayoutChangeEvent) => {
    setAvailable(layoutWidth(event));
  }, []);
  const handleLabelsLayout = useCallback((event: LayoutChangeEvent) => {
    setLabelsWidth(layoutWidth(event));
  }, []);
  const handlePercentsLayout = useCallback((event: LayoutChangeEvent) => {
    setPercentsWidth(layoutWidth(event));
  }, []);
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const formatted = sources.map((source) => {
    const credits =
      source.credits === undefined
        ? null
        : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(source.credits);
    const cards = source.resetCredits
      ? new Intl.NumberFormat(locale).format(source.resetCredits.count)
      : null;
    return {
      ...source,
      creditsText: credits,
      cardsText: cards,
      cardsExpiry: formatSidebarDuration(source.resetCredits?.expiresAt, now, locale),
      windows: source.windows.map((window) => ({
        ...window,
        countdown: formatSidebarDuration(window.codexResetsAt, now, locale, true),
        period:
          window.codexResetsAt && window.shortLabel === "wk"
            ? formatSidebarUnit(7, "day", locale)
            : null,
      })),
    };
  });
  const hasCodexDetails = formatted.some(
    (source) =>
      source.creditsText !== null ||
      source.cardsText !== null ||
      source.windows.some((window) => window.countdown !== null),
  );
  const windowCount = sources.reduce((count, source) => count + source.windows.length, 0);
  const wrap =
    hasCodexDetails &&
    available !== null &&
    labelsWidth !== null &&
    labelsWidth + windowCount * (MIN_METER_WIDTH + METER_GAP) > available;
  const layout = choosePinnedUsageLayout({
    available,
    labelsWidth,
    percentsWidth,
    windowCount,
  });
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${formatted
        .flatMap((source) => [
          ...source.windows.map((window) =>
            window.countdown ? `${window.label} · ↻ ${window.countdown}` : window.label,
          ),
          source.creditsText === null
            ? null
            : t("sidebar.usageSummary.credits", { amount: source.creditsText }),
          source.cardsText === null || !source.resetCredits
            ? null
            : [
                t("sidebar.usageSummary.cards", {
                  count: source.resetCredits.count,
                  amount: source.cardsText,
                }),
                source.cardsExpiry,
              ]
                .filter(Boolean)
                .join(" · "),
        ])
        .filter(Boolean)
        .join(", ")}`}
      style={triggerStyle}
      testID="sidebar-usage"
    >
      <View style={[styles.line, wrap && styles.wrapped]} onLayout={handleAvailableLayout}>
        <PinnedUsageLine sources={formatted} layout={wrap ? "meters" : layout} wrap={wrap} />
      </View>
      <View
        style={styles.measure}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
      >
        <View style={styles.measured} onLayout={handleLabelsLayout}>
          <PinnedUsageLine sources={formatted} layout="labels" measuring />
        </View>
        <View style={styles.measured} onLayout={handlePercentsLayout}>
          <PinnedUsageLine sources={formatted} layout="percents" measuring />
        </View>
      </View>
    </Pressable>
  );
}

interface FormattedUsageSource extends PinnedUsageSource {
  creditsText: string | null;
  cardsText: string | null;
  cardsExpiry: string | null;
  windows: (PinnedUsageSource["windows"][number] & {
    countdown: string | null;
    period: string | null;
  })[];
}

function PinnedUsageLine({
  sources,
  layout,
  measuring = false,
  wrap = false,
}: {
  sources: readonly FormattedUsageSource[];
  layout: PinnedUsageLayout;
  measuring?: boolean;
  wrap?: boolean;
}) {
  const testIds = measuring
    ? {}
    : {
        source: "sidebar-usage-source",
        window: "sidebar-usage-pinned-window",
        reset: "sidebar-usage-reset",
        credits: "sidebar-usage-credits",
        cards: "sidebar-usage-cards",
      };
  return sources.map((source, sourceIndex) => (
    <Fragment key={source.key}>
      {source.windows.map((window, windowIndex) => (
        <View
          key={window.key}
          style={[
            styles.window,
            !wrap && (sourceIndex > 0 || windowIndex > 0) && styles.windowGap,
            layout === "meters" && !wrap && !window.countdown && styles.growingWindow,
          ]}
        >
          {windowIndex === 0 ? (
            <View style={styles.icon} testID={testIds.source}>
              <UsageSourceIcon svg={source.icon} size={14} />
            </View>
          ) : null}
          {layout === "meters" ? (
            <View
              style={[
                styles.meterSlot,
                (wrap || window.countdown !== null) && styles.compactMeterSlot,
              ]}
            >
              <UsageMeter percent={window.percent} tone={window.tone} quiet style={styles.meter} />
            </View>
          ) : null}
          {window.period && layout !== "percents" ? (
            <Text style={[styles.percent, styles.windowLabel]}>{`${window.period} `}</Text>
          ) : null}
          <Text
            style={[styles.percent, window.countdown && styles.strong]}
            numberOfLines={1}
            testID={testIds.window}
          >
            {window.percentText}
            {layout === "percents" || window.shortLabel === "" || window.period ? null : (
              <Text style={styles.windowLabel}>{` ${window.shortLabel}`}</Text>
            )}
          </Text>
          {window.countdown && layout !== "percents" ? (
            <Text
              style={[styles.percent, styles.windowLabel]}
              testID={testIds.reset}
            >{` ${window.countdown.replace(/\s+/g, "")}`}</Text>
          ) : null}
        </View>
      ))}
      {source.creditsText !== null || source.cardsText !== null ? (
        <View style={[styles.details, !wrap && styles.detailDivider]}>
          {source.creditsText !== null ? (
            <Text style={[styles.percent, styles.strong]} testID={testIds.credits}>
              {source.creditsText}
            </Text>
          ) : null}
          {source.cardsText !== null ? (
            <View style={source.creditsText === null ? null : styles.detailDivider}>
              <Text style={styles.percent} testID={testIds.cards}>
                <Text style={styles.windowLabel}>↺</Text>
                <Text style={styles.strong}>{source.cardsText}</Text>
                {source.cardsExpiry ? (
                  <Text
                    style={styles.windowLabel}
                  >{` ${source.cardsExpiry.replace(/\s+/g, "")}`}</Text>
                ) : null}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </Fragment>
  ));
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
    // Same row geometry and leading rail as Add project and the footer icons.
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  line: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  // Wide enough that nothing inside wraps or shrinks; each child reports its natural width.
  measure: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 10_000,
    opacity: 0,
  },
  measured: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
  },
  wrapped: { flexWrap: "wrap", gap: theme.spacing[1] },
  details: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  detailDivider: {
    marginLeft: theme.spacing[1],
    paddingLeft: theme.spacing[1],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  strong: { fontWeight: theme.fontWeight.semibold },
  window: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  growingWindow: { flexGrow: 1 },
  icon: { marginRight: theme.spacing[1.5] },
  windowGap: {
    marginLeft: theme.spacing[2],
  },
  // Every slot takes an equal share of the leftover width, so the line fills the row.
  meterSlot: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: MIN_METER_WIDTH,
    marginRight: METER_GAP,
  },
  compactMeterSlot: { flexGrow: 0, flexBasis: MIN_METER_WIDTH },
  meter: {
    height: 6,
    borderRadius: 3,
  },
  percent: {
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  windowLabel: {
    color: theme.colors.foregroundMuted,
  },
}));
