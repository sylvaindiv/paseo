import { expect, test } from "vitest";
import type {
  PluginPlanActionContribution,
  PluginPlanActionContext,
} from "@getpaseo/plugin/client";
import { registerActions, waitForExecutor } from "./actions";

test("the client contributes Revue and one direct automatic Handoff", async () => {
  const actions: PluginPlanActionContribution[] = [];
  registerActions({
    addPlanAction: (action) => {
      actions.push(action);
      return () => {};
    },
  });
  expect(actions.map((action) => action.title)).toEqual(["Revue", "Handoff"]);
  expect(actions[0]?.query?.launchProfileId).toBe("paseo-workflow-planner");
  expect(actions[1]?.query).toBeUndefined();
  expect(actions[1]?.choices).toBeUndefined();
  const calls: unknown[] = [];
  const context = {
    signal: new AbortController().signal,
    agent: { id: "agent" },
    workspace: { id: "workspace" },
    plan: { callId: "call", permissionRequestId: "permission", text: "Exact plan", turnId: "turn" },
    rpc: async (contract: { name: string }, input: unknown) => {
      calls.push({ rpc: contract.name, input });
      if (contract.name === "workflow.status.get.request")
        return {
          plan: { callId: "call" },
          routing: { phase: "complete" },
          handoff: { phase: "running", agentId: "executor" },
        };
      return {};
    },
    navigation: {
      openAgent: ({ agentId }: { agentId: string }) => calls.push({ agentId }),
    },
  } as unknown as PluginPlanActionContext;
  await actions[1].onAvailable?.({
    ...context,
    plan: { callId: "call", text: "Exact plan", turnId: "turn" },
  });
  await actions[0].onPress(context);
  await actions[1].onPress(context);
  const expected = {
    workspaceId: "workspace",
    agentId: "agent",
    permissionRequestId: "permission",
    callId: "call",
    text: "Exact plan",
  };
  expect(calls).toEqual([
    {
      rpc: "workflow.handoff.prepare.request",
      input: {
        workspaceId: "workspace",
        agentId: "agent",
        callId: "call",
        text: "Exact plan",
      },
    },
    { rpc: "workflow.plan.review.request", input: expected },
    { rpc: "workflow.handoff.enqueue.request", input: expected },
    {
      rpc: "workflow.status.get.request",
      input: { workspaceId: "workspace", agentId: "agent" },
    },
    { agentId: "executor" },
  ]);
});

test("executor tracking stops when the requesting plan view disappears", async () => {
  const lifetime = new AbortController();
  let polls = 0;
  const context = {
    signal: lifetime.signal,
    agent: { id: "agent" },
    workspace: { id: "workspace" },
    plan: { callId: "call", permissionRequestId: "permission", text: "Exact plan" },
    rpc: async () => {
      polls++;
      lifetime.abort();
      return {
        plan: { callId: "call" },
        routing: { phase: "complete" },
        handoff: { phase: "closed", agentId: "executor" },
      };
    },
  } as unknown as PluginPlanActionContext;

  await expect(waitForExecutor(context)).resolves.toBeUndefined();
  expect(polls).toBe(1);
});

test("an older host is rejected before the handoff is enqueued", async () => {
  const actions: PluginPlanActionContribution[] = [];
  registerActions({
    addPlanAction: (action) => {
      actions.push(action);
      return () => {};
    },
  });
  const calls: string[] = [];
  const context = {
    agent: { id: "agent" },
    workspace: { id: "workspace" },
    plan: { callId: "call", permissionRequestId: "permission", text: "Exact plan" },
    rpc: async (contract: { name: string }) => {
      calls.push(contract.name);
      return {};
    },
  } as unknown as PluginPlanActionContext;

  await expect(actions[1].onPress(context)).rejects.toThrow("Update the Paseo app");
  expect(calls).toEqual([]);
});
