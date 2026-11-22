/* oxlint-disable react-perf/jsx-no-new-function-as-prop -- Eight in-memory tasks in a disposable design comparison. */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { prototypeCss } from "./list-prototype-style.js";

export const variants = ["simple", "phases", "detail"] as const;
type Variant = (typeof variants)[number];
const names: Record<Variant, string> = {
  simple: "Liste simple",
  phases: "Par phase",
  detail: "Avec détail",
};
const phases = ["Préparation", "Mise en ligne"] as const;
interface Item {
  id: number;
  title: string;
  done: boolean;
}
interface Task extends Item {
  phase: number;
  children: Item[];
}
const initialTasks: Task[] = [
  { title: "Relire la page d’accueil", phase: 0, done: true, children: [] },
  {
    title: "Choisir les photos",
    phase: 0,
    done: false,
    children: ["Portrait de l’équipe", "Photos de l’atelier"],
  },
  {
    title: "Vérifier le formulaire",
    phase: 0,
    done: false,
    children: ["Envoyer un message test", "Vérifier la réception"],
  },
  { title: "Valider les textes", phase: 0, done: false, children: [] },
  { title: "Connecter le domaine", phase: 1, done: false, children: [] },
  {
    title: "Vérifier les redirections",
    phase: 1,
    done: false,
    children: ["Ancienne page contact", "Ancien portfolio"],
  },
  { title: "Publier le site", phase: 1, done: false, children: [] },
  { title: "Prévenir le client", phase: 1, done: false, children: [] },
].map((task, id) => ({
  title: task.title,
  phase: task.phase,
  done: task.done,
  id,
  children: task.children.map((title, i) => ({ id: i, title, done: false })),
}));

export function readVariant(value?: string | null) {
  return variants.find((v) => v === value);
}

function AddTask({ add }: { add(title: string): void }) {
  const [value, setValue] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    add(value.trim());
    setValue("");
  }
  return (
    <form className="lp-add" onSubmit={submit}>
      <button aria-label="Ajouter la tâche" type="submit">
        ＋
      </button>
      <input
        aria-label="Ajouter une tâche"
        placeholder="Ajouter une tâche…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </form>
  );
}

function EditableTitle({ task, save }: { task: Task; save(title: string): void }) {
  return (
    <input
      className="lp-title"
      aria-label={"Renommer " + task.title}
      key={task.title}
      defaultValue={task.title}
      onBlur={(e) => {
        const value = e.target.value.trim();
        if (value) save(value);
        else e.target.value = task.title;
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.currentTarget.value = task.title;
        if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
      }}
    />
  );
}

function List({ variant }: { variant: Variant }) {
  const [tasks, setTasks] = useState(initialTasks);
  const [selected, select] = useState(2);
  const [expanded, expand] = useState<number | null>(null);
  const [open, setOpen] = useState([true, true]);
  const next = useRef(initialTasks.length);
  const current = tasks.find((task) => task.id === selected)!;
  function change(id: number, values: Partial<Task>) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...values } : t)));
  }
  function add(title: string, phase: number) {
    const task = { id: next.current++, title, phase, done: false, children: [] };
    setTasks((prev) => [...prev, task]);
    if (variant === "detail") select(task.id);
  }
  function checkbox(task: Task) {
    return (
      <input
        className="lp-check"
        type="checkbox"
        aria-label={"Terminer " + task.title}
        checked={task.done}
        onChange={(e) => change(task.id, { done: e.target.checked })}
      />
    );
  }
  function children(task: Task) {
    return (
      <div className="lp-children">
        {task.children.length ? (
          task.children.map((item) => (
            <label key={item.id}>
              <input
                className="lp-check"
                type="checkbox"
                checked={item.done}
                onChange={() =>
                  change(task.id, {
                    children: task.children.map((c) =>
                      c.id === item.id ? { ...c, done: !c.done } : c,
                    ),
                  })
                }
              />
              <span>{item.title}</span>
            </label>
          ))
        ) : (
          <span className="lp-muted">Aucune sous-tâche</span>
        )}
      </div>
    );
  }
  function row(task: Task) {
    return (
      <div key={task.id}>
        <div className="lp-row" data-done={task.done}>
          {checkbox(task)}
          <EditableTitle task={task} save={(title) => change(task.id, { title })} />
          {task.children.length > 0 && (
            <button
              type="button"
              className="lp-disclose"
              aria-label={"Sous-tâches de " + task.title}
              aria-expanded={expanded === task.id}
              onClick={() => expand(expanded === task.id ? null : task.id)}
            >
              {task.children.length}
              <span aria-hidden="true">{expanded === task.id ? "▴" : "▾"}</span>
            </button>
          )}
        </div>
        {expanded === task.id && children(task)}
      </div>
    );
  }
  const done = tasks.filter((t) => t.done).length;
  return (
    <main className={"lp-sheet lp-" + variant}>
      <header className="lp-head">
        <div className="lp-eyebrow">Projet d’essai</div>
        <h1>Refonte du site Atelier</h1>
        <div className="lp-progress">
          <progress value={done} max={tasks.length} />
          <span>
            {done} sur {tasks.length} terminée{done > 1 ? "s" : ""}
          </span>
        </div>
      </header>
      {variant === "simple" && (
        <section className="lp-paper">
          <h2>Tâches</h2>
          {tasks.map(row)}
          <AddTask add={(title) => add(title, 0)} />
        </section>
      )}
      {variant === "phases" && (
        <div className="lp-groups">
          {phases.map((phase, i) => {
            const group = tasks.filter((t) => t.phase === i);
            const left = group.filter((t) => !t.done).length;
            return (
              <section className="lp-paper" key={phase}>
                <button
                  type="button"
                  className="lp-phase"
                  aria-expanded={open[i]}
                  onClick={() => setOpen(open.map((v, index) => (index === i ? !v : v)))}
                >
                  <strong>{phase}</strong>
                  <span>{left} à faire</span>
                  <b aria-hidden="true">{open[i] ? "−" : "+"}</b>
                </button>
                {open[i] && (
                  <>
                    {group.map(row)}
                    <AddTask add={(title) => add(title, i)} />
                  </>
                )}
              </section>
            );
          })}
        </div>
      )}
      {variant === "detail" && (
        <div className="lp-split">
          <section className="lp-index">
            <h2>Tâches</h2>
            {tasks.map((t) => (
              <div
                className="lp-indexrow"
                data-selected={t.id === selected}
                data-done={t.done}
                key={t.id}
              >
                {checkbox(t)}
                <button type="button" aria-pressed={t.id === selected} onClick={() => select(t.id)}>
                  {t.title}
                </button>
              </div>
            ))}
            <AddTask add={(title) => add(title, current.phase)} />
          </section>
          <section className="lp-detailpane">
            <div className="lp-eyebrow">{phases[current.phase]}</div>
            <EditableTitle task={current} save={(title) => change(current.id, { title })} />
            <h2>Sous-tâches</h2>
            {children(current)}
          </section>
        </div>
      )}
    </main>
  );
}

export function ListPrototype({ initial }: { initial: Variant }) {
  const [variant, setVariant] = useState(initial);
  function show(next: Variant) {
    setVariant(next);
    const url = new URL(window.location.href);
    url.searchParams.set("param.variant", next);
    window.history.replaceState(window.history.state, "", url);
  }
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("input,textarea,[contenteditable=true]")
      )
        return;
      const step = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[e.key] ?? 0;
      if (step && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        show(variants[(variants.indexOf(variant) + step + 3) % 3]);
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [variant]);
  return (
    <div className="lp-root">
      <style>{prototypeCss}</style>
      <div className="lp-scroll">
        {variants.map((v) => (
          <div key={v} hidden={v !== variant}>
            <List variant={v} />
          </div>
        ))}
      </div>
      <nav className="lp-switch" aria-label="Comparer les listes">
        {variants.map((v) => (
          <button type="button" key={v} aria-pressed={variant === v} onClick={() => show(v)}>
            {names[v]}
          </button>
        ))}
      </nav>
    </div>
  );
}
