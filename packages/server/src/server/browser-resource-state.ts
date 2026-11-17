import { z } from "zod";
import {
  selectBrowserResourceStops,
  BROWSER_RESOURCE_LIMITS,
  type BrowserResourceLimits,
  type BrowserProcessIdentity,
} from "./browser-resource-guard.js";

const identity = z.object({
  pid: z.number().int().min(2),
  startedAt: z.string().regex(/^\d+:\d+$/),
});
export const browserProcessSchema = identity.extend({
  parent: z.number().int().nonnegative(),
  bytes: z.number().nonnegative().finite(),
  measured: z.boolean(),
  browser: z.boolean(),
  installation: z.string(),
  owner: z.string(),
  namespace: z.string(),
  session: z.string(),
});
export type BrowserProcess = z.infer<typeof browserProcessSchema>;
export const browserOwnerSchema = z.object({
  installation: z.string().regex(/^[a-f0-9]{16}$/),
  owner: z.string().min(1),
  namespace: z.string().regex(/^p-[a-f0-9]{16}$/),
  session: z.string().regex(/^[at]-[a-f0-9]{12}$/),
  closed: z.boolean(),
  lastActiveAt: z.number().finite(),
});
export type BrowserOwner = z.infer<typeof browserOwnerSchema>;
export const browserLeaseSchema = z.object({
  daemon: identity,
  owners: z.array(browserOwnerSchema),
});
export const browserRegistrySchema = z.array(
  z.object({
    id: z.string(),
    installation: z.string(),
    owner: z.string(),
    lastActiveAt: z.number().finite(),
    closed: z.boolean(),
    root: identity,
    ownerProcess: identity.nullable(),
    members: z.array(identity),
  }),
);
export type BrowserRegistration = z.infer<typeof browserRegistrySchema>[number];
export interface BrowserDecision {
  registration: BrowserRegistration;
  bytes: number;
  reason: "owner_closed" | "owner_idle" | "memory";
}
const key = (p: BrowserProcessIdentity) => `${p.pid}/${p.startedAt}`;
export const browserOwnerKey = (p: Pick<BrowserOwner, "installation" | "owner">) =>
  `${p.installation}/${p.owner}`;

/** Rebuild membership from kernel identities, preserving attribution across reparenting. */
export function reconcileBrowsers(
  previous: readonly BrowserRegistration[],
  processes: readonly BrowserProcess[],
  owners: readonly BrowserOwner[],
  now: number,
  limits: BrowserResourceLimits = BROWSER_RESOURCE_LIMITS,
): { registry: BrowserRegistration[]; stops: BrowserDecision[]; unknown: number } {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const byIdentity = new Map(processes.map((p) => [key(p), p]));
  const known = new Map(owners.map((o) => [browserOwnerKey(o), o]));
  const registry = previous
    .map((r) => ({ ...r, members: r.members.filter((p) => byIdentity.has(key(p))) }))
    .filter((r) => r.members.length > 0);
  const assigned = new Map(registry.flatMap((r) => r.members.map((p) => [key(p), r] as const)));
  let unknown = 0;
  for (const process of processes) {
    if (!process.browser || assigned.has(key(process))) continue;
    let candidate: BrowserProcess | undefined = process;
    let owner: BrowserOwner | undefined;
    let ownerProcess: BrowserProcessIdentity | null = null;
    const visited = new Set<number>();
    while (candidate && !visited.has(candidate.pid)) {
      visited.add(candidate.pid);
      const match =
        known.get(browserOwnerKey(candidate)) ??
        owners.find(
          (o) =>
            candidate && candidate.namespace === o.namespace && candidate.session === o.session,
        );
      if (match) {
        owner ??= match;
        if (!candidate.browser && browserOwnerKey(match) === browserOwnerKey(owner))
          ownerProcess = { pid: candidate.pid, startedAt: candidate.startedAt };
      }
      candidate = byPid.get(candidate.parent);
    }
    if (!owner) {
      unknown++;
      continue;
    }
    const registration: BrowserRegistration = {
      id: key(process),
      installation: owner.installation,
      owner: owner.owner,
      lastActiveAt: owner.lastActiveAt,
      closed: owner.closed,
      root: { pid: process.pid, startedAt: process.startedAt },
      ownerProcess,
      members: [{ pid: process.pid, startedAt: process.startedAt }],
    };
    registry.push(registration);
    assigned.set(key(process), registration);
  }
  // Resolve ancestry independently of process enumeration order.
  for (const process of processes) {
    if (assigned.has(key(process))) continue;
    let candidate = byPid.get(process.parent);
    const visited = new Set<number>([process.pid]);
    while (candidate && !visited.has(candidate.pid)) {
      visited.add(candidate.pid);
      const registration = assigned.get(key(candidate));
      if (registration) {
        registration.members.push({ pid: process.pid, startedAt: process.startedAt });
        assigned.set(key(process), registration);
        break;
      }
      candidate = byPid.get(candidate.parent);
    }
  }
  const memory = new Map(
    registry.map((r) => [
      r.id,
      r.members.reduce((total, p) => total + byIdentity.get(key(p))!.bytes, 0),
    ]),
  );
  const samples = registry.map((r) => {
    const owner = known.get(browserOwnerKey(r));
    if (owner) {
      r.lastActiveAt = owner.lastActiveAt;
      r.closed = owner.closed;
    }
    return {
      id: r.id,
      bytes: memory.get(r.id)!,
      ownerClosed: r.closed,
      ownerLastActiveAt: r.lastActiveAt,
    };
  });
  const selected = selectBrowserResourceStops(samples, now, limits);
  return {
    registry,
    unknown,
    stops: selected.map((s) => ({
      registration: registry.find((r) => r.id === s.id)!,
      bytes: memory.get(s.id)!,
      reason: s.reason,
    })),
  };
}
