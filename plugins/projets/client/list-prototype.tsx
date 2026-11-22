/* oxlint-disable react-perf/jsx-no-new-function-as-prop -- In-memory project cards in a disposable design comparison. */
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

function makeTask(
  id: number,
  title: string,
  phase: number,
  subtasks: string[] = [],
  done = false,
): Task {
  return {
    id,
    title,
    phase,
    done,
    children: subtasks.map((label, index) => ({ id: index, title: label, done: false })),
  };
}

const projects = [
  { name: "Site Atelier", tasks: initialTasks },
  {
    name: "Maison Iris",
    tasks: [
      makeTask(0, "Choisir la photo de couverture", 0, [], true),
      makeTask(1, "Relire la carte d’été", 0, ["Vérifier les prix", "Confirmer les horaires"]),
      makeTask(2, "Ajouter la terrasse", 0),
      makeTask(3, "Ouvrir les réservations", 1, [
        "Tester une réservation",
        "Confirmer le courriel",
      ]),
      makeTask(4, "Annoncer la réouverture", 1),
    ],
  },
  {
    name: "Studio Nacre",
    tasks: [
      makeTask(0, "Sélectionner les réalisations", 0, [], true),
      makeTask(1, "Recadrer les visuels", 0, ["Portrait", "Paysage"]),
      makeTask(2, "Publier le portfolio", 1, ["Relire les légendes", "Tester sur tablette"]),
      makeTask(3, "Envoyer le lien au studio", 1),
    ],
  },
];

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

function Subtasks({ task, change }: { task: Task; change(values: Partial<Task>): void }) {
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
                change({
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

interface TaskImage {
  id: number;
  file: File;
}

function ImageTile({ image, remove }: { image: TaskImage; remove(): void }) {
  const [url, setUrl] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const src = URL.createObjectURL(image.file);
    setUrl(src);
    return () => URL.revokeObjectURL(src);
  }, [image.file]);
  if (!url) return null;
  return (
    <div className="lp-image">
      <button
        type="button"
        aria-label={"Agrandir " + image.file.name}
        onClick={() => dialog.current?.showModal()}
      >
        <img src={url} alt={image.file.name} />
      </button>
      <button
        className="lp-remove"
        type="button"
        aria-label={"Retirer " + image.file.name}
        onClick={remove}
      >
        ×
      </button>
      <dialog ref={dialog} className="lp-lightbox" aria-label={image.file.name}>
        <img src={url} alt={image.file.name} />
        <button type="button" onClick={() => dialog.current?.close()}>
          Fermer
        </button>
      </dialog>
    </div>
  );
}

interface ColumnProps {
  variant: Variant;
  name: string;
  tasks: Task[];
  selected?: number;
  select(id: number): void;
  update(tasks: Task[]): void;
}
function ProjectColumn({ variant, name, tasks, selected, select, update }: ColumnProps) {
  const [expanded, expand] = useState<number | null>(null);
  const [open, setOpen] = useState([true, true]);
  const [folded, fold] = useState(false);
  const next = useRef(tasks.length);
  const [images, setImages] = useState<Record<number, TaskImage[]>>({});
  const nextImage = useRef(0);
  function attach(id: number, files: FileList) {
    const added = Array.from(files)
      .filter((file) => file.type.startsWith("image/"))
      .map((file) => ({ id: nextImage.current++, file }));
    if (!added.length) return false;
    setImages((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), ...added] }));
    expand(id);
    return true;
  }
  function change(id: number, values: Partial<Task>) {
    update(tasks.map((t) => (t.id === id ? { ...t, ...values } : t)));
  }
  function add(title: string, phase: number) {
    const t = makeTask(next.current++, title, phase);
    update([...tasks, t]);
    if (variant === "detail") select(t.id);
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
  function row(task: Task) {
    const byPhase = variant === "phases";
    const attached = images[task.id] ?? [];
    return (
      <div
        key={task.id}
        onPaste={(event) => {
          if (byPhase && attach(task.id, event.clipboardData.files)) event.preventDefault();
        }}
      >
        <div className="lp-row" data-done={task.done}>
          {checkbox(task)}
          <EditableTitle task={task} save={(title) => change(task.id, { title })} />
          {(byPhase || task.children.length > 0) && (
            <button
              type="button"
              className="lp-disclose"
              aria-label={(byPhase ? "Détails de " : "Sous-tâches de ") + task.title}
              aria-expanded={expanded === task.id}
              onClick={() => expand(expanded === task.id ? null : task.id)}
            >
              {byPhase
                ? attached.length > 0 && (
                    <span>
                      {attached.length} image{attached.length > 1 ? "s" : ""}
                    </span>
                  )
                : task.children.length}
              <span aria-hidden="true">{expanded === task.id ? "▴" : "▾"}</span>
            </button>
          )}
        </div>
        {expanded === task.id && (
          <>
            {task.children.length > 0 && (
              <Subtasks task={task} change={(values) => change(task.id, values)} />
            )}
            {byPhase && (
              <div className="lp-attachments" tabIndex={0} aria-label={"Images de " + task.title}>
                {attached.length > 0 && (
                  <div className="lp-gallery">
                    {attached.map((image) => (
                      <ImageTile
                        key={image.id}
                        image={image}
                        remove={() =>
                          setImages((prev) => ({
                            ...prev,
                            [task.id]: prev[task.id].filter((item) => item.id !== image.id),
                          }))
                        }
                      />
                    ))}
                  </div>
                )}
                <label className="lp-pick">
                  Ajouter des images
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(event) => {
                      if (event.target.files) attach(task.id, event.target.files);
                      event.target.value = "";
                    }}
                  />
                </label>
                <small>ou coller ici</small>
              </div>
            )}
          </>
        )}
      </div>
    );
  }
  const done = tasks.filter((t) => t.done).length;
  return (
    <article className="lp-card" aria-label={name}>
      <button
        type="button"
        className="lp-cardhead"
        aria-label={name}
        aria-expanded={!folded}
        onClick={() => fold(!folded)}
      >
        <span className="lp-cardtitle">{name}</span>
        <span className="lp-fold" aria-hidden="true">
          {folded ? "+" : "−"}
        </span>
        <span className="lp-progress">
          <progress value={done} max={tasks.length} />
          <span>
            {done} / {tasks.length}
          </span>
        </span>
      </button>
      <div hidden={folded} className="lp-cardbody">
        {variant === "simple" && (
          <section className="lp-paper">
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
              {tasks.map((t) => (
                <div
                  className="lp-indexrow"
                  data-selected={t.id === selected}
                  data-done={t.done}
                  key={t.id}
                >
                  {checkbox(t)}
                  <button
                    type="button"
                    aria-pressed={t.id === selected}
                    onClick={() => select(t.id)}
                  >
                    {t.title}
                  </button>
                </div>
              ))}
              <AddTask
                add={(title) => add(title, tasks.find((t) => t.id === selected)?.phase ?? 0)}
              />
            </section>
          </div>
        )}
      </div>
    </article>
  );
}

function Board({ variant }: { variant: Variant }) {
  const [lists, setLists] = useState(() => projects.map((p) => p.tasks));
  const [selection, setSelection] = useState({ project: 0, id: 2 });
  const current = lists[selection.project].find((t) => t.id === selection.id)!;
  function update(index: number, tasks: Task[]) {
    setLists((prev) => prev.map((list, i) => (i === index ? tasks : list)));
  }
  function editDetail(values: Partial<Task>) {
    update(
      selection.project,
      lists[selection.project].map((t) => (t.id === current.id ? { ...t, ...values } : t)),
    );
  }
  return (
    <main className={"lp-board lp-" + variant}>
      <h1>
        Mes projets <span>{projects.length}</span>
      </h1>
      <div className="lp-layout">
        <div className="lp-rail" role="region" aria-label="Projets" tabIndex={0}>
          {projects.map((project, i) => (
            <ProjectColumn
              key={project.name}
              name={project.name}
              tasks={lists[i]}
              variant={variant}
              selected={selection.project === i ? selection.id : undefined}
              select={(id) => setSelection({ project: i, id })}
              update={(tasks) => update(i, tasks)}
            />
          ))}
        </div>
        {variant === "detail" && (
          <aside className="lp-detailpane" aria-label="Détail de la tâche">
            <div className="lp-eyebrow">
              {projects[selection.project].name} · {phases[current.phase]}
            </div>
            <EditableTitle task={current} save={(title) => editDetail({ title })} />
            <h2>Sous-tâches</h2>
            <Subtasks task={current} change={editDetail} />
          </aside>
        )}
      </div>
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
      if (
        step &&
        e.target instanceof HTMLElement &&
        e.target.closest(".lp-switch") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
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
            <Board variant={v} />
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
