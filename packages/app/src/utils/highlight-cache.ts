import { highlightCode, type HighlightToken } from "@getpaseo/highlight";

// Shared, theme-independent tokenization + cache for syntax highlighting.
// Used by markdown code blocks, file preview, and tool-call detail blocks
// (Edit diff / Write / Read). Colors are applied at render time, so the cache
// key is just (extension, code) and one entry serves both light and dark.

export interface KeyedToken {
  key: string;
  token: HighlightToken;
}

export interface KeyedLine {
  key: string;
  tokens: KeyedToken[];
}

// Above this, highlighting a whole document on the main thread risks a visible
// stall when a large Read/Write block is expanded. Callers fall back to plain
// monospace text. Generous enough to cover the vast majority of real blocks.
export const MAX_HIGHLIGHT_CHARS = 100_000;

interface CachedTokens {
  lines: HighlightToken[][];
  bytes: number;
}

function estimateRetainedBytes(key: string, lines: HighlightToken[][], limit: number): number {
  // Include UTF-16 strings, tokens, line arrays and the cache entry. This is a
  // conservative budget, not a heap measurement; shared strings can be counted twice.
  let bytes = 64 + key.length * 2;
  if (bytes > limit) return bytes;
  for (const line of lines) {
    bytes += 64;
    if (bytes > limit) return bytes;
    for (const token of line) {
      bytes += 64 + token.text.length * 2 + (token.style?.length ?? 0) * 2;
      if (bytes > limit) return bytes;
    }
  }
  return bytes;
}

export class HighlightCache {
  private readonly map = new Map<string, CachedTokens>();
  private bytes = 0;
  private readonly maxBytes: number;

  constructor({ maxBytes = 8 * 1024 * 1024 } = {}) {
    this.maxBytes = maxBytes;
  }

  tokenizeToLines(code: string, ext: string | null): HighlightToken[][] | null {
    if (!ext || code.length > MAX_HIGHLIGHT_CHARS) return null;
    const key = `${ext}:${code}`;
    const cached = this.map.get(key);
    if (cached) {
      this.map.delete(key);
      this.map.set(key, cached);
      return cached.lines;
    }
    let lines: HighlightToken[][];
    try {
      lines = highlightCode(code, `x.${ext}`);
    } catch {
      return null;
    }
    const bytes = estimateRetainedBytes(key, lines, this.maxBytes);
    if (bytes > this.maxBytes) return lines;
    while (this.map.size >= 200 || this.bytes + bytes > this.maxBytes) {
      const oldest = this.map.entries().next().value;
      if (!oldest) break;
      this.map.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
    this.map.set(key, { lines, bytes });
    this.bytes += bytes;
    return lines;
  }
}

const tokenizationCache = new HighlightCache();

// Tokenize `code` to per-line tokens, cached. Returns null when the input is over
// the size cap or parsing throws — callers then render plain text.
export function tokenizeToLines(code: string, ext: string | null): HighlightToken[][] | null {
  return tokenizationCache.tokenizeToLines(code, ext);
}

function toKeyedLine(tokens: HighlightToken[], lineIndex: number): KeyedLine {
  return {
    key: `line-${lineIndex}`,
    tokens: tokens.map((token, tokenIndex) => ({
      key: `${lineIndex}-${tokenIndex}`,
      token,
    })),
  };
}

export function highlightToKeyedLines(code: string, ext: string | null): KeyedLine[] | null {
  const lines = tokenizeToLines(code, ext);
  return lines ? lines.map(toKeyedLine) : null;
}

// Extension for grammar selection from a file path. We only need the suffix —
// absolute vs relative paths are equivalent here.
export function extensionFromPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}
