/* oxlint-disable react-perf/jsx-no-new-function-as-prop -- Local form events. */
import { getPaseoClient, useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState, useMemo, useSyncExternalStore, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { captureReply, captureSession } from "../shared/task-capture.js";
import { addCapturedTasks, captureContext } from "./capture-tasks.js";
import { createFolderStore } from "./folder-store.js";
import { projects, initialBoard } from "./priority-prototype.js";
import { encodeImage } from "./folder-dispatch.js";

interface Line {
  id: string;
  kind: "you" | "answer";
  text: string;
}
function errorMessage(cause: unknown) {
  if (!(cause instanceof Error)) return "Envoi impossible.";
  if (cause instanceof SyntaxError || cause.name === "ZodError")
    return "Réponse illisible. Réessaie.";
  return cause.message;
}
const css = `
.taskCapture{position:fixed;inset:0 0 0 auto;margin:0;padding:0;width:min(410px,100vw);height:100dvh;max-height:100dvh;max-width:100vw;box-sizing:border-box;border:0;border-left:1px solid #dcdcd7;background:#fafaf9;color:#363631;font:14px/1.45 system-ui;box-shadow:-5px 0 28px #0001}
.taskCapture::backdrop{background:#25252136}
.taskCapture[open]{display:flex;flex-direction:column}
.taskCapture header,.taskCapture form,.taskCapture .target{padding:14px 18px}
.taskCapture header{border-bottom:1px solid #e4e4df;display:flex;align-items:center;justify-content:space-between}
.taskCapture h2{margin:0;font-size:17px;font-weight:620}
.taskCapture button,.taskCapture select,.taskCapture textarea{font:inherit;color:inherit}
.taskCapture button,.taskCapture select{cursor:pointer}
.taskCapture header button{border:0;background:none;font-size:21px}
.taskCapture .target{display:flex;gap:12px;align-items:center;font-size:13px}
.taskCapture select{flex:1;min-width:0;border:1px solid #dcdcd7;border-radius:5px;background:#fff;padding:6px}
.taskCapture .history{flex:1;overflow:auto;padding:0 18px}
.taskCapture .history p{white-space:pre-wrap;overflow-wrap:anywhere;padding:9px 12px;margin:8px 0;border-radius:7px}
.taskCapture .you{margin-left:20px!important;background:#e9eee9}
.taskCapture .answer{background:white}.taskCapture .status{color:#66645f}
.taskCapture form{border-top:1px solid #deded9;background:white}
.taskCapture textarea{width:100%;box-sizing:border-box;border:0;resize:vertical;min-height:65px;padding:6px}
.taskCapture .actions{display:flex;align-items:center;justify-content:space-between;gap:8px}
.taskCapture .send{border:0;border-radius:5px;padding:7px 13px;background:#3d5044;color:white}
.taskCapture .send:disabled{opacity:.5}
.taskCapture .attach{font-size:13px;cursor:pointer}.taskCapture .attach input{width:1px;opacity:0}
.taskCapture .files{font-size:12px;overflow-wrap:anywhere}
`;
export function TaskCapture({
  hostId,
  close,
}: {
  hostId: PluginHostProps["host"]["id"];
  close(): void;
}) {
  const rpc = useRpc(captureSession);
  const call = useRef(rpc);
  call.current = rpc;
  const id = useRef(crypto.randomUUID());
  const started = useRef(false);
  const alive = useRef(false);
  const locked = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const store = useMemo(() => createFolderStore(hostId, initialBoard), [hostId]);
  const saved = useSyncExternalStore(store.subscribe, store.get);
  const [project, setProject] = useState("");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const library = useRef<File[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    alive.current = true;
    const node = dialog.current;
    node?.showModal();
    node?.querySelector("textarea")?.focus();
    const sessionId = id.current;
    const archive = () => {
      alive.current = false;
      if (started.current) void call.current({ id: sessionId, action: "close" }).catch(() => {});
    };
    const timer = setInterval(() => {
      if (started.current) void call.current({ id: sessionId, action: "keep" }).catch(() => {});
    }, 25_000);
    window.addEventListener("pagehide", archive);
    return () => {
      window.removeEventListener("pagehide", archive);
      clearInterval(timer);
      archive();
      node?.close();
    };
  }, []);
  useEffect(() => {
    history.current?.scrollTo(0, history.current.scrollHeight);
  }, [lines, busy]);
  async function readReply(input: string, attachments: Awaited<ReturnType<typeof encodeImage>>[]) {
    const agent = getPaseoClient(hostId).agents.ref(id.current);
    let result = await agent.run(input, { images: attachments, timeoutMs: 60_000 });
    while (alive.current && result.status === "timeout") result = await agent.waitForFinish(60_000);
    if (!alive.current) return null;
    if (result.status !== "idle" || !result.lastMessage)
      throw new Error("L’agent n’a pas pu répondre.");
    return captureReply.parse(
      JSON.parse(
        result.lastMessage.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, ""),
      ),
    );
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    if (locked.current || !saved.ready || (!text.trim() && !files.length)) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const message = text.trim();
    const selected = project === "" ? null : Number(project);
    try {
      const attachments = await Promise.all(files.map(encodeImage));
      if (!alive.current) return;
      if (!started.current) {
        started.current = true;
        try {
          await rpc({ id: id.current, action: "open" });
        } catch (cause) {
          started.current = false;
          throw cause;
        }
      }
      if (!alive.current) return;
      const offset = library.current.length;
      library.current.push(...files);
      const input = JSON.stringify({
        projetChoisi: selected,
        tableau: captureContext(store.get().board),
        message,
        imagesJointes: files.map((f, i) => ({ index: offset + i, nom: f.name })),
      });
      setLines((l) => [
        ...l,
        {
          id: crypto.randomUUID(),
          kind: "you",
          text: [message, ...files.map((f) => f.name)].filter(Boolean).join("\n"),
        },
      ]);
      setText("");
      setFiles([]);
      const reply = await readReply(input, attachments);
      if (!reply) return;
      if (reply.tasks.length)
        await store.write((board) => addCapturedTasks(board, reply, selected, library.current));
      if (!alive.current) return;
      const response = reply.tasks.length
        ? reply.tasks.map((t) => projects[t.project].name + " · " + t.title).join("\n")
        : reply.message;
      setLines((l) => [
        ...l,
        {
          id: crypto.randomUUID(),
          kind: "answer",
          text: reply.tasks.length ? "Enregistré\n" + response : response,
        },
      ]);
    } catch (cause) {
      if (alive.current) {
        setText(message);
        setFiles(files);
        setError(errorMessage(cause));
      }
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function attach(newFiles: FileList) {
    const incoming = Array.from(newFiles).filter((file) => file.type.startsWith("image/"));
    setFiles((current) => [...current, ...incoming]);
  }
  return createPortal(
    <dialog
      className="taskCapture"
      ref={dialog}
      aria-labelledby="task-capture-heading"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right) close();
        }
      }}
    >
      <style>{css}</style>
      <header>
        <h2 id="task-capture-heading">Ajouter des tâches</h2>
        <button type="button" aria-label="Fermer la conversation" onClick={close}>
          ×
        </button>
      </header>
      <label className="target">
        Projet
        <select value={project} disabled={busy} onChange={(e) => setProject(e.target.value)}>
          <option value="">Préciser dans le message</option>
          {projects.map((p, i) => (
            <option key={p.name} value={i}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="history" ref={history} role="log">
        {lines.map((line) => (
          <p key={line.id} className={line.kind}>
            {line.text}
          </p>
        ))}
        {busy && <p className="status">En cours…</p>}
      </div>
      <form onSubmit={send}>
        {(error || saved.error) && <p role="alert">{error || saved.error}</p>}
        <textarea
          aria-label="Message"
          placeholder="Qu’y a-t-il à faire ?"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              attach(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {files.length > 0 && <p className="files">{files.map((f) => f.name).join(" · ")}</p>}
        <div className="actions">
          <label className="attach">
            ＋ Images
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={busy}
              onChange={(e) => {
                if (e.target.files) attach(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <button
            className="send"
            disabled={busy || !saved.ready || (!text.trim() && !files.length)}
            type="submit"
          >
            Envoyer
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
