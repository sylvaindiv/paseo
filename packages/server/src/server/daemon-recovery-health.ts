import { networkInterfaces } from "node:os";
import { getPidLockInfo, isSamePidLock } from "./pid-lock.js";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { buildDaemonWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { readLocalCredentialForTarget } from "./local-credential.js";

/** Local transport only; never consult relay or provider status for liveness. */
export async function withLocalDaemon<T>(
  home: string,
  listen: string,
  action: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  let socketPath: string | undefined;
  let url: string;
  if (listen.startsWith("unix://") || listen.startsWith("/")) {
    socketPath = listen.replace(/^unix:\/\//, "");
    url = "ws://localhost/ws";
  } else {
    const local = listen.replace(/^tcp:\/\//, "");
    const endpoint = local.replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "[::1]:");
    const host = new URL(`ws://${endpoint}`).hostname.replace(/^\[|\]$/g, "");
    const localAddresses = new Set([
      "localhost",
      "127.0.0.1",
      "::1",
      ...Object.values(networkInterfaces()).flatMap(
        (interfaces) => interfaces?.map((entry) => entry.address) ?? [],
      ),
    ]);
    if (!localAddresses.has(host)) throw new Error("Recovery requires a local transport");
    url = buildDaemonWebSocketUrl(endpoint, { useTls: false });
  }
  const instance = await getPidLockInfo(home);
  if (!instance?.serverId || instance.listen !== listen)
    throw Object.assign(new Error("Local daemon endpoint is not ready"), {
      code: "DAEMON_NOT_READY",
    });
  const client = new DaemonClient({
    url,
    clientId: `recovery-${randomUUID()}`,
    clientType: "cli",
    appVersion: "0.11.1",
    localCredential: () => readLocalCredentialForTarget(home, listen) ?? undefined,
    connectTimeoutMs: 2_000,
    reconnect: { enabled: false },
    webSocketFactory: (target, options) =>
      new WebSocket(target, options?.protocols, {
        headers: options?.headers,
        socketPath,
      }) as unknown as WebSocketLike,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const current = await getPidLockInfo(home);
    if (!current || !isSamePidLock(instance, current) || current.listen !== listen)
      throw Object.assign(new Error("Local daemon instance changed"), { code: "DAEMON_REPLACED" });
    if (client.getLastServerInfoMessage()?.serverId !== instance.serverId)
      throw Object.assign(new Error("Local daemon peer identity changed"), {
        code: "DAEMON_PEER_CHANGED",
      });
    return await action(client);
  } catch (error) {
    if (!connected && error instanceof Error && error.name !== "DaemonAuthenticationError") {
      throw Object.assign(error, { code: "DAEMON_UNREACHABLE" });
    }
    throw error;
  } finally {
    await client.close();
  }
}
