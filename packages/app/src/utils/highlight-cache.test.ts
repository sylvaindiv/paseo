import { describe, expect, it } from "vitest";
import {
  extensionFromPath,
  HighlightCache,
  highlightToKeyedLines,
  MAX_HIGHLIGHT_CHARS,
  tokenizeToLines,
} from "./highlight-cache";

describe("extensionFromPath", () => {
  it("extracts a lowercased extension regardless of absolute/relative path", () => {
    expect(extensionFromPath("/repo/src/Index.TS")).toBe("ts");
    expect(extensionFromPath("src/index.ts")).toBe("ts");
    expect(extensionFromPath("a.b/c.tsx")).toBe("tsx");
  });

  it("returns null for paths without a usable extension", () => {
    expect(extensionFromPath(null)).toBeNull();
    expect(extensionFromPath(undefined)).toBeNull();
    expect(extensionFromPath("Makefile")).toBeNull();
    expect(extensionFromPath(".gitignore")).toBeNull();
    expect(extensionFromPath("trailingdot.")).toBeNull();
  });
});

describe("tokenizeToLines", () => {
  it("returns one token array per line for a supported language", () => {
    const lines = tokenizeToLines("const a = 1;\nconst b = 2;", "ts");
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(2);
    expect(lines?.[0].some((token) => token.style === "keyword")).toBe(true);
  });

  it("returns null when there is no extension", () => {
    expect(tokenizeToLines("whatever", null)).toBeNull();
  });

  it("falls back to style-less per-line tokens for an unknown extension", () => {
    const lines = tokenizeToLines("line one\nline two", "unknownext");
    expect(lines).toHaveLength(2);
    expect(lines?.[0]).toEqual([{ text: "line one", style: null }]);
  });

  it("returns null above the size cap so callers fall back to plain text", () => {
    const huge = "x".repeat(MAX_HIGHLIGHT_CHARS + 1);
    expect(tokenizeToLines(huge, "ts")).toBeNull();
  });

  it("serves a cached result on repeat calls (identity-stable)", () => {
    const first = tokenizeToLines("const cached = true;", "ts");
    const second = tokenizeToLines("const cached = true;", "ts");
    expect(first).toBe(second);
  });

  it("evicts the least recently used result when the retained byte budget fills", () => {
    const cache = new HighlightCache({ maxBytes: 2_300 });
    const first = cache.tokenizeToLines("a".repeat(200), "cachetxt");
    const second = cache.tokenizeToLines("b".repeat(200), "cachetxt");
    expect(cache.tokenizeToLines("a".repeat(200), "cachetxt")).toBe(first);
    const third = cache.tokenizeToLines("c".repeat(200), "cachetxt");
    expect(cache.tokenizeToLines("a".repeat(200), "cachetxt")).toBe(first);
    expect(cache.tokenizeToLines("c".repeat(200), "cachetxt")).toBe(third);
    expect(cache.tokenizeToLines("b".repeat(200), "cachetxt")).not.toBe(second);
  });

  it("returns oversized tokenized results intact without retaining them or evicting other entries", () => {
    const cache = new HighlightCache({ maxBytes: 2_300 });
    const small = cache.tokenizeToLines("small", "cachetxt");
    // Short text can still retain many arrays and tokens.
    const code = Array.from({ length: 50 }, () => "x").join("\n");
    const first = cache.tokenizeToLines(code, "cachetxt");
    expect(first).toEqual(Array.from({ length: 50 }, () => [{ text: "x", style: null }]));
    expect(cache.tokenizeToLines(code, "cachetxt")).not.toBe(first);
    expect(cache.tokenizeToLines("small", "cachetxt")).toBe(small);
  });

  it("still limits the number of small entries", () => {
    const cache = new HighlightCache();
    const first = cache.tokenizeToLines("first", "cachetxt");
    for (let index = 0; index < 200; index++) {
      cache.tokenizeToLines(String(index), "cachetxt");
    }
    expect(cache.tokenizeToLines("first", "cachetxt")).not.toBe(first);
  });
});

describe("highlightToKeyedLines", () => {
  it("produces stable keys for lines and tokens", () => {
    const keyed = highlightToKeyedLines("const a = 1;", "ts");
    expect(keyed?.[0].key).toBe("line-0");
    expect(keyed?.[0].tokens[0].key).toBe("0-0");
  });

  it("returns null when highlighting is unavailable", () => {
    expect(highlightToKeyedLines("text", null)).toBeNull();
  });
});
