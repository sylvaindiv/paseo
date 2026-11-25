import http from "node:http";
import type { LookupFunction } from "node:net";
import { WebSocket, type RawData } from "ws";
import type { PreviewOperation, PreviewResult } from "@getpaseo/protocol/messages";
import { parseServicePreviewUrl, servicePreviewHeaders } from "@getpaseo/protocol/service-preview";

interface Frame {
  binary: boolean;
  data: string;
}
interface PreviewSocket {
  ws: WebSocket;
  frames: Frame[];
  size: number;
  notify?: () => void;
}

const OK = { kind: "ok" } as const;
const EXPIRED = { kind: "error", code: "expired" } as const;
const FAILED = { kind: "error", code: "failed" } as const;
const UNAVAILABLE = { kind: "error", code: "unavailable" } as const;
const MAX_HTTP_BODY = 16 * 1024 * 1024;
const MAX_WS_BUFFER = 2 * 1024 * 1024;

function targetPath(path: string): boolean {
  return /^\/(?![/\\])[!-~]*$/.test(path);
}

// Return both loopback addresses for localhost without trusting DNS or /etc/hosts.
const lookupLoopback: LookupFunction = (_hostname, options, callback) => {
  const addresses = [
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ];
  if (options.all) callback(null, addresses);
  else callback(null, addresses[0]!.address, addresses[0]!.family);
};

function isUnavailable(error: unknown): boolean {
  return ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"].includes(
    (error as NodeJS.ErrnoException | undefined)?.code ?? "",
  );
}

class ServicePreview {
  private readonly controller = new AbortController();
  private readonly sockets = new Map<string, PreviewSocket>();
  private activeRequests = 0;

  constructor(readonly origin: URL) {}

  close() {
    this.controller.abort();
    for (const socket of this.sockets.values()) socket.ws.terminate();
    this.sockets.clear();
  }

  async exchange(
    operation: Exclude<PreviewOperation, { kind: "open" | "close" }>,
  ): Promise<PreviewResult> {
    switch (operation.kind) {
      case "http":
        if (!targetPath(operation.path) || this.activeRequests >= 24) return FAILED;
        this.activeRequests++;
        try {
          return await this.request(operation);
        } finally {
          this.activeRequests--;
        }
      case "ws-open":
        if (
          !targetPath(operation.path) ||
          this.sockets.has(operation.socketId) ||
          this.sockets.size >= 8
        )
          return FAILED;
        return this.openSocket(operation);
      case "ws-read":
        return this.readSocket(operation.socketId);
      case "ws-send": {
        const ws = this.sockets.get(operation.socketId)?.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return EXPIRED;
        if (ws.bufferedAmount > MAX_WS_BUFFER) return FAILED;
        const error = await new Promise<Error | undefined>((resolve) => {
          ws.send(
            Buffer.from(operation.frame.data, "base64"),
            { binary: operation.frame.binary },
            resolve,
          );
        });
        return error ? FAILED : OK;
      }
      case "ws-close":
        this.sockets.get(operation.socketId)?.ws.terminate();
        this.sockets.delete(operation.socketId);
        return OK;
    }
  }

  private request(operation: Extract<PreviewOperation, { kind: "http" }>): Promise<PreviewResult> {
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(operation.method)) {
      return Promise.resolve(FAILED);
    }
    const body = Buffer.from(operation.body, "base64");
    const headers = servicePreviewHeaders(operation.headers.flat())
      .filter(([name]) => name !== "content-length")
      .flat();
    headers.push("host", this.origin.host);
    if (
      body.length ||
      operation.method === "POST" ||
      operation.method === "PUT" ||
      operation.method === "PATCH"
    )
      headers.push("content-length", String(body.length));
    return new Promise((resolve) => {
      const request = http.request(
        {
          hostname: this.origin.hostname.replace(/^\[|\]$/g, ""),
          lookup: lookupLoopback,
          port: this.origin.port || 80,
          method: operation.method,
          path: operation.path,
          headers,
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(18_000)]),
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_HTTP_BODY) {
              resolve(FAILED);
              response.destroy();
            } else chunks.push(chunk);
          });
          response.on("error", () => resolve(FAILED));
          response.on("end", () =>
            resolve({
              kind: "http",
              status: response.statusCode ?? 502,
              headers: servicePreviewHeaders(response.rawHeaders),
              body: Buffer.concat(chunks).toString("base64"),
            }),
          );
        },
      );
      request.on("error", (error) => resolve(isUnavailable(error) ? UNAVAILABLE : FAILED));
      request.end(body);
    });
  }

  private openSocket(
    operation: Extract<PreviewOperation, { kind: "ws-open" }>,
  ): Promise<PreviewResult> {
    const url = `ws://${this.origin.host}${operation.path}`;
    const ws = new WebSocket(url, operation.protocols, {
      headers: {
        ...Object.fromEntries(servicePreviewHeaders(operation.headers.flat())),
        host: this.origin.host,
      },
      handshakeTimeout: 8_000,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
      lookup: lookupLoopback,
    });
    const socket: PreviewSocket = { ws, frames: [], size: 0 };
    this.sockets.set(operation.socketId, socket);
    ws.on("message", (data: RawData, binary: boolean) => {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      socket.size += buffer.length;
      if (socket.size > MAX_WS_BUFFER || socket.frames.length >= 128) {
        ws.terminate();
        return;
      }
      socket.frames.push({ binary, data: buffer.toString("base64") });
      socket.notify?.();
    });
    return new Promise<PreviewResult>((resolve) => {
      ws.once("open", () => resolve({ kind: "ws-open", protocol: ws.protocol }));
      ws.on("error", (error) => resolve(isUnavailable(error) ? UNAVAILABLE : FAILED));
      ws.once("close", () => {
        socket.notify?.();
        resolve(FAILED);
      });
    }).then((result) => {
      if (result.kind !== "ws-open") this.sockets.delete(operation.socketId);
      return result;
    });
  }

  private async readSocket(socketId: string): Promise<PreviewResult> {
    const socket = this.sockets.get(socketId);
    if (!socket) return EXPIRED;
    if (socket.notify) return FAILED;
    if (!socket.frames.length && socket.ws.readyState === WebSocket.OPEN) {
      let notify!: () => void;
      const update = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const timer = setTimeout(notify, 12_000);
      socket.notify = notify;
      await update;
      clearTimeout(timer);
      socket.notify = undefined;
    }
    const closed = socket.ws.readyState !== WebSocket.OPEN;
    const frames = socket.frames.splice(0);
    socket.size = 0;
    if (closed) this.sockets.delete(socketId);
    return { kind: "ws-read", frames, closed };
  }
}

export class ServicePreviewSession {
  private readonly sources = new Map<object, Map<string, ServicePreview>>();

  attach(source: object) {
    if (!this.sources.has(source)) this.sources.set(source, new Map());
  }

  detach(source: object) {
    for (const preview of this.sources.get(source)?.values() ?? []) preview.close();
    this.sources.delete(source);
  }

  close() {
    for (const source of this.sources.keys()) this.detach(source);
  }

  async exchange(source: object, id: string, operation: PreviewOperation): Promise<PreviewResult> {
    const previews = this.sources.get(source);
    if (!previews) return EXPIRED;
    const preview = previews.get(id);
    if (operation.kind === "open") {
      const origin = parseServicePreviewUrl(operation.origin);
      if (!origin || origin.origin !== operation.origin) return FAILED;
      if (preview) return preview.origin.origin === origin.origin ? OK : FAILED;
      if (previews.size >= 16) return FAILED;
      previews.set(id, new ServicePreview(origin));
      return OK;
    }
    if (!preview) return EXPIRED;
    if (operation.kind === "close") {
      preview.close();
      previews.delete(id);
      return OK;
    }
    try {
      return await preview.exchange(operation);
    } catch {
      return FAILED;
    }
  }
}
