import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { Copy, RotateCw } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ScrollableCodeSurface, SurfaceCard } from "@/components/ui/scrollable-code-surface";
import { useToast } from "@/contexts/toast-context";
import {
  formatAppDiagnosticHeader,
  formatDiagnosticSection,
  formatHostRuntimeSection,
  formatServerInfoSection,
  redactAppDiagnosticReport,
} from "@/diagnostics/app-diagnostic-report";
import { collectDesktopDiagnosticSections } from "@/diagnostics/desktop-diagnostic-report";
import { getHostRuntimeStore, useHosts, type HostRuntimeSnapshot } from "@/runtime/host-runtime";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";

interface AppDiagnosticSheetProps {
  visible: boolean;
  onClose: () => void;
  appVersion: string | null;
  isDesktopApp: boolean;
}

type ProgressStatus = "pending" | "running" | "done" | "failed";

interface ProgressRow {
  id: string;
  label: string;
  status: ProgressStatus;
}

interface DiagnosticCollectionResult {
  sections: string[];
  status: ProgressStatus;
}

type HostClient = NonNullable<HostRuntimeSnapshot["client"]>;
type HostMemory = Awaited<ReturnType<HostClient["getResourceMemory"]>>;

function formatMemory(bytes: number, language: string): string {
  return new Intl.NumberFormat(language, {
    maximumFractionDigits: 0,
    style: "unit",
    unit: "megabyte",
  }).format(bytes / 1_000_000);
}

const SNAP_POINTS = ["55%", "88%"];
const ThemedCopy = withUnistyles(Copy);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function AppDiagnosticSheet({
  visible,
  onClose,
  appVersion,
  isDesktopApp,
}: AppDiagnosticSheetProps) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const hosts = useHosts();
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressRow[]>([]);
  const runIdRef = useRef(0);
  const [memory, setMemory] = useState<Record<string, HostMemory>>({});
  const [hibernating, setHibernating] = useState(false);

  const updateProgress = useCallback((id: string, label: string, status: ProgressStatus) => {
    setProgress((current) => {
      const existing = current.find((row) => row.id === id);
      if (existing) {
        return current.map((row) => (row.id === id ? { ...row, label, status } : row));
      }
      return [...current, { id, label, status }];
    });
  }, []);

  const runDiagnostics = useCallback(async () => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const isCurrentRun = () => runIdRef.current === runId;
    const updateRunProgress = (id: string, label: string, status: ProgressStatus) => {
      if (isCurrentRun()) {
        updateProgress(id, label, status);
      }
    };

    setLoading(true);
    setDiagnostic(null);
    setProgress([]);
    setMemory({});

    const sections: string[] = [];
    try {
      updateRunProgress("client", t("settings.diagnostics.app.progress.client"), "running");
      sections.push(
        formatAppDiagnosticHeader({
          appVersion,
          platform: Platform.OS,
          isDesktopApp,
          hostCount: hosts.length,
        }),
      );
      updateRunProgress("client", t("settings.diagnostics.app.progress.client"), "done");

      if (isDesktopApp) {
        const desktopLabel = t("settings.diagnostics.app.progress.desktop");
        updateRunProgress("desktop", desktopLabel, "running");
        const desktopResult = await collectDesktopDiagnosticSections();
        sections.push(...desktopResult.sections);
        updateRunProgress("desktop", desktopLabel, desktopResult.status);
      }

      const store = getHostRuntimeStore();
      for (const host of hosts) {
        const hostProgressId = `host:${host.serverId}`;
        updateRunProgress(hostProgressId, host.label, "running");
        const snapshot = store.getSnapshot(host.serverId);
        const client = snapshot?.client;
        const memoryResult =
          snapshot?.connectionStatus === "online" &&
          client?.getLastServerInfoMessage()?.features?.resourceRetention === true
            ? client.getResourceMemory().catch(() => null)
            : null;
        const hostResult = await collectHostDiagnosticSections(host, snapshot);
        const sampled = await memoryResult;
        if (sampled && isCurrentRun()) {
          setMemory((current) => ({ ...current, [host.serverId]: sampled }));
        }
        sections.push(...hostResult.sections);
        updateRunProgress(hostProgressId, host.label, hostResult.status);
      }

      if (isCurrentRun()) {
        setDiagnostic(redactAppDiagnosticReport(sections.join("\n\n"), hosts));
      }
    } finally {
      if (isCurrentRun()) {
        setLoading(false);
      }
    }
  }, [appVersion, hosts, isDesktopApp, t, updateProgress]);

  useEffect(() => {
    if (visible) {
      void runDiagnostics();
    } else {
      runIdRef.current += 1;
      setLoading(false);
      setDiagnostic(null);
      setProgress([]);
      setMemory({});
    }
  }, [visible, runDiagnostics]);

  const hibernate = useCallback(
    async (serverId: string, agentId: string) => {
      const client = getHostRuntimeStore().getSnapshot(serverId)?.client;
      if (!client || hibernating) return;
      const runId = runIdRef.current;
      setHibernating(true);
      try {
        const { released } = await client.hibernateAgent(agentId);
        if (runIdRef.current !== runId) return;
        if (!released) {
          toast.error(t("settings.diagnostics.app.hibernateUnavailable"));
        }
        const updated = await client.getResourceMemory();
        if (runIdRef.current === runId) {
          setMemory((current) => ({ ...current, [serverId]: updated }));
        }
      } catch {
        if (runIdRef.current === runId)
          toast.error(t("settings.diagnostics.app.hibernateUnavailable"));
      } finally {
        setHibernating(false);
      }
    },
    [hibernating, t, toast],
  );

  const handleRefreshPress = useCallback(() => {
    void runDiagnostics();
  }, [runDiagnostics]);

  const handleCopyPress = useCallback(() => {
    if (!diagnostic) return;
    void Clipboard.setStringAsync(diagnostic)
      .then(() => toast.copied(t("settings.diagnostics.app.copyLabel")))
      .catch(() => toast.error(t("settings.diagnostics.app.copyFailed")));
  }, [diagnostic, t, toast]);

  const iconButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.iconButton,
      (Boolean(hovered) || pressed) && styles.iconButtonHovered,
    ],
    [],
  );

  const disabledIconButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.iconButton,
      (Boolean(hovered) || pressed) && Boolean(diagnostic) && styles.iconButtonHovered,
      diagnostic ? null : styles.disabled,
    ],
    [diagnostic],
  );

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.diagnostics.app.title"),
      actions: (
        <View style={styles.headerActions}>
          <Pressable
            onPress={handleCopyPress}
            disabled={!diagnostic}
            hitSlop={8}
            style={disabledIconButtonStyle}
            accessibilityRole="button"
            accessibilityLabel={t("settings.diagnostics.app.copyAccessibility")}
          >
            <ThemedCopy size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
          </Pressable>
          <Pressable
            onPress={handleRefreshPress}
            disabled={loading}
            hitSlop={8}
            style={iconButtonStyle}
            accessibilityRole="button"
            accessibilityLabel={
              loading
                ? t("settings.diagnostics.app.refreshingAccessibility")
                : t("settings.diagnostics.app.refreshAccessibility")
            }
          >
            {loading ? (
              <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
            ) : (
              <ThemedRotateCw size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
            )}
          </Pressable>
        </View>
      ),
    }),
    [
      diagnostic,
      disabledIconButtonStyle,
      handleCopyPress,
      handleRefreshPress,
      iconButtonStyle,
      loading,
      t,
    ],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      scrollable={false}
      testID="app-diagnostic-sheet"
    >
      {Object.keys(memory).length > 0 && (
        <ScrollView style={styles.memoryScroll}>
          {hosts.map((host) => {
            const sample = memory[host.serverId];
            if (!sample) return null;
            const fmt = (bytes: number) => formatMemory(bytes, i18n.language);
            return (
              <View key={host.serverId} style={styles.progressContent}>
                <Text style={styles.memoryTitle}>
                  {t("settings.diagnostics.app.agentMemory")} · {host.label}
                </Text>
                {sample.peak && (
                  <Text style={styles.mutedText}>
                    {t("settings.diagnostics.app.memoryPeak", {
                      memory: fmt(sample.peak.bytes),
                      time: new Date(sample.peak.at).toLocaleString(i18n.language),
                    })}
                  </Text>
                )}
                {sample.agents.length === 0 && (
                  <Text style={styles.mutedText}>
                    {t("settings.diagnostics.app.noMemoryAgents")}
                  </Text>
                )}
                {sample.agents.map((agent) => (
                  <View key={agent.id} style={styles.progressRow}>
                    <View style={styles.memoryAgent}>
                      <Text style={styles.memoryTitle}>
                        {agent.title} · {fmt(agent.bytes)}
                      </Text>
                      {agent.tools.length > 0 && (
                        <Text style={styles.mutedText}>
                          {agent.tools.map((tool) => `${tool.name} ${fmt(tool.bytes)}`).join(" · ")}
                        </Text>
                      )}
                    </View>
                    {agent.canHibernate && (
                      <HibernateButton
                        hostId={host.serverId}
                        agentId={agent.id}
                        disabled={hibernating}
                        onHibernate={hibernate}
                      />
                    )}
                  </View>
                ))}
              </View>
            );
          })}
        </ScrollView>
      )}
      {diagnostic ? (
        <ScrollableCodeSurface key={visible ? "visible" : "hidden"} maxHeight={520}>
          {diagnostic}
        </ScrollableCodeSurface>
      ) : (
        <SurfaceCard key={visible ? "visible" : "hidden"}>
          <View style={styles.progressContent}>
            {progress.length === 0 ? (
              <View style={styles.progressRow}>
                <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
                <Text style={styles.mutedText}>{t("settings.diagnostics.app.running")}</Text>
              </View>
            ) : (
              progress.map((row) => (
                <View key={row.id} style={styles.progressRow}>
                  {row.status === "running" || row.status === "pending" ? (
                    <ThemedLoadingSpinner
                      size={ICON_SIZE.sm}
                      uniProps={foregroundMutedColorMapping}
                    />
                  ) : (
                    <View
                      style={row.status === "failed" ? styles.statusDotFailed : styles.statusDot}
                    />
                  )}
                  <Text
                    style={styles.mutedText}
                  >{`${row.label}: ${formatProgressStatus(row.status)}`}</Text>
                </View>
              ))
            )}
          </View>
        </SurfaceCard>
      )}
    </AdaptiveModalSheet>
  );
}

interface HibernateButtonProps {
  hostId: string;
  agentId: string;
  disabled: boolean;
  onHibernate(hostId: string, agentId: string): Promise<void>;
}

function HibernateButton({ hostId, agentId, disabled, onHibernate }: HibernateButtonProps) {
  const { t } = useTranslation();
  const onPress = useCallback(
    () => void onHibernate(hostId, agentId),
    [onHibernate, hostId, agentId],
  );
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      style={styles.hibernateButton}
      onPress={onPress}
    >
      <Text style={styles.memoryTitle}>{t("settings.diagnostics.app.hibernate")}</Text>
    </Pressable>
  );
}

async function collectHostDiagnosticSections(
  host: HostProfile,
  snapshot: HostRuntimeSnapshot | null,
): Promise<DiagnosticCollectionResult> {
  const sections = [formatHostRuntimeSection({ host, snapshot })];
  const client = snapshot?.client ?? null;
  if (snapshot?.connectionStatus !== "online" || !client) {
    sections.push(
      formatDiagnosticSection(`Host diagnostics: ${host.label}`, [
        { label: "Status", value: "host is not connected" },
      ]),
    );
    return { sections, status: "done" };
  }

  try {
    const serverInfo = client.getLastServerInfoMessage();
    sections.push(formatServerInfoSection(serverInfo));

    const rttMs = await client.measureLatency({ timeoutMs: 5000 });
    sections.push(
      formatDiagnosticSection(`Host latency: ${host.label}`, [
        { label: "Active RTT", value: `${Math.round(rttMs)}ms` },
      ]),
    );

    if (serverInfo?.features?.daemonDiagnostics === true) {
      const result = await client.collectDiagnostics();
      sections.push(result.diagnostic);
    } else {
      sections.push(
        formatDiagnosticSection(`Daemon diagnostics: ${host.label}`, [
          { label: "Status", value: "unsupported by this daemon" },
        ]),
      );
    }

    return { sections, status: "done" };
  } catch (error) {
    sections.push(
      formatDiagnosticSection(`Host diagnostics: ${host.label}`, [
        { label: "Error", value: toMessage(error) },
      ]),
    );
    return { sections, status: "failed" };
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatProgressStatus(status: ProgressStatus): string {
  switch (status) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "running":
    case "pending":
      return "running";
  }
}

const styles = StyleSheet.create((theme) => ({
  memoryScroll: { maxHeight: 240, flexGrow: 0, flexShrink: 0 },
  memoryTitle: { color: theme.colors.foreground, fontWeight: "600" },
  memoryAgent: { flex: 1, gap: theme.spacing[1] },
  hibernateButton: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  progressContent: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[3],
  },
  progressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 24,
  },
  mutedText: {
    flex: 1,
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  disabled: {
    opacity: 0.5,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.success,
  },
  statusDotFailed: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.destructive,
  },
}));
