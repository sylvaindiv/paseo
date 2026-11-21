import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginProjectSummary } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  currentProjectPhase,
  readProjectsOverview,
  type OverviewPhase,
} from "../shared/project-todos.js";
import { ProjectButton } from "./project-button.js";
import { projectColors as colors } from "./styles.js";

const phaseLabels = {
  "À PLANNIFIER": "À planifier",
  "EN COURS": "En cours",
  "EN ATTENTE": "En attente",
  OK: "Fait",
} as const;

export function focusOverviewControl(view: View | null) {
  if (!view) return;
  if (Platform.OS === "web") view.focus();
  else AccessibilityInfo.sendAccessibilityEvent(view, "focus");
}

export function ProjectsOverview({
  hostId,
  projects,
  loadingProjects,
  close,
}: {
  hostId: string;
  projects: readonly PluginProjectSummary[];
  loadingProjects: boolean;
  close(): void;
}) {
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(560, width - 28);
  const compact = panelWidth < 420;
  const closeButton = useRef<View>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const read = useRpc(readProjectsOverview);
  const projectKeys = projects.map((project) => project.viewKey);
  const overview = useQuery({
    queryKey: ["projets", "overview", hostId, projectKeys],
    queryFn: () => read({ projectKeys }),
    enabled: projectKeys.length > 0,
    refetchOnMount: "always",
    retry: false,
  });
  const { refetch } = overview;
  const retry = useCallback(() => void refetch(), [refetch]);
  const focusClose = useCallback(() => {
    requestAnimationFrame(() => focusOverviewControl(closeButton.current));
  }, []);
  const phasesByProject = useMemo(
    () => new Map(overview.data?.map(({ projectKey, phases }) => [projectKey, phases])),
    [overview.data],
  );

  useEffect(() => {
    let mounted = true;
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== "web",
    });
    async function enter() {
      const reduced = await AccessibilityInfo.isReduceMotionEnabled().catch(() => false);
      if (!mounted) return;
      if (reduced) progress.setValue(1);
      else animation.start();
    }
    void enter();
    return () => {
      mounted = false;
      animation.stop();
    };
  }, [progress]);

  const panelStyle = useMemo(() => {
    const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [-panelWidth, 0] });
    return [styles.panel, { width: panelWidth, transform: [{ translateX }] }];
  }, [panelWidth, progress]);
  const isLoading = loadingProjects || overview.isLoading;
  return (
    <Modal
      visible
      transparent
      accessibilityLabel="Aperçu des projets"
      onRequestClose={close}
      onShow={focusClose}
    >
      <View style={styles.overlay}>
        <Pressable
          accessible={false}
          focusable={false}
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={styles.backdrop}
          onPress={close}
          testID="projets-overview-backdrop"
        />
        <Animated.View style={panelStyle} accessibilityViewIsModal testID="projets-overview">
          <SafeAreaView style={styles.body}>
            <View style={styles.header}>
              <Text accessibilityRole="header" style={styles.heading}>
                Aperçu des projets
              </Text>
              <ProjectButton ref={closeButton} onPress={close}>
                Fermer
              </ProjectButton>
            </View>
            {overview.isError ? (
              <View style={styles.notice}>
                <Text accessibilityRole="alert" style={styles.meta}>
                  Aperçu indisponible
                </Text>
                <ProjectButton onPress={retry}>Réessayer</ProjectButton>
              </View>
            ) : null}
            {isLoading ? <Text style={styles.noticeText}>Chargement…</Text> : null}
            {projects.length ? (
              <ScrollView style={styles.body} contentContainerStyle={styles.list}>
                {projects.map(({ viewKey, projectName }) => (
                  <OverviewRow
                    key={viewKey}
                    name={projectName}
                    phases={phasesByProject.get(viewKey)}
                    compact={compact}
                  />
                ))}
              </ScrollView>
            ) : null}
            {!projects.length && !isLoading ? (
              <Text style={styles.noticeText}>Aucun projet actif</Text>
            ) : null}
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}

function OverviewRow({
  name,
  phases,
  compact,
}: {
  name: string;
  phases?: readonly OverviewPhase[];
  compact: boolean;
}) {
  const current = phases && currentProjectPhase(phases);
  const status = current?.status;
  const emptyLabel = phases?.every((phase) => phase.total === 0) ? "Sans tâche" : "—";
  const label = status ? phaseLabels[status] : emptyLabel;
  const summaryStyle = StyleSheet.compose(styles.summary, compact && styles.summaryCompact);
  const badgeStyle = StyleSheet.compose(styles.badge, status && statusBackgrounds[status]);
  const badgeTextStyle = StyleSheet.compose(styles.badgeText, status && statusColors[status]);
  const summary =
    current && phases && phases.length > 1 ? (
      <View style={summaryStyle}>
        <Text numberOfLines={1} style={styles.phaseName}>
          {current.name}
          {status === "EN COURS" && current.total > 0
            ? ` · ${current.completed}/${current.total}`
            : ""}
        </Text>
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={phases
            .map(
              (phase) =>
                `${phase.name} · ${phase.status ? phaseLabels[phase.status] : "Sans statut"}`,
            )
            .join(", ")}
          style={styles.track}
          testID="projets-overview-phases"
        >
          {phases.map((phase) => {
            const segmentStyle = StyleSheet.compose(
              styles.segment,
              phase.status && statusBackgrounds[phase.status],
            );
            return (
              <View key={phase.id} style={segmentStyle}>
                {phase.status === "OK" ? <Text style={styles.check}>✓</Text> : null}
              </View>
            );
          })}
        </View>
      </View>
    ) : null;

  return (
    <View style={styles.row} testID="projets-overview-row">
      <View style={styles.rowLine}>
        <Text numberOfLines={1} style={styles.name}>
          {name}
        </Text>
        {!compact ? summary : null}
        <View style={badgeStyle}>
          <Text style={badgeTextStyle}>{label}</Text>
        </View>
      </View>
      {compact ? summary : null}
    </View>
  );
}

const statusColors = StyleSheet.create({
  "À PLANNIFIER": { color: colors.foregroundMuted },
  "EN COURS": { color: colors.surface0 },
  "EN ATTENTE": { color: colors.statusWarning },
  OK: { color: colors.statusSuccess },
});

const statusBackgrounds = StyleSheet.create({
  "À PLANNIFIER": { backgroundColor: colors.border },
  "EN COURS": { backgroundColor: colors.foreground },
  "EN ATTENTE": { backgroundColor: colors.warningBackground },
  OK: { backgroundColor: colors.successBackground },
});

const styles = StyleSheet.create({
  body: { flex: 1 },
  overlay: { flex: 1, flexDirection: "row" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(30, 25, 20, 0.34)" },
  panel: { backgroundColor: colors.surface0, borderRightWidth: 1, borderColor: colors.border },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  heading: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  notice: { flexDirection: "row", alignItems: "center", gap: 8, padding: 14 },
  noticeText: { padding: 14, color: colors.foregroundMuted },
  meta: { color: colors.foregroundMuted, fontSize: 12 },
  list: { paddingHorizontal: 14, paddingBottom: 14 },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  rowLine: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 },
  name: { flex: 1, minWidth: 0, fontSize: 14, color: colors.foreground },
  badge: {
    width: 78,
    alignItems: "center",
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: colors.surface2,
  },
  badgeText: { fontSize: 11, fontWeight: "600", color: colors.foregroundMuted },
  summary: {
    width: "48%",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
  },
  summaryCompact: { width: "100%", paddingTop: 0, paddingBottom: 7 },
  phaseName: { maxWidth: "100%", color: colors.foregroundMuted, fontSize: 12 },
  track: { maxWidth: "100%", flexDirection: "row", flexWrap: "wrap", gap: 3 },
  segment: {
    width: 10,
    height: 8,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  check: { color: colors.statusSuccess, fontSize: 8, lineHeight: 8 },
});
