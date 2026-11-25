/* oxlint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-array-as-prop -- Local board interactions and theme styles. */
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import type { SequenceRequest, SequenceRow } from "../shared/sequence.js";
import { useSequence, useSequenceActivity } from "./use-sequence.js";
import { SequenceDispatch } from "./sequence-dispatch.js";
import { SequenceProjectAssociation } from "./sequence-association.js";
import { CoachPanel } from "./coach-panel.js";
import { SequenceImage } from "./sequence-image.js";
import Markdown from "react-markdown";

const projectDrag = "application/x-things-sequence-project";
const taskDrag = "application/x-things-sequence-task";
const statusLabels = {
  todo: "À faire",
  inProgress: "En cours",
  waiting: "En attente",
  done: "Fait",
};
const widths = [416, 310, 236, 204];
const sequenceBlue = "#007aff";
function deadline(task: SequenceRow, day: number) {
  if (task.deadline === day) return "Échéance aujourd’hui";
  return task.deadline !== undefined && task.deadline < day ? "Échéance passée" : null;
}
const titleSizes = [25, 21, 18];
const widthAt = (index: number, scale: number) => widths[Math.min(index, 3)]! * scale;

function group(rows: SequenceRow[]) {
  const headings = rows.filter((row) => row.kind === "heading");
  const ids = new Set(headings.map((heading) => heading.id));
  const tasks = rows.filter((row) => row.kind === "task");
  return [
    { id: "", title: "", tasks: tasks.filter((task) => !task.section || !ids.has(task.section)) },
    ...headings.map(({ id, title }) => ({
      id,
      title,
      tasks: tasks.filter((task) => task.section === id),
    })),
  ];
}

// oxlint-disable-next-line complexity -- Renders platform-specific details using the same state.
export function SequenceBoard({ host, layout, theme, navigation }: PluginScreenProps) {
  const { query, rpc } = useSequence(host.id);
  const agents = useSequenceActivity(host.id);
  const [selection, choose] = useState<{ project: string; task?: string }>();
  const [error, setError] = useState("");
  const [coach, showCoach] = useState(false);
  const colors = { ...theme.colors, accent: sequenceBlue };
  const web = layout.platform === "web";
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    if (web) return;
    let current = true;
    async function readPreference() {
      const enabled = await AccessibilityInfo.isReduceMotionEnabled().catch(() => true);
      if (current) setReduceMotion(enabled);
    }
    void readPreference();
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      current = false;
      subscription.remove();
    };
  }, [web]);
  const { width } = useWindowDimensions();
  const sequence = query.data;
  const activeProject = sequence?.projects.find((row) => row.id === selection?.project);
  const activeTask = sequence?.rows.find((row) => row.id === selection?.task);
  const message = error || query.error?.message;
  async function change(request: SequenceRequest) {
    setError("");
    try {
      const result = await rpc(request);
      if (result.error) throw new Error(result.error);
      await query.refetch();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Modification impossible.");
      return false;
    }
  }
  function renderAgent(task: SequenceRow) {
    const agent = agents.data?.get(task.id);
    if (!agent) return null;
    const label = "Agent en cours · Ouvrir l’agent";
    const open = navigation?.openAgent;
    const icon = <Icon name="LoaderCircle" size={14} color={colors.accent} />;
    if (web)
      return (
        <button
          type="button"
          className="sequenceAgent"
          aria-label={label}
          title="Agent en cours"
          onClick={() => open?.(agent)}
          disabled={!open}
        >
          <span aria-hidden="true">{icon}</span>
        </button>
      );
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => open?.(agent)}
        disabled={!open}
        hitSlop={6}
        style={{ padding: 4 }}
      >
        {reduceMotion ? icon : <ActivityIndicator size="small" color={colors.accent} />}
      </Pressable>
    );
  }
  const detail = selection?.task ? activeTask : activeProject;
  const images = activeTask?.images.map((id) => (
    <SequenceImage key={id} hostId={host.id} id={id} />
  ));
  const dispatch = activeProject && activeTask && (
    <SequenceDispatch
      key={activeTask.id}
      hostId={host.id}
      task={activeTask}
      project={activeProject}
      navigation={navigation}
      color={colors.foreground}
      accent={colors.accent}
    />
  );
  const association = !selection?.task && activeProject && (
    <SequenceProjectAssociation
      key={activeProject.id}
      hostId={host.id}
      project={activeProject.id}
      color={colors.foreground}
    />
  );
  const coachPanel = coach && (
    <CoachPanel
      key={host.id}
      hostId={host.id}
      web={web}
      colors={colors}
      close={() => showCoach(false)}
    />
  );
  const details = (
    <Modal
      open={Boolean(selection)}
      onOpenChange={(open) => {
        if (!open) choose(undefined);
      }}
      title={detail?.title ?? "Élément indisponible"}
    >
      <Modal.Content style={{ backgroundColor: colors.surface0 }}>
        {detail?.notes &&
          (web ? (
            <SequenceNote notes={detail.notes} />
          ) : (
            <Text style={{ color: colors.foreground }}>{detail.notes}</Text>
          ))}
        {activeTask?.checklist.map((child) => (
          <Text style={{ color: colors.foreground }} key={child.id}>
            {child.done ? "☑ " : "☐ "}
            {child.title}
          </Text>
        ))}
        {images}
        {association}
        {dispatch}
      </Modal.Content>
    </Modal>
  );
  const empty = sequence ? "Aucun projet dans la séquence." : "Chargement…";
  if (!web)
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
        <Pressable
          accessibilityRole="button"
          onPress={() => showCoach(true)}
          style={{ padding: 16 }}
        >
          <Text style={{ color: colors.accent }}>Coach</Text>
        </Pressable>
        {coachPanel}
        {message && (
          <Text accessibilityRole="alert" style={{ color: colors.foreground, padding: 12 }}>
            {message}
          </Text>
        )}
        {!message && !sequence?.projects.length && (
          <Text style={{ color: colors.foreground, padding: 16 }}>{empty}</Text>
        )}
        <ScrollView horizontal>
          <ScrollView contentContainerStyle={{ padding: 16, flexDirection: "row" }}>
            {sequence?.projects.map((project, index) => (
              <NativeColumn
                key={project.id}
                project={project}
                index={index}
                day={sequence.day}
                renderAgent={renderAgent}
                width={widthAt(index, Math.max(0.75, Math.min(1, (width - 64) / 640)))}
                rows={sequence.rows.filter((row) => row.parent === project.id)}
                view={(task) => choose({ project: project.id, task })}
                schedule={(ids, today) =>
                  change({ action: "schedule", id: project.id, ids, today })
                }
                move={(offset) => {
                  const target = sequence.projects[index + offset];
                  if (target) void change({ action: "move", id: project.id, target: target.id });
                }}
                colors={colors}
              />
            ))}
          </ScrollView>
        </ScrollView>
        {details}
      </View>
    );
  return (
    <div
      className="thingsSequence"
      style={
        {
          color: colors.foreground,
          background: colors.surface0,
          "--sequence-accent": colors.accent,
          "--sequence-surface": colors.surface0,
        } as React.CSSProperties
      }
    >
      <style>{style}</style>
      <div className="sequenceCoachToolbar">
        <button type="button" onClick={() => showCoach(true)}>
          Coach
        </button>
      </div>
      {coachPanel}
      {message && (
        <p className="sequenceMessage" role="alert">
          {message}
        </p>
      )}
      {!message && !sequence?.projects.length && <p className="sequenceMessage">{empty}</p>}
      <div className="sequenceScroll">
        <div className="sequenceColumns">
          {sequence?.projects.map((project, index) => (
            <WebColumn
              key={project.id}
              project={project}
              index={index}
              day={sequence.day}
              renderAgent={renderAgent}
              rows={sequence.rows.filter((row) => row.parent === project.id)}
              view={(task) => choose({ project: project.id, task })}
              move={(source) => void change({ action: "move", id: source, target: project.id })}
              schedule={(ids, today) => change({ action: "schedule", id: project.id, ids, today })}
            />
          ))}
        </div>
      </div>
      {details}
    </div>
  );
}

interface Column {
  project: SequenceRow;
  rows: SequenceRow[];
  index: number;
  day: number;
  view(task?: string): void;
  renderAgent(task: SequenceRow): ReactNode;
  schedule(ids: string[], today: boolean): Promise<boolean>;
}

function WebColumn({
  project,
  rows,
  index,
  day,
  view,
  move,
  renderAgent,
  schedule,
}: Column & { move(source: string): void }) {
  const sections = group(rows);
  const tasks = sections.flatMap((section) => section.tasks);
  const today = tasks.filter((task) => task.today);
  const candidates = tasks.filter((task) => !task.today && task.eligible);
  const [checked, setChecked] = useState<string[]>();
  const [over, setOver] = useState<"project" | "task">();
  function drop(event: DragEvent, type: string) {
    event.preventDefault();
    setOver(undefined);
    const id = event.dataTransfer.getData(type);
    if (type === projectDrag && id && id !== project.id) move(id);
    if (type === taskDrag && candidates.some((task) => task.id === id)) void schedule([id], true);
  }
  function target(event: DragEvent, type: string) {
    if (event.dataTransfer.types.includes(type)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setOver(type === projectDrag ? "project" : "task");
    }
  }
  return (
    <article
      className="sequenceColumn"
      style={{ "--sequence-width": widthAt(index, 1) } as React.CSSProperties}
    >
      <header
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(projectDrag, project.id);
          event.dataTransfer.effectAllowed = "move";
          setChecked(undefined);
        }}
        onDragOver={(event) => target(event, projectDrag)}
        onDragLeave={() => setOver(undefined)}
        onDrop={(event) => drop(event, projectDrag)}
        data-over={over === "project"}
      >
        <button type="button" className="sequenceTitle" onClick={() => view()}>
          {project.title}
        </button>
        {project.status && (
          <span className="sequenceStatus" data-status={project.status}>
            {statusLabels[project.status]}
          </span>
        )}
      </header>
      <section
        className="sequenceToday"
        data-over={over === "task"}
        onDragOver={(event) => target(event, taskDrag)}
        onDragLeave={() => setOver(undefined)}
        onDrop={(event) => drop(event, taskDrag)}
      >
        <div className="sequenceLine">
          <strong>Aujourd’hui</strong>
          {!!candidates.length && (
            <button
              type="button"
              className="sequenceAction"
              aria-label="Ajouter à Aujourd’hui"
              aria-expanded={!!checked}
              onClick={() => setChecked(checked ? undefined : [])}
            >
              +
            </button>
          )}
        </div>
        {!today.length && <span className="sequenceEmpty">Rien pour aujourd’hui</span>}
        {today.map((task) => (
          <div className="sequenceLine" key={task.id}>
            <TaskLine task={task} view={view} />
            {renderAgent(task)}
            {deadline(task, day) ? (
              <small>{deadline(task, day)}</small>
            ) : (
              <button
                type="button"
                className="sequenceAction"
                aria-label={`Retirer « ${task.title} » d’Aujourd’hui`}
                onClick={() => void schedule([task.id], false)}
              >
                −
              </button>
            )}
          </div>
        ))}
        {checked && candidates.length > 0 && (
          <div className="sequencePicker">
            <div>
              {candidates.map((task) => (
                <label key={task.id}>
                  <input
                    type="checkbox"
                    checked={checked.includes(task.id)}
                    onChange={(event) =>
                      setChecked(
                        event.target.checked
                          ? [...checked, task.id]
                          : checked.filter((id) => id !== task.id),
                      )
                    }
                  />
                  {task.title}
                </label>
              ))}
            </div>
            <button
              type="button"
              className="sequenceAction"
              disabled={!checked.some((id) => candidates.some((task) => task.id === id))}
              onClick={() =>
                void schedule(
                  checked.filter((id) => candidates.some((task) => task.id === id)),
                  true,
                ).then((ok) => {
                  if (ok) setChecked(undefined);
                  return ok;
                })
              }
            >
              Ajouter
            </button>
          </div>
        )}
      </section>
      <div className="sequenceRemaining">
        {!!project.notes.trim() && <SequenceNote notes={project.notes} />}
        {sections.map((section) => {
          const remaining = section.tasks.filter((task) => !task.today);
          if (!remaining.length) return null;
          return (
            <section key={section.id}>
              {section.title && <strong>{section.title}</strong>}
              {remaining.map((task) => (
                <div className="sequenceLine" key={task.id}>
                  <TaskLine task={task} view={view} draggable={task.eligible} />
                  {renderAgent(task)}
                  {task.eligible && (
                    <button
                      type="button"
                      className="sequenceAction"
                      aria-label={`Ajouter « ${task.title} » à Aujourd’hui`}
                      onClick={() => void schedule([task.id], true)}
                    >
                      +
                    </button>
                  )}
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </article>
  );
}

function SequenceNote({ notes }: { notes: string }) {
  return (
    <div className="sequenceNote">
      <Markdown skipHtml disallowedElements={["img"]}>
        {notes}
      </Markdown>
    </div>
  );
}

function TaskLine({
  task,
  view,
  draggable,
}: {
  task: SequenceRow;
  view(id: string): void;
  draggable?: boolean;
}) {
  return (
    <button
      type="button"
      className="sequenceTask"
      draggable={draggable}
      onDragStart={
        draggable
          ? (event) => {
              event.dataTransfer.setData(taskDrag, task.id);
              event.dataTransfer.effectAllowed = "move";
            }
          : undefined
      }
      onClick={() => view(task.id)}
    >
      <i aria-hidden="true" data-someday={task.someday} />
      {task.title}
    </button>
  );
}

function NativeColumn({
  project,
  rows,
  day,
  index,
  width,
  view,
  move,
  renderAgent,
  schedule,
  colors,
}: Column & {
  width: number;
  move(offset: number): void;
  colors: PluginScreenProps["theme"]["colors"];
}) {
  const sections = group(rows);
  const tasks = sections.flatMap((section) => section.tasks);
  const today = tasks.filter((task) => task.today);
  const candidates = tasks.filter((task) => !task.today && task.eligible);
  const [checked, check] = useState<string[]>();
  const fg = { color: colors.foreground };
  const action = { color: colors.accent, paddingHorizontal: 5, paddingVertical: 4 };
  return (
    <View style={{ width, borderRightWidth: 1, borderRightColor: colors.border }}>
      <View style={{ padding: 15, minHeight: 90 }}>
        <Pressable accessibilityRole="button" onPress={() => view()}>
          <Text style={{ ...fg, fontSize: titleSizes[Math.min(index, 2)], fontWeight: "700" }}>
            {project.title}
          </Text>
        </Pressable>
        {project.status && <Text style={fg}>{statusLabels[project.status]}</Text>}
        <View style={{ flexDirection: "row" }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Déplacer à gauche"
            onPress={() => move(-1)}
          >
            <Text style={action}>←</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Déplacer à droite"
            onPress={() => move(1)}
          >
            <Text style={action}>→</Text>
          </Pressable>
        </View>
      </View>
      <View
        style={{
          minHeight: 72,
          paddingHorizontal: 15,
          paddingVertical: 9,
          backgroundColor: colors.surface1,
        }}
      >
        <View
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
        >
          <Text style={{ ...fg, fontWeight: "600" }}>Aujourd’hui</Text>
          {!!candidates.length && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Ajouter à Aujourd’hui"
              onPress={() => check(checked ? undefined : [])}
            >
              <Text style={action}>+</Text>
            </Pressable>
          )}
        </View>
        {!today.length && <Text style={fg}>Rien pour aujourd’hui</Text>}
        {today.map((task) => (
          <View style={{ flexDirection: "row", alignItems: "center" }} key={task.id}>
            <Pressable style={{ flex: 1 }} onPress={() => view(task.id)}>
              <Text style={fg}>□ {task.title}</Text>
            </Pressable>
            {renderAgent(task)}
            {deadline(task, day) ? (
              <Text style={{ ...fg, fontSize: 11 }}>{deadline(task, day)}</Text>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Retirer « ${task.title} » d’Aujourd’hui`}
                onPress={() => void schedule([task.id], false)}
              >
                <Text style={action}>−</Text>
              </Pressable>
            )}
          </View>
        ))}
        {checked && (
          <View>
            {candidates.map((task) => (
              <Pressable
                key={task.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: checked.includes(task.id) }}
                onPress={() =>
                  check(
                    checked.includes(task.id)
                      ? checked.filter((id) => id !== task.id)
                      : [...checked, task.id],
                  )
                }
              >
                <Text style={fg}>
                  {checked.includes(task.id) ? "☑ " : "☐ "}
                  {task.title}
                </Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              disabled={!checked.length}
              onPress={() =>
                void schedule(checked, true).then((ok) => {
                  if (ok) check(undefined);
                  return ok;
                })
              }
            >
              <Text style={action}>Ajouter</Text>
            </Pressable>
          </View>
        )}
      </View>
      <View style={{ padding: 15, gap: 12 }}>
        {!!project.notes.trim() && (
          <Text numberOfLines={index === 0 ? 4 : 2} style={fg}>
            {project.notes}
          </Text>
        )}
        {sections.map((section) => {
          const items = section.tasks.filter((task) => !task.today);
          if (!items.length) return null;
          return (
            <View key={section.id} style={{ gap: 4 }}>
              {!!section.title && <Text style={{ ...fg, fontWeight: "600" }}>{section.title}</Text>}
              {items.map((task) => (
                <View style={{ flexDirection: "row", alignItems: "center" }} key={task.id}>
                  <Pressable style={{ flex: 1 }} onPress={() => view(task.id)}>
                    <Text style={fg}>□ {task.title}</Text>
                  </Pressable>
                  {renderAgent(task)}
                  {task.eligible && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Ajouter « ${task.title} » à Aujourd’hui`}
                      onPress={() => void schedule([task.id], true)}
                    >
                      <Text style={action}>+</Text>
                    </Pressable>
                  )}
                </View>
              ))}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const style = `
.thingsSequence{display:flex;position:relative;flex:1;min-height:0;min-width:0;flex-direction:column;font:14px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;container-type:inline-size}
.sequenceScroll{position:relative;overflow:auto;flex:1;scrollbar-width:thin}
.sequenceColumns{display:flex;min-width:100%;width:max-content;min-height:100%;box-sizing:border-box;padding:31px 32px 22px}
.sequenceColumn{width:calc(var(--sequence-width) * 1px);flex:none;border-inline-end:1px solid color-mix(in srgb,currentColor 13%,transparent);box-sizing:border-box;--today-strength:5.5%}
@container (max-width:704px){.sequenceColumn{width:clamp(calc(var(--sequence-width) * .75px),calc(var(--sequence-width) * (100cqw - 64px) / 640),calc(var(--sequence-width) * 1px))}}
.sequenceColumn:first-child{--today-strength:11%}
.sequenceColumn>header{display:flex;flex-direction:column;align-items:flex-start;gap:7px;min-height:92px;padding:12px 15px;box-sizing:border-box;cursor:grab}
.sequenceColumn>header[data-over="true"]{box-shadow:inset 3px 0 var(--sequence-accent)}
.thingsSequence button{color:inherit;background:transparent;border:0;padding:0;font:inherit;cursor:pointer;text-align:left}
.thingsSequence button:disabled{opacity:.45;cursor:default}
.sequenceColumn .sequenceTitle{font-size:18px;font-weight:700;line-height:1.18;overflow-wrap:anywhere}
.sequenceColumn:first-child .sequenceTitle{font-size:25px}.sequenceColumn:nth-child(2) .sequenceTitle{font-size:21px}
.sequenceStatus{font-size:10px;font-weight:500;padding:3px 6px;border-radius:20px;background:color-mix(in srgb,var(--status) 19%,transparent);display:inline-flex;align-items:center;gap:4px}
.sequenceStatus::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--status)}
.sequenceStatus[data-status=todo]{--status:#1685f6}.sequenceStatus[data-status=inProgress]{--status:#eab308}.sequenceStatus[data-status=waiting]{--status:#ff9500}.sequenceStatus[data-status=done]{--status:#30ab55}
.sequenceToday{position:relative;display:flex;flex-direction:column;gap:5px;min-height:74px;box-sizing:border-box;padding:9px 15px;background:color-mix(in srgb,var(--sequence-accent) var(--today-strength),transparent);border-block:1px solid color-mix(in srgb,currentColor 13%,transparent)}
.sequenceToday[data-over="true"]{--today-strength:21%}
.sequenceLine{display:flex;gap:4px;align-items:center;justify-content:space-between;min-height:20px}
.sequenceToday .sequenceLine:has(.sequenceTask){min-height:30px}
.sequenceLine strong,.sequenceRemaining strong{font-size:12px;font-weight:600}.sequenceEmpty,.sequenceLine small{opacity:.62}.sequenceEmpty{display:block;font-size:13px}
.sequenceLine small{font-size:11px;text-align:right}.sequenceLine .sequenceAction{margin-left:auto}
.thingsSequence .sequenceAction{color:var(--sequence-accent);min-width:20px;min-height:20px;text-align:center;font-weight:600}
.sequenceTask{display:flex;align-items:flex-start;flex:1;min-width:0;gap:10px;padding:3px 0!important;line-height:1.22!important;overflow-wrap:anywhere}
.sequenceTask i{display:block;flex:none;width:13px;height:13px;box-sizing:border-box;border:1px solid currentColor;opacity:.38;border-radius:3px;margin-top:2px}
.thingsSequence .sequenceAgent{display:grid;place-items:center;width:24px;height:24px;flex:none;border-radius:4px}
.sequenceAgent span{display:grid;animation:sequence-agent-spin 1.1s linear infinite}
@keyframes sequence-agent-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.sequenceAgent span{animation:none}}
@media(hover:hover){.sequenceAgent:hover{background:color-mix(in srgb,var(--sequence-accent) 12%,transparent)}}
.sequenceTask i[data-someday="true"]{border-style:dashed}
.sequenceRemaining{display:flex;flex-direction:column;gap:12px;padding:15px}.sequenceRemaining section{display:flex;flex-direction:column;gap:4px}
.sequenceRemaining .sequenceNote{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:0;font-size:13px;line-height:1.35;white-space:pre-wrap}
.sequenceColumn:first-child .sequenceRemaining .sequenceNote{-webkit-line-clamp:4}
.sequenceNote p{margin:0;white-space:pre-wrap}.sequenceNote p+p{margin-top:.45em}.sequenceNote a{color:var(--sequence-accent)}.sequenceNote ul,.sequenceNote ol{margin:0;padding-left:1.2em}.sequenceNote blockquote{margin:0;padding-left:.5em;border-inline-start:2px solid #8885}
.sequencePicker{position:absolute;z-index:2;top:30px;right:7px;width:min(310px,calc(100% - 14px));padding:9px;box-sizing:border-box;border:1px solid #8886;border-radius:8px;background:var(--sequence-surface);box-shadow:0 7px 22px #0003}
.sequencePicker>div{display:flex;flex-direction:column;max-height:220px;overflow:auto;gap:7px;padding-bottom:6px}.sequencePicker label{display:flex;align-items:flex-start;gap:4px}
.sequenceCoachToolbar{display:flex;justify-content:flex-end;padding:10px 24px 0}
.sequenceCoachToolbar button{font:inherit;color:var(--sequence-accent);border:1px solid currentColor;border-radius:7px;padding:5px 12px;background:transparent;cursor:pointer}
.sequenceMessage{margin:12px 32px;color:inherit;opacity:.72}
`;
