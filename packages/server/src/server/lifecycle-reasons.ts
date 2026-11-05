export const CLIENT_SHUTDOWN_RPC_REASON = "client_shutdown_rpc";
export const DEFAULT_CLIENT_RESTART_RPC_REASON = "client_restart_rpc";

export function normalizeClientRestartRpcReason(reason: string | undefined): string {
  return reason?.trim() || DEFAULT_CLIENT_RESTART_RPC_REASON;
}

export class DaemonBusyError extends Error {
  readonly code = "DAEMON_BUSY";
  constructor() {
    super("Un agent travaille encore.");
    this.name = "DaemonBusyError";
  }
}
