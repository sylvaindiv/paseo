import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { CalendarClock, ChevronDown, Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { ExternalLink } from "@/components/ui/external-link";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { ScheduleFormSheet } from "@/components/schedules/schedule-form-sheet";
import { SchedulesTable } from "@/components/schedules/schedules-table";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { createControlGeometry } from "@/components/ui/control-geometry";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import {
  useSchedules,
  type AggregateLoadState,
  type AggregatedSchedule,
  type ScheduleHostError,
} from "@/hooks/use-schedules";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { resolveSchedule } from "@/schedules/schedule-derivation";
import {
  ALL_SCHEDULE_PROJECTS,
  buildScheduleGroups,
  listScheduleProjects,
  SCHEDULES_MAX_WIDTH,
  type ScheduleGroup,
  type ScheduleRowView,
  type ScheduleSort,
  type ScheduleStatusFilter,
} from "@/schedules/schedule-list";
import { resolveSchedulesScreenBodyState } from "./schedules-screen-state";
import {
  buildProjectNameByCwd,
  buildScheduleProjectLookup,
  buildScheduleProjectTargets,
  resolveScheduleProject,
} from "@/schedules/schedule-project-targets";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";

type FormState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; serverId: string; schedule: ScheduleSummary };

const ThemedChevronDown = withUnistyles(ChevronDown);

interface ScheduleMenuOption<T extends string> {
  id: T;
  label: string;
  testID?: string;
}

const EMPTY_SCHEDULES: AggregatedSchedule[] = [];

export function SchedulesScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <SchedulesScreenContent />;
}

function SchedulesScreenContent(): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const { loadState, hostErrors, isError, refetch } = useSchedules();
  const schedules = loadState.status === "loaded" ? loadState.data : EMPTY_SCHEDULES;
  const { agents } = useAggregatedAgents({ includeArchived: true });
  const { projects } = useProjects();
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );

  // Per-host agent-directory readiness from the runtime, not the aggregate agent
  // flag: the aggregate `isInitialLoad` flips false as soon as *any* host has
  // agents, so a still-loading host would falsely mark its agent-target
  // schedules "gone". `hasEverLoadedAgentDirectory` is true only once that
  // host's directory has loaded at least once.
  const agentDirReadyHosts = useMemo(() => {
    void runtimeVersion;
    const ready = new Set<string>();
    for (const host of hosts) {
      if (runtime.getSnapshot(host.serverId)?.hasEverLoadedAgentDirectory) {
        ready.add(host.serverId);
      }
    }
    return ready;
  }, [hosts, runtime, runtimeVersion]);

  const [form, setForm] = useState<FormState>({ mode: "closed" });
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  const [statusFilter, setStatusFilter] = useState<ScheduleStatusFilter>("all");
  const [selectedProject, setSelectedProject] = useState<ScheduleMenuOption<string> | null>(null);
  const [sort, setSort] = useState<ScheduleSort>("next");
  const [collapsed, setCollapsed] = useState(() => new Set<string>());
  const toggleGroup = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const resetFilters = useCallback(() => {
    setSelectedHost(ALL_HOSTS_OPTION_ID);
    setStatusFilter("all");
    setSelectedProject(null);
  }, []);

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);

  const openCreate = useCallback(() => setForm({ mode: "create" }), []);
  const openEdit = useCallback((schedule: AggregatedSchedule) => {
    setForm({ mode: "edit", serverId: schedule.serverId, schedule });
  }, []);
  const closeForm = useCallback(() => setForm({ mode: "closed" }), []);

  const agentsByKey = useMemo(
    () => new Map(agents.map((agent) => [`${agent.serverId}:${agent.id}`, agent])),
    [agents],
  );
  const projectLookup = useMemo(() => buildScheduleProjectLookup(projects), [projects]);
  const projectNameByCwd = useMemo(
    () => buildProjectNameByCwd(buildScheduleProjectTargets(projects)),
    [projects],
  );

  const showHost = hosts.length > 1 && selectedHost === ALL_HOSTS_OPTION_ID;
  const rows = useMemo<ScheduleRowView[]>(() => {
    const now = Date.now();
    return schedules.map((schedule) => {
      const { serverId, target } = schedule;
      const resolved = resolveSchedule({
        schedule,
        serverId,
        now,
        agentsByKey,
        projectNameByCwd,
        agentDataLoaded: agentDirReadyHosts.has(serverId),
      });
      const agent =
        target.type === "agent" ? agentsByKey.get(`${serverId}:${target.agentId}`) : undefined;
      return {
        schedule,
        project: resolveScheduleProject(
          projectLookup,
          serverId,
          target,
          agent && {
            workspaceId: agent.workspaceId,
            cwd: agent.cwd,
            projectRoot: agent.projectPlacement?.checkout.mainRepoRoot,
          },
        ),
        targetLabel: resolved.target.label,
        provider: resolved.target.provider,
        state: resolved.state,
        showHost,
      };
    });
  }, [schedules, agentsByKey, projectNameByCwd, projectLookup, agentDirReadyHosts, showHost]);

  const projectId = selectedProject?.id ?? ALL_SCHEDULE_PROJECTS;
  const unassignedLabel = t("schedules.unassigned");
  const groups = useMemo(
    () =>
      buildScheduleGroups(rows, {
        host: selectedHost === ALL_HOSTS_OPTION_ID ? null : selectedHost,
        status: statusFilter,
        project: projectId,
        sort,
        locale,
        unassignedLabel,
      }),
    [rows, selectedHost, statusFilter, projectId, sort, locale, unassignedLabel],
  );
  const projectOptions = useMemo(
    () => listScheduleProjects(rows, locale, unassignedLabel),
    [rows, locale, unassignedLabel],
  );
  const statusOptions: ScheduleMenuOption<ScheduleStatusFilter>[] = [
    { id: "all", label: t("schedules.allStatuses") },
    { id: "active", label: t("schedules.active"), testID: "schedules-filter-active" },
    { id: "paused", label: t("schedules.paused"), testID: "schedules-filter-paused" },
    { id: "ended", label: t("schedules.ended"), testID: "schedules-filter-ended" },
  ];
  const sortOptions: ScheduleMenuOption<ScheduleSort>[] = [
    { id: "next", label: t("schedules.nextRun") },
    { id: "name", label: t("schedules.nameOrder") },
    { id: "recent", label: t("schedules.recent") },
  ];
  const projectMenuOptions = [
    { id: ALL_SCHEDULE_PROJECTS, label: t("schedules.allProjects") },
    ...projectOptions,
  ];
  if (selectedProject && !projectOptions.some((option) => option.id === projectId)) {
    projectMenuOptions.push(selectedProject);
  }
  const onProjectSelect = useCallback((option: ScheduleMenuOption<string>) => {
    setSelectedProject(option.id === ALL_SCHEDULE_PROJECTS ? null : option);
  }, []);
  const onStatusSelect = useCallback((option: ScheduleMenuOption<ScheduleStatusFilter>) => {
    setStatusFilter(option.id);
  }, []);
  const onSortSelect = useCallback((option: ScheduleMenuOption<ScheduleSort>) => {
    setSort(option.id);
  }, []);

  const showLoadError = isError && loadState.status !== "loaded";
  const showHostFilter = hosts.length > 1;

  return (
    <View style={styles.container}>
      <MenuHeader title={t("sidebar.sections.schedules")} />
      <SchedulesScreenBody
        groups={groups}
        collapsed={collapsed}
        onToggleGroup={toggleGroup}
        onResetFilters={resetFilters}
        listControls={
          <>
            <SchedulesMenu
              title={t("schedules.projectFilter")}
              testID="schedules-project-filter"
              options={projectMenuOptions}
              optionTestID="schedules-project-option"
              value={projectId}
              onSelect={onProjectSelect}
            />
            <SchedulesMenu
              title={t("schedules.statusFilter")}
              testID="schedules-status-filter"
              options={statusOptions}
              value={statusFilter}
              onSelect={onStatusSelect}
            />
            <SchedulesMenu
              title={t("schedules.sort")}
              testID="schedules-sort"
              options={sortOptions}
              value={sort}
              onSelect={onSortSelect}
            />
          </>
        }
        loadState={loadState}
        hostErrors={hostErrors}
        showLoadError={showLoadError}
        showHostFilter={showHostFilter}
        hosts={hosts}
        selectedHost={selectedHost}
        onSelectHost={setSelectedHost}
        onRetry={refetch}
        onCreate={openCreate}
        onEdit={openEdit}
      />
      <ScheduleFormSheet
        serverId={form.mode === "edit" ? form.serverId : undefined}
        visible={form.mode === "create" || form.mode === "edit"}
        onClose={closeForm}
        mode={form.mode === "edit" ? "edit" : "create"}
        schedule={form.mode === "edit" ? form.schedule : undefined}
      />
    </View>
  );
}

function SchedulesScreenBody({
  groups,
  collapsed,
  onToggleGroup,
  onResetFilters,
  listControls,
  loadState,
  hostErrors,
  showLoadError,
  showHostFilter,
  hosts,
  selectedHost,
  onSelectHost,
  onRetry,
  onCreate,
  onEdit,
}: {
  groups: ScheduleGroup[];
  collapsed: ReadonlySet<string>;
  onToggleGroup: (id: string) => void;
  onResetFilters: () => void;
  listControls: ReactElement;
  loadState: AggregateLoadState<AggregatedSchedule>;
  hostErrors: ScheduleHostError[];
  showLoadError: boolean;
  showHostFilter: boolean;
  hosts: ReturnType<typeof useHosts>;
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
  onRetry: () => void;
  onCreate: () => void;
  onEdit: (schedule: AggregatedSchedule) => void;
}): ReactElement {
  const { t } = useTranslation();
  const bodyState = resolveSchedulesScreenBodyState({ loadState, showLoadError });

  if (bodyState.kind === "loading") {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  if (bodyState.kind === "load-error") {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>Unable to load schedules</Text>
        <Button variant="ghost" onPress={onRetry} testID="schedules-retry">
          Try again
        </Button>
      </View>
    );
  }

  if (bodyState.kind === "empty") {
    return (
      <View style={styles.centered}>
        {hostErrors.length > 0 ? <ScheduleHostErrorsBanner errors={hostErrors} /> : null}
        <SchedulesEmptyState onCreate={onCreate} testID="schedules-empty" />
      </View>
    );
  }

  return (
    <View style={styles.body}>
      <View style={styles.filterRow}>
        {showHostFilter ? (
          <HostFilter
            hosts={hosts}
            selectedHost={selectedHost}
            onSelectHost={onSelectHost}
            triggerTestID="schedules-host-filter-trigger"
          />
        ) : null}
        {listControls}
        <Button
          variant="outline"
          leftIcon={Plus}
          onPress={onCreate}
          size="sm"
          style={styles.newButton}
          testID="schedules-new"
        >
          New schedule
        </Button>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        testID="schedules-list"
      >
        {hostErrors.length > 0 ? <ScheduleHostErrorsBanner errors={hostErrors} /> : null}
        {groups.length ? (
          <SchedulesTable
            groups={groups}
            collapsed={collapsed}
            onToggleGroup={onToggleGroup}
            onEditSchedule={onEdit}
          />
        ) : (
          <View style={styles.filterEmpty} testID="schedules-filter-empty">
            <Text style={styles.emptyTitle}>{t("schedules.noResults")}</Text>
            <Button
              size="sm"
              variant="ghost"
              onPress={onResetFilters}
              testID="schedules-filter-reset"
            >
              {t("schedules.reset")}
            </Button>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function SchedulesEmptyState({
  onCreate,
  testID,
}: {
  onCreate: () => void;
  testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyState} testID={testID}>
      <CalendarClock size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
      <View style={styles.emptyTextStack}>
        <Text style={styles.emptyTitle}>{t("schedules.empty")}</Text>
        <Text style={styles.emptyDescription}>Schedules run agents on a cadence.</Text>
        <ExternalLink href="https://paseo.sh/docs/schedules" label="See docs" />
      </View>
      <Button variant="outline" leftIcon={Plus} onPress={onCreate} testID="schedules-empty-new">
        New schedule
      </Button>
    </View>
  );
}

function SchedulesMenu<T extends string>({
  title,
  testID,
  options,
  optionTestID,
  value,
  onSelect,
}: {
  title: string;
  testID: string;
  options: readonly ScheduleMenuOption<T>[];
  optionTestID?: string;
  value: T;
  onSelect: (option: ScheduleMenuOption<T>) => void;
}): ReactElement {
  const selectedLabel = options.find((option) => option.id === value)?.label ?? title;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${selectedLabel}`}
        testID={testID}
        style={filterTriggerStyle}
      >
        <Text style={styles.filterTriggerText} numberOfLines={1}>
          {selectedLabel}
        </Text>
        <ThemedChevronDown size={14} uniProps={mutedIconColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sheetTitle={title} scrollable>
        {options.map((option) => (
          <ScheduleMenuEntry
            key={option.id}
            option={option}
            selected={option.id === value}
            onSelect={onSelect}
            testID={option.testID ?? optionTestID}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ScheduleMenuEntry<T extends string>({
  option,
  selected,
  onSelect,
  testID,
}: {
  option: ScheduleMenuOption<T>;
  selected: boolean;
  onSelect: (option: ScheduleMenuOption<T>) => void;
  testID?: string;
}): ReactElement {
  const select = useCallback(() => onSelect(option), [onSelect, option]);
  return (
    <DropdownMenuItem selected={selected} showSelectedCheck onSelect={select} testID={testID}>
      {option.label}
    </DropdownMenuItem>
  );
}

function filterTriggerStyle({
  hovered,
  pressed,
  open,
}: {
  hovered: boolean;
  pressed: boolean;
  open: boolean;
}) {
  return [styles.filterTrigger, (hovered || pressed || open) && styles.filterTriggerActive];
}

function ScheduleHostErrorsBanner({ errors }: { errors: ScheduleHostError[] }): ReactElement {
  return (
    <View style={styles.errorsBannerWrap}>
      <View style={styles.errorsBanner} testID="schedules-host-errors">
        {errors.map((error) => (
          <Text key={error.serverId} style={styles.errorsBannerText}>
            {`${error.serverName}: Could not load schedules`}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  filterRow: {
    alignSelf: "center",
    width: "100%",
    maxWidth: SCHEDULES_MAX_WIDTH + 2 * theme.spacing[6],
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  newButton: {
    marginLeft: "auto",
  },
  filterTrigger: {
    ...createControlGeometry(theme).buttonSm,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    maxWidth: 220,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  filterTriggerActive: {
    backgroundColor: theme.colors.surface2,
  },
  filterTriggerText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    gap: theme.spacing[3],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  errorsBannerWrap: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  errorsBanner: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  filterEmpty: {
    flexGrow: 1,
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[6],
    alignItems: "center",
    justifyContent: "center",
  },
  emptyState: {
    alignItems: "center",
    gap: theme.spacing[4],
    maxWidth: 420,
    width: "100%",
  },
  emptyTextStack: {
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  // Static color holder read by the spinner; keeps the muted token without
  // useUnistyles (banned in new code).
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  emptyIcon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.lg,
  },
}));
