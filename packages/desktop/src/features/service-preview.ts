import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { ipcMain, session, type WebContents } from "electron";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { PreviewOperation, PreviewResult } from "@getpaseo/protocol/messages";
import {
  parseServicePreviewUrl,
  PREVIEW_PROXY_HEADER,
  servicePreviewHeaders,
} from "@getpaseo/protocol/service-preview";

type Reply = PreviewResult | { kind: "error"; code: "upgrade" };
type Exchange = (operation: PreviewOperation) => Promise<Reply>;

const previews = new Map<
  string,
  {
    owner: WebContents;
    browserId: string;
    close(): void;
  }
>();
const pending = new Map<
  string,
  { owner: WebContents; previewId: string; reply(result: Reply): void }
>();
const expired = { kind: "error", code: "expired" } as const;

const ERRORS: Record<Extract<Reply, { kind: "error" }>["code"], string> = {
  upgrade: "Mets à jour Paseo sur le Mac mini",
  unavailable: "Le serveur de développement est arrêté.",
  expired: "Paseo est déconnecté. Réessaie.",
  denied: "Accès à l’aperçu refusé.",
  failed: "Impossible d’ouvrir l’aperçu.",
};

function fail(response: ServerResponse, result?: Reply) {
  response.writeHead(502, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(ERRORS[result?.kind === "error" ? result.code : "failed"]);
}

function requestPath(req: IncomingMessage, origin: URL, token: string): string | null {
  if (req.headers[PREVIEW_PROXY_HEADER] !== token || req.headers.host !== origin.host) return null;
  const raw = req.url ?? "";
  if (raw.startsWith("//")) return null;
  const url = URL.parse(raw, origin);
  if (url?.origin !== origin.origin || url.username || url.password) return null;
  return url.pathname + url.search;
}

async function proxyRequest(
  req: IncomingMessage,
  response: ServerResponse,
  path: string,
  exchange: Exchange,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) {
      response.writeHead(413, { connection: "close" }).end();
      return;
    }
    chunks.push(chunk);
  }
  const result = await exchange({
    kind: "http",
    method: req.method ?? "GET",
    path,
    headers: servicePreviewHeaders(req.rawHeaders),
    body: Buffer.concat(chunks).toString("base64"),
  });
  if (result.kind !== "http") return fail(response, result);
  response.writeHead(result.status, result.headers.flat());
  response.end(Buffer.from(result.body, "base64"));
}

async function proxyWebSocket(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  path: string,
  exchange: Exchange,
) {
  const socketId = randomUUID();
  const protocols = (req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const result = await exchange({
    kind: "ws-open",
    socketId,
    protocols,
    path,
    headers: servicePreviewHeaders(req.rawHeaders),
  });
  const close = () => void exchange({ kind: "ws-close", socketId });
  if (result.kind !== "ws-open" || socket.destroyed || !socket.writable) {
    if (result.kind === "ws-open") close();
    socket.destroy();
    return;
  }
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: () => result.protocol || false,
  });
  let upgraded = false;
  try {
    server.handleUpgrade(req, socket, head, (ws) => {
      upgraded = true;
      ws.on("error", () => ws.terminate());
      ws.once("close", close);
      let sending = Promise.resolve();
      let queued = 0;
      ws.on("message", (data: RawData, binary: boolean) => {
        if (++queued > 32) {
          ws.terminate();
          return;
        }
        const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
        sending = sending
          .then(async () => {
            if (ws.readyState !== WebSocket.OPEN) return undefined;
            const sent = await exchange({
              kind: "ws-send",
              socketId,
              frame: { binary, data: buffer.toString("base64") },
            });
            if (sent.kind !== "ok") ws.terminate();
            return undefined;
          })
          .finally(() => {
            queued--;
          });
      });
      void (async () => {
        try {
          while (ws.readyState === WebSocket.OPEN) {
            const next = await exchange({ kind: "ws-read", socketId });
            if (next.kind !== "ws-read" || ws.readyState !== WebSocket.OPEN) break;
            for (const frame of next.frames) {
              if (ws.bufferedAmount > 2 * 1024 * 1024) return;
              ws.send(Buffer.from(frame.data, "base64"), { binary: frame.binary });
            }
            if (next.closed) break;
          }
        } finally {
          ws.close();
        }
      })().catch(() => ws.terminate());
    });
  } finally {
    if (!upgraded) close();
  }
}

export function isServicePreviewPartition(
  partition: string | undefined,
  owner: WebContents,
  browserId?: string,
) {
  const preview = partition ? previews.get(partition) : undefined;
  return Boolean(
    preview && preview.owner === owner && (!browserId || preview.browserId === browserId),
  );
}

export function isServicePreviewGuest(contents: WebContents): boolean {
  for (const partition of previews.keys()) {
    if (contents.session === session.fromPartition(partition)) return true;
  }
  return false;
}

export function getServicePreviewSession(owner: WebContents, browserId: string) {
  for (const [partition, preview] of previews) {
    if (preview.owner === owner && preview.browserId === browserId)
      return session.fromPartition(partition);
  }
  return null;
}

export function closeServicePreview(owner: WebContents, browserId: string) {
  for (const preview of previews.values()) {
    if (preview.owner === owner && preview.browserId === browserId) preview.close();
  }
}

export function registerServicePreviewIpc(isHost: (owner: WebContents) => boolean) {
  ipcMain.on("paseo:preview:reply", (event, id: string, result: Reply) => {
    const request = pending.get(id);
    if (request?.owner === event.sender && event.senderFrame === event.sender.mainFrame) {
      request.reply(result);
    }
  });

  ipcMain.handle("paseo:preview:open", async (event, browserId: string, rawOrigin: string) => {
    const owner = event.sender;
    if (
      !isHost(owner) ||
      event.senderFrame !== owner.mainFrame ||
      typeof browserId !== "string" ||
      !/^[a-z\d-]{1,80}$/i.test(browserId) ||
      typeof rawOrigin !== "string"
    )
      throw new Error("Invalid preview");
    const origin = parseServicePreviewUrl(rawOrigin);
    if (!origin || rawOrigin !== origin.origin) throw new Error("Invalid preview origin");
    if (getServicePreviewSession(owner, browserId)) throw new Error("Preview already open");
    if ([...previews.values()].filter((preview) => preview.owner === owner).length >= 16)
      throw new Error("Too many previews");

    const token = randomUUID();
    const partition = `paseo-preview-${token}`;
    const browserSession = session.fromPartition(partition);
    let running = true;
    const exchange: Exchange = (operation) => {
      if (!running || owner.isDestroyed()) return Promise.resolve(expired);
      const id = randomUUID();
      let reply!: (result: Reply) => void;
      const promise = new Promise<Reply>((resolve) => {
        reply = resolve;
      });
      const timer = setTimeout(() => complete(expired), 27_000);
      function complete(result: Reply) {
        clearTimeout(timer);
        pending.delete(id);
        reply(result);
      }
      pending.set(id, { owner, previewId: partition, reply: complete });
      try {
        owner.send("paseo:preview:exchange", { browserId, id, operation });
      } catch {
        complete(expired);
      }
      return promise;
    };
    const server = createServer((req, response) => {
      const path = requestPath(req, origin, token);
      if (!path) {
        response.writeHead(403).end();
        return;
      }
      void proxyRequest(req, response, path, exchange).catch(() => {
        if (!response.headersSent) fail(response);
        else response.destroy();
      });
    });
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      if (sockets.has(socket)) return;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    const tunneled = new WeakSet<Socket>();
    server.on("connect", (req, stream, head) => {
      const socket = stream as Socket;
      const expected = `${origin.hostname}:${origin.port || 80}`;
      if (req.url !== expected || tunneled.has(socket)) {
        socket.destroy();
        return;
      }
      // Chromium can tunnel a WebSocket handshake through its HTTP proxy.
      // Feed the handshake back to this same HTTP parser and verify the secret there.
      tunneled.add(socket);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.pause();
      if (head.length) socket.unshift(head);
      server.emit("connection", socket);
      socket.resume();
    });
    server.on("upgrade", (req, stream, head) => {
      const socket = stream as Socket;
      socket.on("error", () => socket.destroy());
      const path = requestPath(req, origin, token);
      if (!path || req.headers.upgrade?.toLowerCase() !== "websocket") {
        socket.destroy();
        return;
      }
      void proxyWebSocket(req, socket, head, path, exchange).catch(() => socket.destroy());
    });
    const close = () => {
      if (!running) return;
      running = false;
      previews.delete(partition);
      owner.removeListener("destroyed", close);
      owner.removeListener("did-start-navigation", onNavigation);
      for (const request of pending.values()) {
        if (request.previewId === partition) request.reply(expired);
      }
      for (const socket of sockets) socket.destroy();
      server.close();
      void browserSession.clearStorageData().catch(() => undefined);
    };
    const onNavigation = (
      _event: unknown,
      _url: string,
      isSameDocument: boolean,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame && !isSameDocument) close();
    };
    previews.set(partition, { owner, browserId, close });
    owner.on("did-start-navigation", onNavigation);
    owner.once("destroyed", close);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Preview proxy unavailable");
      browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const url = URL.parse(details.url.replace(/^ws:/, "http:"));
        const requestHeaders = details.requestHeaders;
        if (url?.origin === origin.origin) requestHeaders[PREVIEW_PROXY_HEADER] = token;
        callback({ requestHeaders });
      });
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      browserSession.setPermissionCheckHandler(() => false);
      await browserSession.setProxy({
        mode: "fixed_servers",
        proxyRules: `127.0.0.1:${address.port}`,
        proxyBypassRules: "<-loopback>",
      });
      if (!running) throw new Error("Preview closed");
      return partition;
    } catch (error) {
      close();
      throw error;
    }
  });
  ipcMain.handle("paseo:preview:close", (event, browserId: string) => {
    if (event.senderFrame === event.sender.mainFrame) closeServicePreview(event.sender, browserId);
  });
}
