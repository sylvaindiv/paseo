import { join } from "node:path";
import pino from "pino";
import { AgentStorage } from "./agent/agent-storage.js";

/** Run only after all old generation processes have disappeared. Never replay a turn. */
export async function markInterruptedDaemonTurns(home: string): Promise<void> {
  const storage = new AgentStorage(join(home, "agents"), pino({ enabled: false }));
  for (const agent of await storage.list()) {
    if (agent.lastStatus !== "running" && agent.lastStatus !== "initializing") continue;
    await storage.upsert({
      ...agent,
      lastStatus: "closed",
      lastError: "Tour interrompu lors du rétablissement de la connexion.",
      requiresAttention: true,
      attentionReason: "error",
      attentionTimestamp: new Date().toISOString(),
    });
  }
}
