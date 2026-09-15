import type {
  PluginClientContext,
  PluginPlanActionAvailableContext,
  PluginPlanActionContext,
} from "@getpaseo/plugin/client";
import { enqueueRpc, prepareRpc, reviewRpc, statusRpc } from "../shared/rpc";
import { profileId } from "../shared/profiles";

function planInput(context: PluginPlanActionContext) {
  return {
    workspaceId: context.workspace.id,
    agentId: context.agent.id,
    permissionRequestId: context.plan.permissionRequestId,
    callId: context.plan.callId,
    text: context.plan.text,
  };
}

function availablePlanInput(context: PluginPlanActionAvailableContext) {
  return {
    workspaceId: context.workspace.id,
    agentId: context.agent.id,
    callId: context.plan.callId,
    text: context.plan.text,
    permissionRequestId: context.plan.permissionRequestId,
  };
}

export async function waitForExecutor(context: PluginPlanActionContext) {
  for (;;) {
    if (context.signal.aborted) return undefined;
    const status = await context.rpc(statusRpc, {
      workspaceId: context.workspace.id,
      agentId: context.agent.id,
    });
    if (status.plan?.callId !== context.plan.callId)
      throw new Error("The handoff plan is no longer current.");
    if (status.routing?.error) throw new Error(status.routing.error);
    if (status.handoff?.phase === "running" && status.handoff.agentId)
      return status.handoff.agentId;
    if (context.signal.aborted) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    let onAbort: () => void;
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 500);
      }),
      new Promise<void>((resolve) => {
        onAbort = resolve;
        context.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    clearTimeout(timer!);
    context.signal.removeEventListener("abort", onAbort!);
  }
}

export function registerActions(client: Pick<PluginClientContext, "addPlanAction">) {
  // COMPAT(workflow-plan-actions): added in v0.8.0, remove after 2027-09-13.
  if (typeof client.addPlanAction !== "function")
    throw new Error("Update the Paseo app to use workflow plan actions.");
  client.addPlanAction({
    id: "review",
    title: "Revue",
    order: 10,
    query: { launchProfileId: profileId("planner") },
    async onPress(context) {
      await context.rpc(reviewRpc, planInput(context));
    },
  });
  client.addPlanAction({
    id: "handoff",
    title: "Handoff",
    order: 20,
    async onAvailable(context) {
      await context.rpc(prepareRpc, availablePlanInput(context));
    },
    async onPress(context) {
      // COMPAT(workflow-plan-action-signal): added in v0.9.1, remove after 2027-09-15.
      if (!context.signal) throw new Error("Update the Paseo app to hand off this plan.");
      await context.rpc(enqueueRpc, planInput(context));
      const agentId = await waitForExecutor(context);
      if (agentId && !context.signal.aborted) context.navigation?.openAgent({ agentId });
    },
  });
}
