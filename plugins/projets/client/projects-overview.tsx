import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginProjectSummary } from "@getpaseo/plugin/client";
import { Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from "react-native";
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
  compact,
  close,
}: {
  hostId: string;
  projects: readonly PluginProjectSummary[];
  loadingProjects: boolean;
  compact: boolean;
  close(): void;
}) {
  const closeButton = useRef<View>(null);
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
  const phasesByProject = useMemo(
    () => new Map(overview.data?.map(({ projectKey, phases }) => [projectKey, phases])),
    [overview.data],
  );

  useEffect(() => {
    if (compact) return;
    const frame = requestAnimationFrame(() => focusOverviewControl(closeButton.current));
    return () => cancelAnimationFrame(frame);
  }, [compact]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    },
    [close],
  );
  const webProps = Platform.OS === "web" ? { onKeyDown: handleKeyDown } : undefined;
  const isLoading = loadingProjects || overview.isLoading;
  const content = (
    <View style={styles.body} testID="projets-overview">
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
            <OverviewRow key={viewKey} name={projectName} phases={phasesByProject.get(viewKey)} />
          ))}
        </ScrollView>
      ) : null}
      {!projects.length && !isLoading ? (
        <Text style={styles.noticeText}>Aucun projet actif</Text>
      ) : null}
    </View>
  );

  if (compact) {
    return (
      <Modal title="Aperçu des projets" open onOpenChange={close}>
        <Modal.Content
          scrollable={false}
          style={styles.sheet}
          contentContainerStyle={styles.sheetContent}
        >
          {content}
        </Modal.Content>
      </Modal>
    );
  }

  return (
    <View style={styles.panel} testID="projets-overview-dock" {...webProps}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.heading}>
          Aperçu des projets
        </Text>
        <View>
          <ProjectButton ref={closeButton} onPress={close}>
            Fermer
          </ProjectButton>
        </View>
      </View>
      {content}
    </View>
  );
}

function OverviewRow({ name, phases }: { name: string; phases?: readonly OverviewPhase[] }) {
  const current = phases && currentProjectPhase(phases);
  const status = current?.status;
  const emptyLabel = phases?.every((phase) => phase.total === 0) ? "Sans tâche" : "—";
  const label = status ? phaseLabels[status] : emptyLabel;
  const badgeStyle = StyleSheet.compose(styles.badge, status && statusBackgrounds[status]);
  const badgeTextStyle = StyleSheet.compose(styles.badgeText, status && statusColors[status]);
  const summary =
    current && phases && phases.length > 1 ? (
      <View style={styles.summary}>
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
        <View style={badgeStyle}>
          <Text style={badgeTextStyle}>{label}</Text>
        </View>
      </View>
      {summary}
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
  body: { flex: 1, minHeight: 0 },
  sheet: { backgroundColor: colors.surface1 },
  sheetContent: { padding: 0, gap: 0 },
  panel: {
    width: 388,
    maxWidth: "45%",
    minHeight: 0,
    backgroundColor: colors.surface1,
    borderRightWidth: 1,
    borderColor: colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 42,
    paddingHorizontal: 14,
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
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    paddingBottom: 7,
  },
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
