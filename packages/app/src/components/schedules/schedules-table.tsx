import { ChevronRight } from "lucide-react-native";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import {
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ScheduleRow, type ScheduleRowPending } from "@/components/schedules/schedule-row";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { isWeb } from "@/constants/platform";
import { useScheduleMutations } from "@/hooks/use-schedule-mutations";
import type { AggregatedSchedule } from "@/hooks/use-schedules";
import {
  placeScheduleSections,
  scheduleColumnCount,
  type ScheduleGroup,
  type ScheduleRowView,
} from "@/schedules/schedule-list";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { resolveScheduleTitle, scheduleProductName } from "@/utils/schedule-format";

const GAP = 8;
const ThemedChevron = withUnistyles(ChevronRight);

interface SchedulesTableProps {
  groups: ScheduleGroup[];
  collapsed: ReadonlySet<string>;
  onToggleGroup: (id: string) => void;
  onEditSchedule: (schedule: AggregatedSchedule) => void;
}

interface SectionSize {
  width: number;
  height: number;
}

export function SchedulesTable({
  groups,
  collapsed,
  onToggleGroup,
  onEditSchedule,
}: SchedulesTableProps): ReactElement {
  const [width, setWidth] = useState(0);
  const [sizes, setSizes] = useState<ReadonlyMap<string, SectionSize>>(() => new Map());
  const columns = scheduleColumnCount(width, groups.length);
  const columnWidth = (width - (columns - 1) * GAP) / columns;
  const heights = groups.map(({ id }) => {
    const size = sizes.get(id);
    return size && Math.abs(size.width - columnWidth) < 1 ? size.height : 0;
  });
  // Keep the same mounted cards and rows as they move between columns. Measure
  // them in flow before positioning at a new width so cards never overlap.
  const placement =
    columns > 1 && heights.every((height) => height > 0)
      ? placeScheduleSections(heights, columns, GAP)
      : null;

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  const measure = useCallback((id: string, { width: nextWidth, height }: SectionSize) => {
    setSizes((current) => {
      const previous = current.get(id);
      if (previous?.width === nextWidth && previous.height === height) return current;
      return new Map(current).set(id, { width: nextWidth, height });
    });
  }, []);

  return (
    <View style={styles.listContent} testID="schedules-table">
      <View
        onLayout={handleLayout}
        style={[
          styles.grid,
          groups.length === 1 && styles.single,
          placement && { height: placement.height },
        ]}
      >
        {groups.map((group, index) => {
          const position = placement?.positions[index];
          return (
            <ScheduleProjectCard
              key={group.id}
              group={group}
              expanded={!collapsed.has(group.id)}
              width={columns > 1 ? columnWidth : undefined}
              left={position && position.column * (columnWidth + GAP)}
              top={position?.top}
              onMeasure={measure}
              onToggle={onToggleGroup}
              onEditSchedule={onEditSchedule}
            />
          );
        })}
      </View>
    </View>
  );
}

function ScheduleProjectCard({
  group,
  expanded,
  width,
  left,
  top,
  onMeasure,
  onToggle,
  onEditSchedule,
}: {
  group: ScheduleGroup;
  expanded: boolean;
  width?: number;
  left?: number;
  top?: number;
  onMeasure: (id: string, size: SectionSize) => void;
  onToggle: (id: string) => void;
  onEditSchedule: (schedule: AggregatedSchedule) => void;
}): ReactElement {
  const { id } = group;
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onMeasure(id, event.nativeEvent.layout),
    [id, onMeasure],
  );
  const toggle = useCallback(() => onToggle(id), [id, onToggle]);
  const position: ViewStyle =
    top === undefined ? { width } : { width, position: "absolute", start: left, top };
  return (
    <View
      testID="schedule-project-group"
      style={[settingsStyles.card, position]}
      onLayout={handleLayout}
    >
      <Pressable
        {...(isWeb ? { "aria-expanded": expanded } : {})}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        onPress={toggle}
        style={groupHeaderStyle}
        testID="schedule-project-toggle"
      >
        <View style={expanded && styles.chevronExpanded}>
          <ThemedChevron size={14} uniProps={mutedIconColorMapping} />
        </View>
        <Text numberOfLines={1} style={styles.groupTitle}>
          {group.label}
        </Text>
        <Text style={styles.groupCount}>{group.rows.length}</Text>
      </Pressable>
      {expanded &&
        group.rows.map((row) => (
          <SchedulesTableRow
            key={`${row.schedule.serverId}:${row.schedule.id}`}
            row={row}
            onEditSchedule={onEditSchedule}
          />
        ))}
    </View>
  );
}

function groupHeaderStyle({
  pressed,
  hovered,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.groupHeader, hovered && styles.groupHovered, pressed && styles.groupPressed];
}

// ---------------------------------------------------------------------------
// Per-row wrapper owns local in-flight state and binds mutations to this
// schedule's host. Local state keeps pending precise to the acting row even
// when several rows are acted on at once (the mutations hook exposes only a
// single global pending flag per action).
// ---------------------------------------------------------------------------

const NO_PENDING: ScheduleRowPending = {};

function SchedulesTableRow({
  row,
  onEditSchedule,
}: {
  row: ScheduleRowView;
  onEditSchedule: (schedule: AggregatedSchedule) => void;
}): ReactElement {
  const { schedule } = row;
  const { id, serverId } = schedule;
  const mutations = useScheduleMutations({ serverId });
  const [pending, setPending] = useState<ScheduleRowPending>(NO_PENDING);

  const runAction = useCallback(
    async (key: keyof ScheduleRowPending, action: () => Promise<void>): Promise<void> => {
      setPending((current) => ({ ...current, [key]: true }));
      try {
        await action();
      } catch {
        // Mutations roll back their own optimistic cache writes on error and
        // re-fetch on settle; surfacing per-row toasts here is out of scope.
      } finally {
        setPending((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    },
    [],
  );

  const handleEdit = useCallback(() => {
    onEditSchedule(schedule);
  }, [onEditSchedule, schedule]);

  const handlePause = useCallback(() => {
    void runAction("pause", () => mutations.pauseSchedule(id));
  }, [runAction, mutations, id]);

  const handleResume = useCallback(() => {
    void runAction("resume", () => mutations.resumeSchedule(id));
  }, [runAction, mutations, id]);

  const handleRunNow = useCallback(() => {
    void runAction("runNow", () => mutations.runScheduleNow(id));
  }, [runAction, mutations, id]);

  const handleDelete = useCallback(() => {
    void (async () => {
      const productName = scheduleProductName(schedule);
      const confirmed = await confirmDialog({
        title: `Delete ${productName.toLowerCase()}`,
        message: `Delete "${resolveScheduleTitle(schedule)}"? This cannot be undone.`,
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      await runAction("delete", () => mutations.deleteSchedule(id));
    })();
  }, [runAction, mutations, id, schedule]);

  return (
    <ScheduleRow
      serverId={row.schedule.serverId}
      schedule={schedule}
      targetLabel={row.targetLabel}
      provider={row.provider}
      state={row.state}
      serverName={row.showHost ? schedule.serverName : undefined}
      showTarget={!row.project || schedule.target.type === "agent"}
      pending={pending}
      onEdit={handleEdit}
      onPause={handlePause}
      onResume={handleResume}
      onRunNow={handleRunNow}
      onDelete={handleDelete}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  listContent: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  grid: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 860,
    gap: GAP,
  },
  single: {
    maxWidth: 440,
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minHeight: 36,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    backgroundColor: theme.colors.surface2,
  },
  groupHovered: { backgroundColor: theme.colors.surface3 },
  groupPressed: {
    backgroundColor: theme.colors.surface3,
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  groupTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  groupCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
