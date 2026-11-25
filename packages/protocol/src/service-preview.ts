export function parseServicePreviewUrl(value: string): URL | null {
  const url = URL.parse(value);
  if (
    url?.protocol !== "http:" ||
    url.username ||
    url.password ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    return null;
  return url;
}

export const PREVIEW_PROXY_HEADER = "x-paseo-preview";

export function servicePreviewHeaders(raw: string[]): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  const connectionTokens = raw.flatMap((value, index) =>
    index % 2 === 0 && value.toLowerCase() === "connection"
      ? (raw[index + 1] ?? "")
          .toLowerCase()
          .split(",")
          .map((token) => token.trim())
      : [],
  );
  const ignored = new Set([
    ...connectionTokens,
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "proxy-authorization",
    "proxy-authenticate",
    "proxy-connection",
    "expect",
    PREVIEW_PROXY_HEADER,
  ]);
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index]!.toLowerCase();
    if (!ignored.has(name) && !name.startsWith("sec-websocket-")) {
      headers.push([name, raw[index + 1]!]);
    }
  }
  return headers;
}
