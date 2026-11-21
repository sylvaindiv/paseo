import type { PluginLocalStorage } from "@getpaseo/plugin/client";
import { z } from "zod";

const preferencesSchema = z.object({
  order: z.array(z.string()),
  collapsed: z.array(z.string()),
  next: z.record(z.string(), z.array(z.string())).default({}),
  finished: z.array(z.string()).default([]),
});

export type ProjectPreferences = z.infer<typeof preferencesSchema>;

const KEY = "projects-view-v1";
const defaults = preferencesSchema.parse({ order: [], collapsed: [] });

export function createProjectPreferences(storage: PluginLocalStorage) {
  let pending = Promise.resolve();

  async function read(): Promise<ProjectPreferences> {
    const raw = await storage.getItem(KEY);
    if (raw === null) return defaults;
    try {
      const parsed = preferencesSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : defaults;
    } catch {
      return defaults;
    }
  }

  async function write(
    waitFor: Promise<void>,
    update: (current: ProjectPreferences) => ProjectPreferences,
  ) {
    await waitFor;
    const next = update(await read());
    await storage.setItem(KEY, JSON.stringify(next));
    return next;
  }

  return {
    load: () => pending.then(read),
    save(update: (current: ProjectPreferences) => ProjectPreferences) {
      const save = write(pending, update);
      pending = save.then(
        () => undefined,
        () => undefined,
      );
      return save;
    },
  };
}

export function mergeProjectOrder(saved: string[], current: string[]): string[] {
  return [...new Set([...saved, ...current])];
}

export function moveProject(
  order: string[],
  visible: string[],
  key: string,
  target: string,
): string[] {
  const visibleSet = new Set(visible);
  const next = mergeProjectOrder(order, visible);
  const active = next.filter((id) => visibleSet.has(id));
  const from = active.indexOf(key);
  const to = active.indexOf(target);
  if (from < 0 || to < 0 || from === to) return next;
  active.splice(to, 0, active.splice(from, 1)[0]!);
  let index = 0;
  return next.map((id) => (visibleSet.has(id) ? active[index++]! : id));
}
