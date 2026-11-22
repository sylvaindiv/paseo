import {
  useProjects,
  type PluginLocalStorage,
  type PluginProjectSummary,
  type PluginScreenProps,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { ProjectsWindow, ProjectsWindowButton } from "./projects-window.js";
import { useBoardPan } from "./board-pan.js";
import { ProjectButton } from "./project-button.js";
import { ProjectMenu } from "./project-menu.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { ProjectDragRow, SortableProject } from "./project-drag.js";
import { SortableTitleBar, SortableTitleStyles, titleActionWebProps } from "./sortable-controls.js";
import { ProjectTasks } from "./project-tasks.js";
import { focusOverviewControl, ProjectsOverview } from "./projects-overview.js";
import type { AgentDestination } from "./project-dispatch.js";
import type { createBatchTracking } from "./batch-tracking.js";
import {
  createProjectPreferences,
  mergeProjectOrder,
  moveProject,
  type ProjectPreferences,
} from "./preferences.js";
import { projectColors, projectStyles, type ProjectStyles } from "./styles.js";

type ProjectHost = PluginProjectSummary["hosts"][number];
type WorkspaceSource = ProjectHost["workspaces"][number] &
  Pick<ProjectHost, "serverId" | "serverName" | "isOnline">;

function projectSources(project: PluginProjectSummary): WorkspaceSource[] {
  return project.hosts.flatMap(({ serverId, serverName, isOnline, workspaces }) =>
    workspaces
      .filter((workspace) => !workspace.archivingAt)
      .map(({ id, name }) => ({ id, name, serverId, serverName, isOnline })),
  );
}

export function createProjectsScreen(
  storage: PluginLocalStorage,
  tracking: ReturnType<typeof createBatchTracking>,
) {
  const preferences = createProjectPreferences(storage);

  return function ProjectsScreen(props: PluginScreenProps) {
    if (!props.isFocused) return null;
    const board = <ProjectsContent {...props} preferences={preferences} tracking={tracking} />;
    return props.layout.platform === "web" && props.params.fenetre === "projets" ? (
      <ProjectsWindow>{board}</ProjectsWindow>
    ) : (
      board
    );
  };
}

function ProjectsContent({
  theme,
  host,
  layout,
  params,
  navigation,
  preferences,
  tracking,
}: PluginScreenProps & {
  preferences: ReturnType<typeof createProjectPreferences>;
  tracking: ReturnType<typeof createBatchTracking>;
}) {
  const styles = projectStyles;
  const { projects, isLoading, hostErrors } = useProjects();
  const [width, setWidth] = useState(0);
  const measure = useCallback(
    (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width),
    [],
  );
  const cards = useMemo(
    () => projects.map((project) => ({ project, sources: projectSources(project) })),
    [projects],
  );
  const byKey = useMemo(() => new Map(cards.map((card) => [card.project.viewKey, card])), [cards]);
  const keys = useMemo(() => [...byKey.keys()], [byKey]);
  const [saved, setSaved] = useState<ProjectPreferences | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const overviewButton = useRef<View>(null);
  const closeOverview = useCallback(() => {
    setOverviewOpen(false);
    requestAnimationFrame(() => focusOverviewControl(overviewButton.current));
  }, []);
  const toggleOverview = useCallback(() => {
    if (overviewOpen) closeOverview();
    else setOverviewOpen(true);
  }, [closeOverview, overviewOpen]);
  const [showFinished, setShowFinished] = useState(false);
  const toggleFinished = useCallback(() => setShowFinished((open) => !open), []);
  const [retrySave, setRetrySave] = useState<(() => void) | null>(null);
  const inFlight = useRef(false);
  const activeRow = useRef<ScrollView>(null);
  const boardPan = useBoardPan();

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const value = await preferences.load();
        if (mounted) setSaved(value);
      } catch {
        if (mounted) setLoadFailed(true);
      }
    }
    void load();
    return () => {
      mounted = false;
    };
  }, [loadAttempt, preferences]);

  const retryLoad = useCallback(() => {
    setLoadFailed(false);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const save = useCallback(
    async function savePreferences(update: (current: ProjectPreferences) => ProjectPreferences) {
      if (inFlight.current) return;
      inFlight.current = true;
      setSaving(true);
      setRetrySave(null);
      try {
        setSaved(await preferences.save(update));
      } catch {
        setRetrySave(() => () => void savePreferences(update));
      } finally {
        inFlight.current = false;
        setSaving(false);
      }
    },
    [preferences],
  );

  useEffect(() => {
    if (
      !saved ||
      isLoading ||
      saving ||
      retrySave ||
      keys.every((key) => saved.order.includes(key))
    ) {
      return;
    }
    void save((current) => ({ ...current, order: mergeProjectOrder(current.order, keys) }));
  }, [isLoading, keys, retrySave, save, saved, saving]);

  const orderedKeys = useMemo(
    () => mergeProjectOrder(saved?.order ?? [], keys).filter((key) => byKey.has(key)),
    [byKey, keys, saved?.order],
  );
  const activeKeys = useMemo(
    () => orderedKeys.filter((key) => !saved?.finished.includes(key)),
    [orderedKeys, saved?.finished],
  );
  const activeProjects = useMemo(
    () => activeKeys.map((key) => byKey.get(key)!.project),
    [activeKeys, byKey],
  );
  const finishedKeys = orderedKeys.filter((key) => saved?.finished.includes(key));
  const reorder = useCallback(
    (from: string, to: string) => {
      void save((current) => ({
        ...current,
        order: moveProject(
          current.order,
          keys.filter((key) => !current.finished.includes(key)),
          from,
          to,
        ),
      }));
    },
    [keys, save],
  );
  const firstActiveKey = activeKeys[0];
  const setFinished = useCallback(
    (key: string, finished: boolean) => {
      if (finished && firstActiveKey === key)
        activeRow.current?.scrollTo({ x: 0, animated: false });
      void save((current) => ({
        ...current,
        finished: finished
          ? [...new Set([...current.finished, key])]
          : current.finished.filter((id) => id !== key),
      }));
    },
    [firstActiveKey, save],
  );
  const controlsDisabled = saved === null || saving;
  const columns = 1 + Number(width >= 700) + Number(width >= 1120 && activeKeys.length >= 3);
  const cardWidth = Math.max(0, Math.min(540, (width - 32 - 12 * (columns - 1)) / columns));

  const renderCard = (key: string, index?: number) => {
    const { project, sources } = byKey.get(key)!;
    return (
      <ProjectCard
        key={key}
        projectKey={key}
        name={project.projectName}
        sources={sources}
        hosts={project.hosts}
        width={cardWidth}
        finished={index === undefined}
        disabled={controlsDisabled}
        theme={theme}
        styles={styles}
        hostId={host.id}
        navigation={navigation}
        legacySelection={saved?.next[key]}
        tracking={tracking}
        setFinished={setFinished}
        move={reorder}
        leftKey={index === undefined ? undefined : activeKeys[index - 1]}
        rightKey={index === undefined ? undefined : activeKeys[index + 1]}
      />
    );
  };

  return (
    <View style={styles.boardLayout} testID="projets-page">
      {overviewOpen ? (
        <ProjectsOverview
          hostId={host.id}
          projects={activeProjects}
          loadingProjects={isLoading}
          compact={layout.compact}
          close={closeOverview}
        />
      ) : null}
      <View ref={boardPan} style={styles.page} testID="projets-board">
        <SortableTitleStyles />
        {loadFailed || retrySave || hostErrors.length > 0 ? (
          <View style={styles.notice}>
            {loadFailed ? (
              <>
                <Text style={styles.message} accessibilityRole="alert">
                  Préférences indisponibles
                </Text>
                <ProjectButton onPress={retryLoad}>Réessayer</ProjectButton>
              </>
            ) : null}
            {retrySave ? (
              <>
                <Text style={styles.message} accessibilityRole="alert">
                  Préférences non enregistrées
                </Text>
                <ProjectButton onPress={retrySave}>Réessayer</ProjectButton>
              </>
            ) : null}
            {hostErrors.length > 0 ? (
              <Text style={styles.message} accessibilityRole="alert">
                Certains projets sont indisponibles
              </Text>
            ) : null}
          </View>
        ) : null}
        <ScrollView
          style={styles.page}
          contentContainerStyle={styles.boardContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.boardHeading} onLayout={measure}>
            <View style={styles.boardHeadingGroup}>
              <Text style={styles.heading}>À avancer</Text>
              <ProjectButton
                ref={overviewButton}
                disabled={controlsDisabled}
                expanded={overviewOpen}
                onPress={toggleOverview}
              >
                Aperçu
              </ProjectButton>
              <ProjectsWindowButton hostId={host.id} detached={params.fenetre === "projets"} />
            </View>
            {finishedKeys.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                aria-expanded={showFinished}
                onPress={toggleFinished}
                style={styles.finishedToggle}
              >
                <Icon
                  name={showFinished ? "ChevronDown" : "ChevronRight"}
                  size={14}
                  color={projectColors.foregroundMuted}
                />
                <Text style={styles.message}>Terminés · {finishedKeys.length}</Text>
              </Pressable>
            ) : null}
          </View>
          {activeKeys.length === 0 ? (
            <View style={styles.notice}>
              {isLoading || hostErrors.length === 0 ? (
                <Text style={styles.message}>
                  {isLoading ? "Chargement…" : "Aucun projet actif"}
                </Text>
              ) : null}
            </View>
          ) : (
            <ProjectDragRow keys={activeKeys} move={reorder}>
              <ScrollView
                ref={activeRow}
                style={styles.scrollRow}
                horizontal
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.columns}
                testID="projets-cards"
              >
                {activeKeys.map((key, index) => (
                  <SortableProject
                    key={key}
                    id={key}
                    disabled={controlsDisabled || activeKeys.length < 2}
                  >
                    {renderCard(key, index)}
                  </SortableProject>
                ))}
              </ScrollView>
            </ProjectDragRow>
          )}
          {showFinished && finishedKeys.length > 0 ? (
            <ScrollView
              horizontal
              style={styles.scrollRow}
              contentContainerStyle={styles.columns}
              testID="projets-finished"
            >
              {finishedKeys.map((key) => renderCard(key))}
            </ScrollView>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

function ProjectCard({
  projectKey,
  name,
  sources,
  hosts,
  width,
  finished,
  disabled,
  theme,
  styles,
  hostId,
  navigation,
  legacySelection,
  setFinished,
  move,
  leftKey,
  rightKey,
  tracking,
}: {
  projectKey: string;
  name: string;
  sources: WorkspaceSource[];
  hosts: PluginProjectSummary["hosts"];
  width: number;
  finished: boolean;
  disabled: boolean;
  theme: PluginScreenProps["theme"];
  styles: ProjectStyles;
  hostId: string;
  navigation?: PluginScreenProps["navigation"];
  legacySelection?: string[];
  setFinished(key: string, finished: boolean): void;
  move(from: string, to: string): void;
  leftKey?: string;
  rightKey?: string;
  tracking: ReturnType<typeof createBatchTracking>;
}) {
  const { foregroundMuted } = projectColors;
  const [collapsed, setCollapsed] = useState(finished);
  const [menu, setMenu] = useState<{ anchor?: HTMLElement } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const cardStyle = useMemo(() => [styles.card, { width }], [styles, width]);
  const titleState = useMemo(() => ({ expanded: !collapsed, disabled }), [collapsed, disabled]);
  const [addingPhase, setAddingPhase] = useState(false);
  const closeAddPhase = useCallback(() => setAddingPhase(false), []);
  const toggle = useCallback(() => {
    closeAddPhase();
    setCollapsed(!collapsed);
  }, [closeAddPhase, collapsed]);
  const toggleAddPhase = useCallback(() => {
    setAddingPhase((adding) => collapsed || !adding);
    if (collapsed) setCollapsed(false);
  }, [collapsed]);
  const openMenu = useCallback((event: GestureResponderEvent) => {
    setMenu({
      anchor: Platform.OS === "web" ? (event.currentTarget as unknown as HTMLElement) : undefined,
    });
  }, []);
  const openSettings = navigation?.openProjectSettings;
  const menuItems = useMemo(
    () => [
      ...(leftKey
        ? [
            {
              icon: "ArrowLeft",
              label: "Déplacer à gauche",
              onPress: () => {
                closeMenu();
                move(projectKey, leftKey);
              },
            },
          ]
        : []),
      ...(rightKey
        ? [
            {
              icon: "ArrowRight",
              label: "Déplacer à droite",
              onPress: () => {
                closeMenu();
                move(projectKey, rightKey);
              },
            },
          ]
        : []),
      ...(openSettings
        ? hosts.map(({ serverId, serverName, projectId }) => ({
            id: serverId,
            icon: "SlidersHorizontal",
            label: hosts.length === 1 ? "Réglages du projet" : "Réglages · " + serverName,
            onPress: () => {
              closeMenu();
              openSettings({ projectId, serverId });
            },
          }))
        : []),
      {
        icon: finished ? "RotateCcw" : "Check",
        label: finished ? "Rouvrir" : "Terminer le projet",
        onPress: () => {
          closeMenu();
          setFinished(projectKey, !finished);
        },
      },
    ],
    [closeMenu, finished, hosts, leftKey, move, openSettings, projectKey, rightKey, setFinished],
  );
  const destinations = useMemo<AgentDestination[]>(
    () => sources.filter((source) => source.isOnline),
    [sources],
  );
  return (
    <View style={cardStyle} testID={finished ? "projets-finished-card" : "projets-card"}>
      <SortableTitleBar label={"Déplacer le projet " + name}>
        <View style={styles.header} testID="projets-card-header">
          <Pressable
            style={styles.titleButton}
            accessibilityRole="button"
            accessibilityLabel={name}
            accessibilityState={titleState}
            aria-expanded={!collapsed}
            onPress={toggle}
            disabled={disabled}
          >
            <Icon
              name={collapsed ? "ChevronRight" : "ChevronDown"}
              size={15}
              color={foregroundMuted}
            />
            <Text style={styles.title} numberOfLines={2}>
              {name}
            </Text>
          </Pressable>
          <Pressable
            {...titleActionWebProps}
            accessibilityRole="button"
            accessibilityLabel={"Ajouter une phase à " + name}
            aria-expanded={addingPhase && !collapsed}
            disabled={disabled}
            onPress={toggleAddPhase}
            style={styles.taskAction}
          >
            <Icon name="Plus" size={16} color={foregroundMuted} />
          </Pressable>
          <Pressable
            {...titleActionWebProps}
            accessibilityRole="button"
            accessibilityLabel={"Actions de " + name}
            disabled={disabled}
            style={styles.taskAction}
            onPress={openMenu}
          >
            <Icon name="MoreHorizontal" size={16} color={foregroundMuted} />
          </Pressable>
        </View>
      </SortableTitleBar>
      {!collapsed ? (
        <ProjectTasks
          name={name}
          addingPhase={addingPhase}
          closeAddPhase={closeAddPhase}
          hostId={hostId}
          projectKey={projectKey}
          legacySelection={legacySelection}
          tracking={tracking}
          destinations={destinations}
          navigation={navigation}
          disabled={disabled}
          theme={theme}
          styles={styles}
        />
      ) : null}
      {menu ? (
        <ProjectMenu
          anchor={menu.anchor}
          title={name}
          label={"Actions de " + name}
          pending={disabled}
          colors={projectColors}
          styles={styles}
          close={closeMenu}
          items={menuItems}
        />
      ) : null}
    </View>
  );
}
