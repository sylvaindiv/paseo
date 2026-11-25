import {
  createContext,
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
import { formatSidebarDuration } from "./format";
import { resolvePinnedUsage, type PinnedUsageSource } from "./pinned";
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
 * The footer summary opens the Usage modal over the current screen.
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

export function useOpenSidebarUsage(): () => void {
  const openUsage = useContext(OpenSidebarUsageContext);
  if (!openUsage) throw new Error("Sidebar Usage must be inside UsageSidebarRoot.");
  return openUsage;
}

function triggerStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return hovered ? [styles.trigger, styles.triggerHovered] : styles.trigger;
}

function compactTriggerStyle(state: PressableStateCallbackType) {
  return [triggerStyle(state), styles.triggerCompact];
}

function PinnedUsageTrigger({
  label,
  sources,
  onPress,
}: {
  label: string;
  sources: readonly PinnedUsageSource[];
  onPress: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [now, setNow] = useState(Date.now);
  const [compact, setCompact] = useState(false);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setCompact(event.nativeEvent.layout.width <= 260);
  }, []);
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
    const shortenCountdown =
      compact && source.windows.length > 1 && (credits !== null || cards !== null);
    return {
      ...source,
      creditsText: credits,
      cardsText: cards,
      cardsExpiry: formatSidebarDuration(source.resetCredits?.expiresAt, now, locale),
      shortenCountdown,
      windows: source.windows.map((window) => {
        const countdown = formatSidebarDuration(window.codexResetsAt, now, locale, {
          showElapsed: true,
        });
        const displayCountdown = shortenCountdown
          ? formatSidebarDuration(window.codexResetsAt, now, locale, {
              showElapsed: true,
              singleUnit: true,
            })
          : countdown;
        return { ...window, countdown, displayCountdown };
      }),
    };
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
      onLayout={handleLayout}
      style={compact ? compactTriggerStyle : triggerStyle}
      testID="sidebar-usage"
    >
      {formatted.map((source) => (
        <PinnedUsageLine key={source.key} source={source} compact={compact} />
      ))}
    </Pressable>
  );
}

interface FormattedUsageSource extends PinnedUsageSource {
  creditsText: string | null;
  cardsText: string | null;
  cardsExpiry: string | null;
  shortenCountdown: boolean;
  windows: (PinnedUsageSource["windows"][number] & {
    countdown: string | null;
    displayCountdown: string | null;
  })[];
}

function PinnedUsageLine({ source, compact }: { source: FormattedUsageSource; compact: boolean }) {
  const hideIcon = compact && source.sourceId === "codex";
  const textStyle = [styles.text, source.shortenCountdown && styles.denseText];
  return (
    <View style={styles.line} testID="sidebar-usage-line">
      <View style={[styles.windows, compact && styles.windowsCompact]}>
        {hideIcon ? null : (
          <View testID="sidebar-usage-source">
            <UsageSourceIcon svg={source.icon} size={14} />
          </View>
        )}
        {source.windows.map((window) => (
          <View key={window.key} style={[styles.window, compact && styles.windowCompact]}>
            <Text
              style={[textStyle, styles.strong]}
              numberOfLines={1}
              testID="sidebar-usage-pinned-window"
            >
              {window.percentText}
              {window.shortLabel &&
              !(window.countdown && (hideIcon || window.shortLabel === "wk")) ? (
                <Text style={[styles.muted, styles.regular]}>{` ${window.shortLabel}`}</Text>
              ) : null}
            </Text>
            {window.displayCountdown ? (
              <Text
                style={[textStyle, styles.muted, styles.countdown]}
                numberOfLines={1}
                testID="sidebar-usage-reset"
              >
                {window.displayCountdown.replace(/\s+/g, "")}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
      {source.creditsText !== null || source.cardsText !== null ? (
        <View style={[styles.details, styles.divider]}>
          {source.creditsText !== null ? (
            <View style={[styles.creditBlock, compact && styles.creditBlockCompact]}>
              <Text style={[textStyle, styles.strong]} testID="sidebar-usage-credits">
                {source.creditsText}
              </Text>
            </View>
          ) : null}
          {source.cardsText !== null ? (
            <View
              style={[
                styles.cardBlock,
                compact && styles.cardBlockCompact,
                source.creditsText !== null && styles.divider,
              ]}
            >
              <Text style={textStyle} testID="sidebar-usage-cards">
                <Text style={styles.muted}>↺</Text>
                <Text style={styles.strong}>{source.cardsText}</Text>
                {source.cardsExpiry ? (
                  <Text style={styles.muted}>{` ${source.cardsExpiry.replace(/\s+/g, "")}`}</Text>
                ) : null}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    alignSelf: "stretch",
    marginHorizontal: -theme.spacing[2],
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 28,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
  },
  triggerCompact: { paddingHorizontal: theme.spacing[2] },
  triggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  line: {
    flexGrow: 1,
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
  },
  windows: {
    flexGrow: 1.5,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minHeight: 18,
    paddingEnd: theme.spacing[2],
  },
  windowsCompact: { gap: theme.spacing[1], paddingEnd: theme.spacing[0.5] },
  window: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[1.5],
  },
  windowCompact: { gap: theme.spacing[0.5] },
  details: { flexGrow: 2, flexDirection: "row", alignItems: "center", minHeight: 18 },
  creditBlock: {
    flexGrow: 1,
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
  },
  creditBlockCompact: { paddingHorizontal: theme.spacing[0.5] },
  cardBlock: {
    flexGrow: 1,
    alignItems: "flex-end",
    paddingStart: theme.spacing[2],
  },
  cardBlockCompact: { paddingStart: theme.spacing[0.5] },
  divider: { borderStartWidth: 1, borderStartColor: theme.colors.border },
  text: {
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  denseText: { fontSize: theme.fontSize.sm - 1 },
  countdown: { flexShrink: 1, minWidth: 0 },
  strong: { fontWeight: theme.fontWeight.semibold },
  regular: { fontWeight: theme.fontWeight.normal },
  muted: { color: theme.colors.foregroundMuted },
}));
