import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { PanResponder, Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  ChevronRight,
  GripVertical,
  ListTodo,
  MoreHorizontal,
  X,
} from "lucide-react-native";
import type {
  WorkspaceTodo,
  WorkspaceTodoMutation,
  WorkspaceTodos,
} from "@getpaseo/protocol/workspace-todos";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DraggableList } from "@/components/draggable-list";
import type { DraggableRenderItemInfo } from "@/components/draggable-list.types";
import { HEADER_INNER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { isWeb } from "@/constants/platform";
import { clampTodoPosition, type TodoPosition } from "./position";
import { useTodoViews } from "./view-store";

const ThemedListTodo = withUnistyles(ListTodo);
const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
const ThemedGripVertical = withUnistyles(GripVertical);
const ThemedCheck = withUnistyles(Check);
const todoIconColor = (theme: import("@/styles/theme").Theme) => ({
  color: theme.colors.foregroundMuted,
});
const TodoContext = createContext<{ open: boolean; toggle(): void } | null>(null);
export function WorkspaceTodosButton({ hideLabels = false }: { hideLabels?: boolean }) {
  const context = useContext(TodoContext);
  const { t } = useTranslation();
  const expandedState = useMemo(() => ({ expanded: context?.open ?? false }), [context?.open]);
  if (!context) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={ListTodo}
      onPress={context.toggle}
      accessibilityLabel={t("workspaceTodos.title")}
      accessibilityState={expandedState}
      testID="workspace-todos-toggle"
    >
      {hideLabels ? null : t("workspaceTodos.title")}
    </Button>
  );
}
interface EditDraft {
  title?: string;
  notes?: string;
  revision: number;
}
interface Drafts {
  title: string;
  notes: string;
  edits: Record<string, EditDraft>;
  failed?: WorkspaceTodoMutation;
  error?: string;
}
// Drafts survive hiding the panel and switching workspaces within this app session.
const draftsByWorkspace = new Map<string, Drafts>();
const EMPTY_DRAFT: Drafts = { title: "", notes: "", edits: {} };
export function WorkspaceTodosHost({
  serverId,
  workspaceId,
  active,
  children,
}: {
  serverId: string;
  workspaceId: string;
  active: boolean;
  children: ReactNode;
}) {
  const key = JSON.stringify([serverId, workspaceId]);
  return (
    <TodoHost key={key} viewKey={key} serverId={serverId} workspaceId={workspaceId} active={active}>
      {children}
    </TodoHost>
  );
}
function TodoHost({
  viewKey,
  serverId,
  workspaceId,
  active,
  children,
}: {
  viewKey: string;
  serverId: string;
  workspaceId: string;
  active: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const size = compact ? "md" : "sm";
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const view = useTodoViews((state) => state.views[viewKey]);
  const setView = useTodoViews((state) => state.setView);
  const open = view?.open ?? false;
  const close = useCallback(
    () => setView(viewKey, { open: false, position: view?.position }),
    [setView, viewKey, view?.position],
  );
  const toggle = useCallback(
    () => setView(viewKey, { open: !open, position: view?.position }),
    [setView, viewKey, view?.position, open],
  );
  const contextValue = useMemo(() => ({ open, toggle }), [open, toggle]);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [panelHeight, setPanelHeight] = useState(0);
  const [dragPosition, setDragPosition] = useState<TodoPosition>();
  const [list, setList] = useState<WorkspaceTodos | null>(null);
  const [draft, setDraft] = useState<Drafts>(() => draftsByWorkspace.get(viewKey) ?? EMPTY_DRAFT);
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [inputEpoch, setInputEpoch] = useState(0);
  const capability = client?.getLastServerInfoMessage()?.features?.workspaceTodos === true;
  const width = Math.min(360, bounds.width);
  const position = useMemo(
    () => clampTodoPosition(dragPosition ?? view?.position, bounds, { width, height: panelHeight }),
    [dragPosition, view?.position, bounds, width, panelHeight],
  );
  const positionRef = useRef(position);
  positionRef.current = position;
  const dragOrigin = useRef(position);
  const drag = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gesture) =>
          Math.abs(gesture.dx) + Math.abs(gesture.dy) > 3,
        onPanResponderGrant: () => {
          dragOrigin.current = positionRef.current;
        },
        onPanResponderMove: (_, gesture) =>
          setDragPosition({
            x: dragOrigin.current.x + gesture.dx,
            y: dragOrigin.current.y + gesture.dy,
          }),
        onPanResponderRelease: () => {
          setView(viewKey, { open: true, position: positionRef.current });
          setDragPosition(undefined);
        },
        onPanResponderTerminate: () => {
          setView(viewKey, { open: true, position: positionRef.current });
          setDragPosition(undefined);
        },
      }),
    [setView, viewKey],
  );
  useEffect(() => {
    draftsByWorkspace.set(viewKey, draft);
  }, [draft, viewKey]);
  useEffect(() => {
    if (compact || !view?.position || !bounds.width || dragPosition) return;
    if (view.position.x !== position.x || view.position.y !== position.y)
      setView(viewKey, { ...view, position });
  }, [bounds, compact, dragPosition, position, setView, view, viewKey]);
  useEffect(() => {
    if (!active || !open || !client || !capability) return;
    const subscription = client.observeWorkspaceTodos(workspaceId);
    const accept = (next: WorkspaceTodos) => {
      setList((current) => (!current || next.revision >= current.revision ? next : current));
      setLoadError(undefined);
    };
    const stop = subscription.subscribe({
      snapshot: (snapshot) => accept(snapshot.list),
      update: (message) => {
        if (message.type === "workspace.todos.changed") accept(message.payload.list);
      },
      error: (error) =>
        setLoadError(error instanceof Error ? error.message : t("common.errors.unableToSave")),
    });
    return () => {
      stop();
      void subscription.release().catch(() => {});
    };
  }, [active, capability, client, open, t, workspaceId]);
  const mutate = useCallback(
    async (mutation: WorkspaceTodoMutation, revision = list?.revision) => {
      if (pending || revision === undefined) return;
      setPending(true);
      try {
        if (!client?.isConnected) throw new Error(t("workspace.terminal.hostDisconnected"));
        const next = await client.mutateWorkspaceTodos(workspaceId, revision, mutation);
        setList((current) => (!current || next.revision >= current.revision ? next : current));
        setDraft((current) => {
          const edits = { ...current.edits };
          if (
            mutation.operation === "delete" ||
            (mutation.operation === "update" &&
              (mutation.title !== undefined || mutation.notes !== undefined))
          )
            delete edits[mutation.id];
          return {
            ...current,
            ...(mutation.operation === "add" ? { title: "", notes: "" } : {}),
            edits,
            failed: undefined,
            error: undefined,
          };
        });
        setInputEpoch((epoch) => epoch + 1);
      } catch (error) {
        setDraft((current) => ({
          ...current,
          failed: mutation,
          error: error instanceof Error ? error.message : t("common.errors.unableToSave"),
        }));
      } finally {
        setPending(false);
      }
    },
    [client, list?.revision, pending, t, workspaceId],
  );
  const retry = useCallback(async () => {
    if (!client || !draft.failed || pending) return;
    try {
      const fresh = await client.getWorkspaceTodos(workspaceId);
      setList(fresh.list);
      await mutate(draft.failed, fresh.list.revision);
    } catch (error) {
      setDraft((current) => ({
        ...current,
        error: error instanceof Error ? error.message : t("common.errors.unableToSave"),
      }));
    }
  }, [client, draft.failed, mutate, pending, t, workspaceId]);
  const changeEdit = useCallback(
    (task: WorkspaceTodo, field: "title" | "notes", text: string) =>
      setDraft((current) => ({
        ...current,
        failed: undefined,
        error: undefined,
        edits: {
          ...current.edits,
          [task.id]: { ...(current.edits[task.id] ?? { revision: list!.revision }), [field]: text },
        },
      })),
    [list],
  );
  const reorder = useCallback(
    (tasks: WorkspaceTodo[]) =>
      void mutate({ operation: "reorder", ids: tasks.map((task) => task.id) }),
    [mutate],
  );
  const toggleNotes = useCallback(
    (id: string) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const renderTask = useCallback(
    (info: DraggableRenderItemInfo<WorkspaceTodo>) => (
      <TodoRow
        info={info}
        list={list!}
        draft={draft.edits[info.item.id]}
        expanded={expanded.has(info.item.id)}
        pending={pending}
        epoch={inputEpoch}
        onEdit={changeEdit}
        onMutate={mutate}
        onToggleNotes={toggleNotes}
        onReorder={reorder}
      />
    ),
    [list, draft.edits, expanded, pending, inputEpoch, changeEdit, mutate, toggleNotes, reorder],
  );
  const onNewTitle = useCallback(
    (title: string) =>
      setDraft((current) => ({ ...current, title, failed: undefined, error: undefined })),
    [],
  );
  const onNewNotes = useCallback(
    (notes: string) =>
      setDraft((current) => ({ ...current, notes, failed: undefined, error: undefined })),
    [],
  );
  const add = useCallback(
    () => void mutate({ operation: "add", title: draft.title, notes: draft.notes }),
    [draft.title, draft.notes, mutate],
  );
  const extraData = useMemo(
    () => ({ draft, expanded, pending, inputEpoch }),
    [draft, expanded, pending, inputEpoch],
  );
  const empty = useMemo(() => <Text style={styles.text}>{t("workspaceTodos.empty")}</Text>, [t]);
  const content = (
    <TodoContent
      connected={connected}
      capability={capability}
      list={list}
      draft={draft}
      pending={pending}
      loadError={loadError}
      epoch={inputEpoch}
      extraData={extraData}
      empty={empty}
      onRetry={retry}
      renderTask={renderTask}
      onReorder={reorder}
      onNewTitle={onNewTitle}
      onNewNotes={onNewNotes}
      onAdd={add}
    />
  );
  const counter = list
    ? `${list.tasks.filter((task) => task.status === "done").length}/${list.tasks.length}`
    : "";
  const header = useMemo(
    () => ({ title: t("workspaceTodos.title"), subtitle: counter }),
    [t, counter],
  );
  const onHostLayout = useCallback(
    (event: import("react-native").LayoutChangeEvent) =>
      setBounds({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height }),
    [],
  );
  const onPanelLayout = useCallback(
    (event: import("react-native").LayoutChangeEvent) =>
      setPanelHeight(event.nativeEvent.layout.height),
    [],
  );
  let overlay: ReactNode = null;
  if (compact)
    overlay = (
      <AdaptiveModalSheet
        visible={active && open}
        onClose={close}
        header={header}
        testID="workspace-todos-sheet"
      >
        {content}
      </AdaptiveModalSheet>
    );
  else if (active && open && bounds.width > 0)
    overlay = (
      <View
        style={[
          styles.panel,
          { left: position.x, top: position.y, width, maxHeight: bounds.height },
        ]}
        onLayout={onPanelLayout}
        testID="workspace-todos-panel"
      >
        <View style={styles.header}>
          <View
            style={styles.dragHeader}
            {...drag.panHandlers}
            testID="workspace-todos-drag-header"
          >
            <ThemedListTodo size={16} uniProps={todoIconColor} />
            <Text style={styles.heading}>{t("workspaceTodos.title")}</Text>
            <Text style={styles.text} testID="workspace-todos-counter">
              {counter}
            </Text>
          </View>
          <Button
            variant="ghost"
            size={size}
            leftIcon={X}
            onPress={close}
            accessibilityLabel={t("workspaceTodos.close")}
            testID="workspace-todos-close"
          />
        </View>
        <ScrollView style={styles.scroll}>{content}</ScrollView>
      </View>
    );
  return (
    <TodoContext.Provider value={contextValue}>
      <View style={styles.host}>
        {children}
        {compact ? (
          overlay
        ) : (
          <View
            pointerEvents="box-none"
            style={[styles.overlay, { top: HEADER_INNER_HEIGHT + insets.top }]}
            onLayout={onHostLayout}
          >
            {overlay}
          </View>
        )}
      </View>
    </TodoContext.Provider>
  );
}
import { ScrollView } from "@/components/ui/scroll-view";
interface ContentProps {
  connected: boolean;
  capability: boolean;
  list: WorkspaceTodos | null;
  draft: Drafts;
  pending: boolean;
  loadError?: string;
  epoch: number;
  extraData: unknown;
  empty: import("react").ReactElement;
  onRetry(): Promise<void>;
  onReorder(tasks: WorkspaceTodo[]): void;
  renderTask(info: DraggableRenderItemInfo<WorkspaceTodo>): import("react").ReactElement;
  onNewTitle(text: string): void;
  onNewNotes(text: string): void;
  onAdd(): void;
}
const taskKey = (task: WorkspaceTodo) => task.id;
function TodoContent({
  connected,
  capability,
  list,
  draft,
  pending,
  loadError,
  epoch,
  extraData,
  empty,
  onRetry,
  renderTask,
  onReorder,
  onNewTitle,
  onNewNotes,
  onAdd,
}: ContentProps) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  if (!connected && !list)
    return <Text style={styles.error}>{t("workspace.terminal.hostDisconnected")}</Text>;
  if (!capability && !list)
    return (
      <Text style={styles.text} testID="workspace-todos-update-host">
        {t("workspaceTodos.updateHost")}
      </Text>
    );
  return (
    <View style={styles.body}>
      {!connected ? (
        <Text style={styles.error} accessibilityRole="alert">
          {t("workspace.terminal.hostDisconnected")}
        </Text>
      ) : null}
      {loadError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {loadError}
        </Text>
      ) : null}
      {draft.error ? (
        <View style={styles.errorBlock}>
          <Text style={styles.error} accessibilityRole="alert" testID="workspace-todos-error">
            {draft.error}
          </Text>
          <Button size={size} onPress={onRetry} disabled={pending} testID="workspace-todos-retry">
            {t("workspaceTodos.retry")}
          </Button>
        </View>
      ) : null}
      {!list ? (
        <Text style={styles.text}>{t("common.loading")}</Text>
      ) : (
        <>
          <DraggableList
            data={list.tasks}
            keyExtractor={taskKey}
            useDragHandle
            scrollEnabled={false}
            extraData={extraData}
            onDragEnd={onReorder}
            renderItem={renderTask}
            ListEmptyComponent={empty}
          />
          <View style={styles.add}>
            <FormTextInput
              size={size}
              initialValue={draft.title}
              resetKey={epoch}
              onChangeText={onNewTitle}
              placeholder={t("workspaceTodos.taskTitle")}
              accessibilityLabel={t("workspaceTodos.taskTitle")}
              editable={!pending}
              testID="workspace-todos-new-title"
            />
            <FormTextInput
              size={size}
              initialValue={draft.notes}
              resetKey={epoch}
              onChangeText={onNewNotes}
              placeholder={t("workspaceTodos.notes")}
              accessibilityLabel={t("workspaceTodos.notes")}
              multiline
              editable={!pending}
              testID="workspace-todos-new-notes"
            />
            <Button
              size={size}
              variant="default"
              disabled={pending || !draft.title.trim()}
              onPress={onAdd}
              testID="workspace-todos-add"
            >
              {t("workspaceTodos.add")}
            </Button>
          </View>
        </>
      )}
    </View>
  );
}
interface RowProps {
  info: DraggableRenderItemInfo<WorkspaceTodo>;
  list: WorkspaceTodos;
  draft?: EditDraft;
  expanded: boolean;
  pending: boolean;
  epoch: number;
  onEdit(task: WorkspaceTodo, field: "title" | "notes", text: string): void;
  onMutate(mutation: WorkspaceTodoMutation, revision?: number): Promise<void>;
  onToggleNotes(id: string): void;
  onReorder(tasks: WorkspaceTodo[]): void;
}
function TodoRow({
  info: { item: task, index, drag, dragHandleProps },
  list,
  draft,
  expanded,
  pending,
  epoch,
  onEdit,
  onMutate,
  onToggleNotes,
  onReorder,
}: RowProps) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const checked = useMemo(
    () => ({ checked: task.status === "done", disabled: pending }),
    [task.status, pending],
  );
  const expandedState = useMemo(() => ({ expanded }), [expanded]);
  const changeTitle = useCallback((text: string) => onEdit(task, "title", text), [onEdit, task]);
  const changeNotes = useCallback((text: string) => onEdit(task, "notes", text), [onEdit, task]);
  const toggle = useCallback(
    () =>
      void onMutate({
        operation: "update",
        id: task.id,
        status: task.status === "done" ? "todo" : "done",
      }),
    [onMutate, task],
  );
  const notes = useCallback(() => onToggleNotes(task.id), [onToggleNotes, task.id]);
  const save = useCallback(() => {
    if (draft)
      void onMutate(
        { operation: "update", id: task.id, title: draft.title, notes: draft.notes },
        draft.revision,
      );
  }, [draft, onMutate, task.id]);
  const remove = useCallback(
    () => void onMutate({ operation: "delete", id: task.id }),
    [onMutate, task.id],
  );
  const todo = useCallback(
    () => void onMutate({ operation: "update", id: task.id, status: "todo" }),
    [onMutate, task.id],
  );
  const inProgress = useCallback(
    () => void onMutate({ operation: "update", id: task.id, status: "in_progress" }),
    [onMutate, task.id],
  );
  const done = useCallback(
    () => void onMutate({ operation: "update", id: task.id, status: "done" }),
    [onMutate, task.id],
  );
  const move = useCallback(
    (offset: number) => {
      const tasks = [...list.tasks];
      const [item] = tasks.splice(index, 1);
      if (!item) return;
      tasks.splice(index + offset, 0, item);
      onReorder(tasks);
    },
    [list.tasks, index, onReorder],
  );
  const moveUp = useCallback(() => move(-1), [move]);
  const moveDown = useCallback(() => move(1), [move]);
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.menuTrigger}
        accessibilityLabel={t("workspaceTodos.taskMenu")}
        testID={`workspace-todo-menu-${task.id}`}
      >
        <ThemedMoreHorizontal size={16} uniProps={todoIconColor} />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem disabled={pending} onSelect={todo}>
          {t("workspaceTodos.todo")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={pending} onSelect={inProgress}>
          {t("workspaceTodos.in_progress")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={pending} onSelect={done}>
          {t("workspaceTodos.done")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={pending || index === 0} onSelect={moveUp}>
          {t("workspaceTodos.moveUp")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={pending || index === list.tasks.length - 1} onSelect={moveDown}>
          {t("workspaceTodos.moveDown")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={pending} onSelect={remove}>
          {t("workspaceTodos.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <View style={styles.task} testID={`workspace-todo-${task.id}`}>
      <View style={styles.row}>
        <TodoDragHandle
          taskId={task.id}
          drag={drag}
          dragHandleProps={dragHandleProps}
          pending={pending}
        />
        <Pressable
          hitSlop={12}
          accessibilityRole="checkbox"
          accessibilityState={checked}
          accessibilityLabel={task.title}
          disabled={pending}
          onPress={toggle}
          testID={`workspace-todo-check-${task.id}`}
          style={styles.checkbox}
        >
          {task.status === "done" ? <ThemedCheck size={14} uniProps={todoIconColor} /> : null}
        </Pressable>
        <FormTextInput
          size={size}
          style={styles.titleInput}
          initialValue={draft?.title ?? task.title}
          resetKey={`${epoch}:${draft ? "draft" : list.revision}`}
          onChangeText={changeTitle}
          editable={!pending}
          accessibilityLabel={t("workspaceTodos.taskTitle")}
          testID={`workspace-todo-title-${task.id}`}
        />
        {menu}
      </View>
      <View style={styles.row}>
        <Button
          variant="ghost"
          size={size}
          leftIcon={expanded ? ChevronDown : ChevronRight}
          onPress={notes}
          accessibilityState={expandedState}
          testID={`workspace-todo-notes-toggle-${task.id}`}
        >
          {t("workspaceTodos.notes")}
        </Button>
        <Text style={styles.status} testID={`workspace-todo-status-${task.id}`}>
          {t(`workspaceTodos.${task.status}`)}
        </Text>
      </View>
      {expanded ? (
        <FormTextInput
          size={size}
          initialValue={draft?.notes ?? task.notes}
          resetKey={`${epoch}:${draft ? "draft" : list.revision}`}
          multiline
          numberOfLines={3}
          onChangeText={changeNotes}
          editable={!pending}
          accessibilityLabel={t("workspaceTodos.notes")}
          testID={`workspace-todo-notes-${task.id}`}
        />
      ) : null}
      {draft ? (
        <View style={styles.row}>
          <Text style={styles.status}>{t("workspaceTodos.unsaved")}</Text>
          <Button
            size={size}
            onPress={save}
            disabled={pending || !(draft.title ?? task.title).trim()}
            testID={`workspace-todo-save-${task.id}`}
          >
            {t("workspaceTodos.save")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}
function TodoDragHandle({
  taskId,
  drag,
  dragHandleProps,
  pending,
}: Pick<DraggableRenderItemInfo<WorkspaceTodo>, "drag" | "dragHandleProps"> & {
  pending: boolean;
  taskId: string;
}) {
  const { t } = useTranslation();
  return (
    <View
      {...(isWeb && !pending ? dragHandleProps?.attributes : {})}
      {...(isWeb && !pending ? dragHandleProps?.listeners : {})}
      ref={isWeb ? (dragHandleProps?.setActivatorNodeRef as Ref<View>) : undefined}
      testID={`workspace-todo-drag-${taskId}`}
      style={styles.taskDragHandle}
    >
      <Pressable
        onLongPress={drag}
        style={styles.taskDragHandle}
        disabled={pending}
        accessibilityLabel={t("workspaceTodos.reorder")}
      >
        <ThemedGripVertical size={14} uniProps={todoIconColor} />
      </Pressable>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  taskDragHandle: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    touchAction: "none",
    cursor: "pointer",
  },
  host: { flex: 1, minHeight: 0 },
  overlay: { position: "absolute", bottom: 0, left: 0, right: 0, pointerEvents: "box-none" },
  panel: {
    position: "absolute",
    zIndex: 50,
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    boxShadow: "0 6px 24px rgba(0,0,0,0.2)",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  dragHeader: {
    userSelect: "none",
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[1],
  },
  heading: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  scroll: { flexShrink: 1 },
  body: { padding: theme.spacing[3], gap: theme.spacing[3] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  task: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  titleInput: { flex: 1, minWidth: 0 },
  menuTrigger: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 1,
    borderColor: theme.colors.foregroundMuted,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  status: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  add: { gap: theme.spacing[2] },
  errorBlock: { gap: theme.spacing[2] },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
