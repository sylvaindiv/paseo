import { mkdir } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type { PluginServerContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  captureInstructions,
  captureProfile,
  captureSession,
  captureSettings,
} from "../shared/task-capture.js";

type Api = PluginHandlerContext["paseo"];
type Agent = ReturnType<Api["agents"]["ref"]>;

export function registerTaskCapture(server: PluginServerContext) {
  const settings = server.registerSettings(captureSettings);
  const sessions = new Map<
    string,
    { agent: Promise<Agent>; expires: number; closing?: Promise<void> }
  >();
  async function open(id: string, api: Api) {
    const config = await settings.read();
    if (config.status !== "ready") throw new Error("Profil d’ajout indisponible.");
    const { profileId } = config.values;
    const profiles = (await api.config.get()).config.agentProfiles ?? [];
    const profile =
      profiles.find((p) => p.id === profileId) ??
      (profileId === captureProfile.id ? captureProfile : undefined);
    if (!profile || /^workflow/i.test(profile.name.trimStart()))
      throw new Error("Choisis un profil dans les réglages de Projets.");
    const cwd = path.join(
      process.env.PASEO_HOME ?? path.join(homedir(), ".paseo"),
      "Ajout de tâches",
    );
    await mkdir(cwd, { recursive: true });
    const workspace = await api.workspaces.open(cwd);
    let model = profile.model?.trim();
    if (!model) {
      const { models } = await api.providers.listModels(profile.provider, { cwd });
      const selectable = models?.filter((m) => m.isSelectable !== false);
      model = (selectable?.find((m) => m.isDefault) ?? selectable?.[0])?.id;
    }
    if (!model) throw new Error("Modèle indisponible pour ce profil.");
    return workspace.agents.create({
      agentId: id,
      idempotencyKey: id,
      title: "Ajout de tâches",
      launchProfileId: profile.id,
      labels: { "projets.capture": id },
      config: {
        provider: profile.provider + "/" + model,
        modeId: "modeId" in profile ? profile.modeId : undefined,
        thinkingOptionId: profile.thinkingOptionId,
        featureValues: profile.featureValues,
        writePolicy: "read_only",
        systemPrompt: captureInstructions,
      },
    });
  }
  function close(id: string) {
    const session = sessions.get(id);
    if (!session) return Promise.resolve();
    session.closing ??= session.agent
      .then((agent) => agent.archive())
      .then(() => {
        return void sessions.delete(id);
      })
      .catch((error) => {
        session.closing = undefined;
        throw error;
      });
    return session.closing;
  }
  // Closing the entire desktop window can cut its RPC connection before cleanup.
  const timer = setInterval(() => {
    for (const [id, session] of sessions)
      if (session.expires < Date.now()) void close(id).catch(() => {});
  }, 30_000);
  server.handle(captureSession, async ({ action, id }, { paseo }) => {
    const session = sessions.get(id);
    if (action === "close") {
      await close(id);
      return { ok: true };
    }
    if (session && !session.closing) {
      session.expires = Date.now() + 150_000;
      if (action === "open") await session.agent;
      return { ok: true };
    }
    if (action === "keep" || session) return { ok: false };
    const agent = open(id, paseo);
    sessions.set(id, { agent, expires: Date.now() + 150_000 });
    try {
      await agent;
    } catch (error) {
      sessions.delete(id);
      throw error;
    }
    return { ok: true };
  });
  return async () => {
    clearInterval(timer);
    await Promise.allSettled([...sessions.keys()].map(close));
  };
}
