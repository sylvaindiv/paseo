import { LRUCache } from "lru-cache";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import type { CheckoutDiffCompare, CheckoutDiffResult } from "../utils/checkout-git.js";

interface ActiveRead {
  promise: Promise<CheckoutDiffResult>;
  invalidated: boolean;
}

interface CachedDiff {
  value: CheckoutDiffResult;
  loadedAt: number;
  lastReadStarted: number;
}

interface CheckoutDiffReadInput {
  cwd: string;
  compare: CheckoutDiffCompare;
  force?: boolean;
  reason?: string;
  load: () => Promise<CheckoutDiffResult>;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

function estimateRetainedBytes(key: string, value: CheckoutDiffResult, limit: number): number {
  // Conservative UTF-16 text and object/array overhead, without copying the payload.
  // Stop walking as soon as the result cannot fit, including highly tokenized diffs.
  let bytes = 128 + key.length * 2 + value.diff.length * 2;
  if (bytes > limit) return bytes;
  for (const file of value.structured ?? []) {
    bytes += estimateFileRetainedBytes(file, limit - bytes);
    if (bytes > limit) return bytes;
  }
  return bytes;
}

function estimateFileRetainedBytes(file: ParsedDiffFile, limit: number): number {
  let bytes = 128 + file.path.length * 2 + (file.oldPath?.length ?? 0) * 2;
  if (bytes > limit) return bytes;
  for (const hunk of file.hunks) {
    bytes += 64;
    if (bytes > limit) return bytes;
    for (const line of hunk.lines) {
      bytes += 64 + line.content.length * 2;
      if (bytes > limit) return bytes;
      for (const token of line.tokens ?? []) {
        bytes += 64 + token.text.length * 2 + (token.style?.length ?? 0) * 2;
        if (bytes > limit) return bytes;
      }
    }
  }
  return bytes;
}

/** Completed payloads are bounded; active work survives invalidation and eviction. */
export class CheckoutDiffCache {
  private readonly values: LRUCache<string, CachedDiff>;
  private readonly maxBytes: number;
  private readonly active = new Map<string, ActiveRead>();

  constructor(
    private readonly now: () => number,
    { maxBytes = DEFAULT_MAX_BYTES } = {},
  ) {
    this.maxBytes = maxBytes;
    this.values = new LRUCache({ max: 64, maxSize: maxBytes });
  }

  read(input: CheckoutDiffReadInput): Promise<CheckoutDiffResult> {
    const { cwd, compare, force, reason, load } = input;
    if (force && !reason) throw new Error("WorkspaceGitService forced read requires a reason");
    const key = JSON.stringify([
      cwd,
      compare.mode,
      compare.mode === "base" ? (compare.baseRef ?? null) : null,
      compare.ignoreWhitespace === true,
      compare.includeStructured === true,
    ]);
    const cached = this.values.get(key);
    const now = this.now();
    if (
      !force &&
      cached &&
      (now - cached.loadedAt <= 15_000 || now - cached.lastReadStarted < 2_000)
    )
      return Promise.resolve(cached.value);
    const pending = this.active.get(key);
    if (pending) {
      if (force) {
        pending.invalidated = true;
        this.values.delete(key);
      }
      if (!pending.invalidated) return pending.promise;
      // A caller arriving after a change needs a fresh read, once the old one
      // finishes. The original caller can still receive its snapshot promptly.
      // The older result cannot enter the cache. Drop force when retrying so
      // callers waiting on that same result share the next fresh build.
      const reload = () => this.read({ ...input, force: false });
      return pending.promise.then(reload, reload);
    }
    if (cached) cached.lastReadStarted = now;

    // Defer load until ownership is installed, including synchronous invalidations.
    const read: ActiveRead = {
      invalidated: false,
      promise: Promise.resolve()
        .then(load)
        .then((value) => {
          // Never repopulate the cache with a snapshot invalidated during its build.
          if (!read.invalidated) {
            const size = estimateRetainedBytes(key, value, this.maxBytes);
            if (size <= this.maxBytes) {
              this.values.set(key, { value, loadedAt: this.now(), lastReadStarted: now }, { size });
            } else {
              this.values.delete(key);
            }
          }
          return value;
        })
        .finally(() => this.active.delete(key)),
    };
    this.active.set(key, read);
    return read.promise;
  }

  invalidate(cwd: string, mode: CheckoutDiffCompare["mode"]): void {
    for (const key of new Set([...this.values.keys(), ...this.active.keys()])) {
      const [cachedCwd, cachedMode] = JSON.parse(key) as string[];
      if (cachedCwd !== cwd || cachedMode !== mode) continue;
      this.values.delete(key);
      const pending = this.active.get(key);
      if (pending) pending.invalidated = true;
    }
  }
}
