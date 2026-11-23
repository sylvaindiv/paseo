import type { FolderPhase } from "./folder-phase-board.js";
import type { Task } from "./priority-prototype.js";

export interface FolderBoard {
  projectStatuses?: Record<string, string>;
  items: Task[];
  recordedCaptures?: Record<string, string>;
  phases: FolderPhase[][];
}
type Edit = (board: FolderBoard) => FolderBoard;

// Each window applies its edit to the latest committed board. File objects survive a reload.
export function createFolderStore(host: string, initial: FolderBoard) {
  let database: Promise<IDBDatabase> | undefined;
  let channel: BroadcastChannel | undefined;
  const listeners = new Set<() => void>();
  const pending: Edit[] = [];
  let committed = initial;
  let ready = false;
  let error = "";
  let snapshot = { board: initial, ready, error };
  function notify() {
    snapshot = { board: pending.reduce((board, edit) => edit(board), committed), ready, error };
    for (const listener of listeners) listener();
  }
  function connect() {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("projets-dossiers", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("boards");
      request.onsuccess = () => resolve(request.result);
      request.addEventListener("error", () => reject(request.error));
    });
    return database;
  }
  async function transaction(edit?: Edit) {
    const db = await connect();
    return new Promise<FolderBoard>((resolve, reject) => {
      const tx = db.transaction("boards", edit ? "readwrite" : "readonly");
      const table = tx.objectStore("boards");
      const request = table.get(host);
      let result: FolderBoard;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const before: FolderBoard = request.result ?? initial;
          result = edit ? edit(before) : before;
          if (edit && result !== before) table.put(result, host);
        } catch (cause) {
          failure = cause;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        committed = result;
        ready = true;
        resolve(result);
      };
      tx.addEventListener("abort", () => reject(failure ?? tx.error));
      tx.addEventListener("error", () => reject(tx.error));
    });
  }
  async function refresh() {
    try {
      await transaction();
    } catch {
      error = "Dossiers indisponible. Rouvre la page.";
    }
    notify();
  }
  async function write(edit: Edit, optimistic = false) {
    if (optimistic) {
      pending.push(edit);
      notify();
    }
    try {
      const result = await transaction(edit);
      error = "";
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel is same-origin.
      channel?.postMessage(host);
      return result;
    } catch (cause) {
      if (optimistic) error = "Modification non enregistrée. Réessaie.";
      throw cause;
    } finally {
      if (optimistic) pending.splice(pending.indexOf(edit), 1);
      notify();
    }
  }
  return {
    get: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        channel = new BroadcastChannel("projets-dossiers");
        channel.addEventListener("message", (event) => {
          if (event.data === host) void refresh();
        });
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          channel?.close();
          channel = undefined;
        }
      };
    },
    edit: (edit: Edit) => {
      void write(edit, true).catch(() => {});
    },
    write,
  };
}
export type FolderStore = ReturnType<typeof createFolderStore>;
