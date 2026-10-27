import { profileId, type Role } from "../shared/profiles";
import { decisionJson, routerDecision } from "../shared/decisions";
import type { FinalReview } from "../shared/final-review";
import { type ExecutionDecision } from "./execution-routing";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProfile,
  AgentTimelineItem,
  AgentFeature,
  AgentMode,
  PaseoAgentConfig,
} from "./types";
import { handoffPlanTitle } from "../shared/handoff-presentation";

export interface PlanContext {
  workspaceId: string;
  agentId: string;
  permissionRequestId: string;
  callId: string;
  text: string;
}
type StoredPlanContext = Omit<PlanContext, "permissionRequestId"> & {
  permissionRequestId?: string;
};
export interface WorkflowAgent {
  id: string;
  workspaceId?: string;
  launchProfileId?: string;
  labels: Record<string, string>;
  status?: string;
  pendingPermissions: Pick<
    AgentPermissionRequest,
    "id" | "kind" | "sourcePlanCallId" | "input" | "metadata"
  >[];
}
export interface WorkflowLaunch {
  workspaceId: string;
  title?: string;
  parent?: string;
  launchProfileId?: string;
  idempotencyKey: string;
  config: PaseoAgentConfig;
  prompt?: string;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  labels: Record<string, string>;
}
interface Review {
  source: "automatic" | "manual";
  phase: "closing" | "closed" | "running" | "complete" | "outcome_unknown";
  agentId?: string;
  promptSent?: boolean;
  superseded?: boolean;
  replacesAutomatic?: boolean;
}
interface Handoff {
  // COMPAT(workflow-executor-selection): added in v0.8.0, remove after 2027-09-13.
  selection?: "standard" | "advanced";
  phase: "closing" | "closed" | "running" | "outcome_unknown";
  agentId?: string;
  profileId?: string;
}
interface Routing {
  attempt: number;
  phase: "running" | "complete" | "failed" | "outcome_unknown";
  agentId?: string;
  decision?: ExecutionDecision;
  error?: string;
  promptStarted?: boolean;
}
export interface Workflow {
  id: string;
  workspaceId: string;
  plannerId: string;
  routerId?: string;
  routed?: boolean;
  activePlanId?: string;
  preparedPlanId?: string;
  handledTurns?: Record<string, string>;
  plannerTranscript?: Array<{ role: "user" | "assistant"; text: string }>;
  intent: string;
  request: string;
  constraints: string[];
  assumptions: string[];
  git: {
    base?: string;
    startHead?: string;
    targetBase?: string;
    targetRef?: string;
    branch: string;
    dirty: string;
  };
  recommendation: "standard" | "advanced" | null;
  plans: Record<
    string,
    {
      context: StoredPlanContext;
      review?: Review;
      handoff?: Handoff;
      routing?: Routing;
      handoffRequested?: boolean;
      approved?: boolean;
      verification?: string;
      final?: FinalReview;
    }
  >;
}
export interface WorkflowState {
  workflows: Record<string, Workflow>;
}
const UNCONFIRMED_APPROVAL =
  "Approval follow-up outcome_unknown. Inspect this conversation before continuing; automatic completion is suspended.";
export interface WorkflowPort {
  endHandoffSource(agentId: string): Promise<void>;
  profiles(): Promise<AgentProfile[]>;
  executionSettings(
    profile: AgentProfile,
    cwd: string,
  ): Promise<{
    modes: AgentMode[];
    features: AgentFeature[];
    defaultModeId?: string | null;
  }>;
  agent(id: string): Promise<WorkflowAgent>;
  workspace(id: string): Promise<{ cwd: string; intent?: string | null }>;
  timeline(id: string, projection?: "canonical" | "projected"): Promise<AgentTimelineItem[]>;
  turn(
    id: string,
    turnId?: string,
    expectedMessageId?: string,
    approvedPlanCallId?: string,
    afterMessageId?: string,
  ): Promise<{ key: string; items: AgentTimelineItem[] } | null>;
  git(cwd: string): Promise<Workflow["git"]>;
  create(input: WorkflowLaunch): Promise<string>;
  send(agentId: string, text: string, messageId: string): Promise<void>;
  revise(context: PlanContext, text: string, messageId: string): Promise<boolean>;
  respond(agentId: string, requestId: string, response: AgentPermissionResponse): Promise<void>;
  claimReview(context: PlanContext, active: boolean): Promise<void>;
  ensurePlanPermission(context: StoredPlanContext): Promise<AgentPermissionRequest>;
  read(): Promise<WorkflowState>;
  write(state: WorkflowState): Promise<void>;
}

function profileConfig(profile: AgentProfile, readOnly: boolean): PaseoAgentConfig {
  return {
    provider: profile.model ? `${profile.provider}/${profile.model}` : profile.provider,
    modeId: profile.modeId,
    thinkingOptionId: profile.thinkingOptionId,
    featureValues: profile.featureValues,
    writePolicy: readOnly ? "read_only" : "read_write",
  };
}

function briefing(workflow: Workflow, plan: string): string {
  return JSON.stringify(
    {
      intention: workflow.intent,
      request: workflow.request,
      plan,
      constraints: workflow.constraints,
      assumptions: workflow.assumptions,
      plannerTranscript: workflow.plannerTranscript ?? [],
      git: workflow.git,
    },
    null,
    2,
  );
}

function requestFrom(timeline: readonly AgentTimelineItem[]): string {
  return timeline
    .flatMap((item) =>
      item.type === "user_message" && !item.clientMessageId?.startsWith("workflow:")
        ? [item.text]
        : [],
    )
    .join("\n\nUser follow-up:\n");
}

function samePlan(left: StoredPlanContext, right: StoredPlanContext): boolean {
  return (
    left.agentId === right.agentId &&
    left.workspaceId === right.workspaceId &&
    left.callId === right.callId &&
    (!left.permissionRequestId ||
      !right.permissionRequestId ||
      left.permissionRequestId === right.permissionRequestId) &&
    left.text === right.text
  );
}

function planResolution(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
): AgentPermissionResponse | undefined {
  const resolution = item.metadata?.resolution;
  if (typeof resolution !== "object" || resolution === null || !("behavior" in resolution))
    return undefined;
  return resolution.behavior === "allow" || resolution.behavior === "deny"
    ? (resolution as AgentPermissionResponse)
    : undefined;
}

function closureMessage(workflow: Workflow, plan: StoredPlanContext, action: "review" | "handoff") {
  return `Workflow ${workflow.id}: ${action} ${plan.callId}; stop without implementation.`;
}

function actionContext(context: StoredPlanContext): PlanContext {
  if (!context.permissionRequestId)
    throw new Error("This recovered plan is already resolved and cannot accept plan actions.");
  return { ...context, permissionRequestId: context.permissionRequestId };
}

type PlanItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

function canonicalPlanItems(timeline: readonly AgentTimelineItem[]): PlanItem[] {
  return timeline.filter(
    (item): item is PlanItem =>
      item.type === "tool_call" &&
      item.detail.type === "plan" &&
      item.status === "completed" &&
      !item.error &&
      (item.metadata?.approved === true || Boolean(planResolution(item))),
  );
}

function latestPlanItem(timeline: readonly AgentTimelineItem[]): PlanItem | undefined {
  return timeline.findLast(
    (item): item is PlanItem => item.type === "tool_call" && item.detail.type === "plan",
  );
}

function recoverApprovedPlan(workflow: Workflow, latest: PlanItem | undefined): boolean {
  if (
    !latest ||
    latest.detail.type !== "plan" ||
    latest.status !== "completed" ||
    latest.error ||
    latest.metadata?.approved !== true ||
    planResolution(latest)?.behavior !== "allow" ||
    workflow.plans[latest.callId]
  )
    return false;
  const syntheticPermissionId = latest.metadata?.syntheticPermissionId;
  const synthetic = typeof syntheticPermissionId === "string";
  if (synthetic && latest.metadata?.approvalOutcome !== "completed") return false;
  workflow.plans[latest.callId] = {
    context: {
      workspaceId: workflow.workspaceId,
      agentId: workflow.plannerId,
      ...(synthetic ? { permissionRequestId: syntheticPermissionId } : {}),
      callId: latest.callId,
      text: latest.detail.text,
    },
    approved: true,
  };
  workflow.activePlanId = latest.callId;
  return true;
}

function closeConsumedOperations(
  workflow: Workflow,
  plan: Workflow["plans"][string],
  item: PlanItem,
  latest: PlanItem | undefined,
): boolean {
  if (item !== latest) return false;
  let changed = false;
  for (const [action, operation] of [
    ["review", plan.review],
    ["handoff", plan.handoff],
  ] as const) {
    if (operation?.phase === "closing" && isClosureDecision(workflow, plan, item, action)) {
      operation.phase = "closed";
      changed = true;
    }
  }
  return changed;
}

function isClosureDecision(
  workflow: Workflow,
  plan: Workflow["plans"][string],
  item: PlanItem | undefined,
  action: "review" | "handoff",
): boolean {
  if (!item || item.callId !== plan.context.callId || item.detail.type !== "plan") return false;
  const resolution = planResolution(item);
  return (
    item.status === "completed" &&
    !item.error &&
    item.detail.text === plan.context.text &&
    item.metadata?.approved === false &&
    resolution?.behavior === "deny" &&
    resolution.interrupt === true &&
    resolution.message === closureMessage(workflow, plan.context, action) &&
    (typeof item.metadata?.syntheticPermissionId !== "string" ||
      (item.metadata.syntheticPermissionId === plan.context.permissionRequestId &&
        item.metadata?.approvalOutcome === "completed"))
  );
}

function isResumingClosedHandoff(
  workflow: Workflow,
  plan: Workflow["plans"][string] | undefined,
  latest: PlanItem | undefined,
): boolean {
  const closed = plan?.handoff?.phase === "closed";
  if (closed && plan && !isClosureDecision(workflow, plan, latest, "handoff"))
    throw new Error("This handoff was superseded by a newer plan.");
  return closed;
}

function applyPlanDecision(
  workflow: Workflow,
  plan: Workflow["plans"][string],
  item: PlanItem,
  latest: PlanItem | undefined,
): boolean {
  let changed = closeConsumedOperations(workflow, plan, item, latest);
  if (item.metadata?.approved === true && !plan.approved) {
    plan.approved = true;
    if (item === latest) workflow.activePlanId = item.callId;
    changed = true;
  }
  if (item.metadata?.syntheticPermissionId && item.metadata.approvalOutcome !== "completed") {
    if (plan.verification !== UNCONFIRMED_APPROVAL) {
      plan.verification = UNCONFIRMED_APPROVAL;
      changed = true;
    }
  } else if (plan.verification === UNCONFIRMED_APPROVAL) {
    delete plan.verification;
    changed = true;
  }
  return changed;
}

function handoffPrompt(workflow: Workflow | undefined, agentId: string) {
  if (!workflow) return undefined;
  const plan = Object.values(workflow.plans).find(
    (entry) =>
      entry.handoff?.agentId === agentId &&
      (entry.handoff.phase === "running" || entry.handoff.phase === "outcome_unknown"),
  );
  return plan ? `workflow:${workflow.id}:handoff:${plan.context.callId}:prompt` : undefined;
}

function reviewerPrompt(workflow: Workflow | undefined, agentId: string) {
  if (!workflow) return undefined;
  const plan = Object.values(workflow.plans).find(
    (entry) => entry.review?.agentId === agentId && entry.review.phase === "running",
  );
  return plan ? `${reviewKey(workflow, plan)}:prompt` : undefined;
}

function planCandidates(plan: Workflow["plans"][string]): string[] {
  return plan.review?.source === "manual" && plan.review.phase === "running" && plan.review.agentId
    ? [plan.review.agentId]
    : [];
}

function stoppedAutomaticReview(review: Review | undefined) {
  return review?.source === "automatic" && review.superseded === true;
}

function currentReview(review: Review | undefined) {
  return stoppedAutomaticReview(review) ? undefined : review;
}

function reviewKey(workflow: Workflow, plan: Workflow["plans"][string]) {
  return `workflow:${workflow.id}:review:${plan.context.callId}${plan.review?.replacesAutomatic ? ":manual" : ""}`;
}

export class WorkflowController {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly port: WorkflowPort) {}

  dispose() {}

  stopAutomaticReviews() {
    return this.serial(async () => {
      const state = await this.port.read();
      for (const workflow of Object.values(state.workflows))
        await this.stopWorkflowReviews(state, workflow);
    });
  }

  private async stopWorkflowReviews(state: WorkflowState, workflow: Workflow) {
    for (const plan of Object.values(workflow.plans)) {
      const review = plan.review;
      if (review?.source === "automatic" && review.phase !== "complete") {
        review.phase = "complete";
        review.superseded = true;
        await this.port.write(state);
      }
      if (review?.source === "automatic" && review.superseded)
        await this.port.claimReview(actionContext(plan.context), false);
      if (plan.final && !["complete", "verification_required"].includes(plan.final.phase)) {
        plan.final.phase = "verification_required";
        plan.final.reason = "Automatic reviews disabled.";
        await this.port.write(state);
      }
    }
  }

  async planRequested(context: PlanContext, requirePending = true) {
    return this.serial(async () => {
      const agent = requirePending
        ? await this.pending(context)
        : await this.port.agent(context.agentId);
      const state = await this.port.read();
      const workflow = await this.workflow(state, agent);
      const previous = workflow.plans[context.callId];
      if (previous && !samePlan(previous.context, context))
        throw new Error("Plan calls are append-only. Submit a new call ID.");
      workflow.plans[context.callId] ??= { context };
      await this.port.write(state);
    });
  }

  approved(agentId: string, requestId: string) {
    return this.serial(async () => {
      const agent = await this.port.agent(agentId);
      const state = await this.port.read();
      const workflow = state.workflows[agent.labels["paseo.workflow.id"] ?? agent.id];
      if (!workflow || workflow.plannerId !== agentId) return;
      const plan = Object.values(workflow.plans).find(
        (candidate) => candidate.context.permissionRequestId === requestId,
      );
      // Permission events include ordinary tools, which never select the approved plan.
      if (!plan) return;
      plan.approved = true;
      plan.handoffRequested = false;
      workflow.activePlanId = plan.context.callId;
      await this.port.write(state);
      await this.reconcile(state, workflow);
    });
  }

  async prepareHandoff(_context: StoredPlanContext): Promise<{ recommendation: null }> {
    throw new Error("Choose an agent profile explicitly to hand off this plan.");
  }

  async enqueueHandoff(_context: PlanContext): Promise<{ handoffRequested: boolean }> {
    throw new Error("Choose an agent profile explicitly to hand off this plan.");
  }

  status(agentId: string, workspaceId: string) {
    return this.serial(async () => {
      const agent = await this.port.agent(agentId);
      if (agent.workspaceId !== workspaceId)
        throw new Error("The agent belongs to another workspace.");
      const state = await this.port.read();
      let workflow = state.workflows[agent.labels["paseo.workflow.id"] ?? agent.id];
      if (
        !workflow &&
        agent.launchProfileId === profileId("router") &&
        (await this.port.timeline(agent.id)).some((item) => item.type === "user_message")
      ) {
        workflow = await this.workflow(state, agent);
        await this.port.write(state);
      }
      if (workflow) await this.reconcile(state, workflow);
      const latest = latestPlanItem(await this.port.timeline(agentId));
      let context = await this.currentPlanContext(agent, latest);
      const closed = latest && workflow?.plans[latest.callId];
      if (
        !context &&
        closed?.handoff?.phase === "closed" &&
        isClosureDecision(workflow!, closed, latest, "handoff") &&
        closed.context.permissionRequestId
      )
        context = actionContext(closed.context);
      return {
        ...this.statusView(workflow, context, latest?.callId),
        profiles: (await this.port.profiles()).map(({ id, name }) => ({ id, name })),
      };
    });
  }

  private async currentPlanContext(agent: WorkflowAgent, latest: PlanItem | undefined) {
    if (!agent.workspaceId || latest?.detail.type !== "plan") return undefined;
    const permission = agent.pendingPermissions.find(
      (entry) => entry.kind === "plan" && entry.sourcePlanCallId === latest.callId,
    );
    const candidate = {
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      callId: latest.callId,
      text: latest.detail.text,
      permissionRequestId: permission?.id,
    };
    try {
      await this.available(candidate);
      const permissionRequestId =
        permission?.id ?? (await this.port.ensurePlanPermission(candidate)).id;
      return { ...candidate, permissionRequestId };
    } catch {
      // Status hides stale, resolved, reviewed or busy proposals; actions revalidate admission.
      return undefined;
    }
  }

  private statusView(
    workflow: Workflow | undefined,
    context?: PlanContext,
    currentCallId?: string,
  ) {
    const prepared = workflow?.plans[context?.callId ?? currentCallId ?? ""];
    return {
      plan: context ?? null,
      recommendation: workflow?.recommendation ?? null,
      routing: prepared?.routing ?? null,
      handoffRequested: prepared?.handoffRequested ?? false,
      handoff: prepared?.handoff ?? null,
      verification: Object.values(workflow?.plans ?? {})
        .filter((plan) => plan.verification)
        .map((plan) => ({
          planId: plan.context.callId,
          phase: "verification_required" as const,
          reason: plan.verification!,
        })),
      reviews: Object.values(workflow?.plans ?? {})
        .filter((plan) => plan.final)
        .map((plan) => ({
          planId: plan.context.callId,
          phase: plan.final!.phase,
          reason: plan.final!.reason ?? null,
          managerId: plan.final!.managerId,
        })),
    };
  }
  handoff(context: PlanContext, selectedProfileId?: string) {
    return this.serial(async () => {
      const state = await this.port.read();
      const agent = await this.port.agent(context.agentId);
      const workflow = await this.workflow(state, agent);
      await this.stopWorkflowReviews(state, workflow);
      const latestPlan = await this.reconcilePlanTimeline(state, workflow);
      const previous = workflow.plans[context.callId];
      if (previous && !samePlan(previous.context, context))
        throw new Error("This plan context does not match the recorded plan.");
      if (previous?.handoff?.phase === "running") return { agentId: previous.handoff.agentId! };
      if (previous?.handoff?.phase === "outcome_unknown" && previous.handoff.agentId)
        return { agentId: previous.handoff.agentId };
      const resumingClosed = isResumingClosedHandoff(workflow, previous, latestPlan);
      await this.refreshPlannerTranscript(state, workflow);
      const plan = previous ?? (workflow.plans[context.callId] = { context });
      if (plan.handoff?.phase !== "closed") await this.available(context);
      if (currentReview(plan.review) || plan.approved)
        throw new Error("This plan is already reviewed or approved.");
      const profile = await this.handoffProfile(plan.handoff, selectedProfileId);
      const config = profile ? await this.handoffConfig(profile, workflow.workspaceId) : undefined;
      if (plan.handoff?.phase !== "closed") {
        await this.available(context);
        plan.context = context;
        plan.handoff = { phase: "closing", profileId: profile!.id };
        await this.port.write(state);
        await this.port.respond(context.agentId, context.permissionRequestId, {
          behavior: "deny",
          interrupt: true,
          message: closureMessage(workflow, context, "handoff"),
        });
        plan.handoff.phase = "closed";
        await this.port.write(state);
      }
      if (!plan.handoff.agentId && profile) {
        plan.handoff.profileId = profile.id;
        await this.port.write(state);
      }
      return {
        agentId: await this.startHandoff(state, workflow, plan, profile, config, resumingClosed),
      };
    });
  }

  private async handoffProfile(handoff: Handoff | undefined, selectedProfileId?: string) {
    if (handoff?.agentId) return undefined;
    const profile = (await this.port.profiles()).find((entry) => entry.id === selectedProfileId);
    if (!profile)
      throw new Error(
        selectedProfileId
          ? "The selected agent profile is no longer available."
          : "Choose an agent profile explicitly to hand off this plan.",
      );
    return profile;
  }

  private async handoffConfig(profile: AgentProfile, workspaceId: string) {
    const { cwd } = await this.port.workspace(workspaceId);
    const { modes, features, defaultModeId } = await this.port.executionSettings(profile, cwd);
    const config = profileConfig(profile, false);
    if (features.some((feature) => feature.id === "plan_mode" && feature.type === "toggle"))
      config.featureValues = { ...config.featureValues, plan_mode: false };
    const isPlan = (mode: AgentMode) =>
      mode.colorTier === "planning" || mode.id === "plan" || mode.id.endsWith("#plan");
    const selectedId = config.modeId ?? defaultModeId;
    const selected = modes.find((mode) => mode.id === selectedId);
    if (
      (!selectedId && modes.length > 0) ||
      (selected ? isPlan(selected) : selectedId === "plan" || selectedId?.endsWith("#plan"))
    ) {
      const admissible = (mode: AgentMode) =>
        !isPlan(mode) && !mode.isUnattended && mode.colorTier !== "dangerous";
      const execution =
        modes.find((mode) => mode.id === defaultModeId && admissible(mode)) ??
        modes.find(admissible);
      if (!execution)
        throw new Error(
          `Provider '${profile.provider}' has no non-plan execution mode without unrestricted permissions.`,
        );
      config.modeId = execution.id;
    }
    return config;
  }

  private async startHandoff(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
    profile: AgentProfile | undefined,
    config: PaseoAgentConfig | undefined,
    resume = false,
  ) {
    const handoff = plan.handoff!;
    if (!handoff.agentId && resume) {
      const record = latestPlanItem(await this.port.timeline(workflow.plannerId));
      if (!isClosureDecision(workflow, plan, record, "handoff"))
        throw new Error("This handoff was superseded by a newer plan.");
    }
    const executorId =
      handoff.agentId ??
      (await this.port.create({
        workspaceId: workflow.workspaceId,
        title: handoffPlanTitle(plan.context.text),
        idempotencyKey: `workflow:${workflow.id}:handoff:${plan.context.callId}`,
        launchProfileId: profile!.id,
        config: config!,
        labels: {
          "paseo.workflow.id": workflow.id,
          "paseo.workflow.plan": plan.context.callId,
          "paseo.workflow.role": "executor",
        },
      }));
    handoff.agentId = executorId;
    handoff.phase = "outcome_unknown";
    await this.port.write(state);
    try {
      await this.port.send(
        executorId,
        `/paseo-handoff\nPASEO_WORKFLOW_HANDOFF ${JSON.stringify({ mode: "receiver", workflowId: workflow.id, planId: plan.context.callId, role: "executor" })}\nExecute the approved plan here without creating another agent. Follow its scope and explicit authorizations; handoff grants no additional permissions. Preserve pre-existing and concurrent changes. Run targeted validation and report results and blockers.\n${JSON.stringify({ plan: plan.context.text, git: workflow.git }, null, 2)}`,
        `workflow:${workflow.id}:handoff:${plan.context.callId}:prompt`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("agent_request_not_accepted")) {
        handoff.phase = "closed";
        await this.port.write(state);
      }
      throw error;
    }
    handoff.phase = "running";
    await this.port.write(state);
    await this.port.endHandoffSource(plan.context.agentId);
    return executorId;
  }
  finished(agentId: string, text: string) {
    return this.serial(async () => {
      const agent = await this.port.agent(agentId);
      const state = await this.port.read();
      return this.finishNow(state, agent, text);
    });
  }

  private async finishNow(
    state: WorkflowState,
    agent: WorkflowAgent,
    text: string,
  ): Promise<boolean> {
    const agentId = agent.id;
    if (
      agent.launchProfileId === profileId("router") &&
      agent.labels["paseo.workflow.role"] !== "executor"
    )
      return this.routerFinished(agent, state, text);
    const workflow = state.workflows[agent.labels["paseo.workflow.id"] ?? agent.id];
    if (!workflow) return false;
    await this.stopWorkflowReviews(state, workflow);
    const plan = workflow.plans[agent.labels["paseo.workflow.plan"] ?? workflow.activePlanId ?? ""];
    if (!plan) return false;
    if (plan.review?.source === "manual" && plan.review.agentId === agentId) {
      if (plan.review.phase !== "running") return false;
      await this.reviewFinished(state, workflow, plan, text);
      return true;
    }
    return false;
  }

  turnEnded(agentId: string, turnId: string | null) {
    return this.serial(async () => {
      if (!turnId) return;
      const state = await this.port.read();
      const agent = await this.port.agent(agentId);
      await this.consumeTurn(state, agent, turnId);
    });
  }

  private async consumeTurn(state: WorkflowState, agent: WorkflowAgent, turnId?: string) {
    const workflow = state.workflows[agent.labels["paseo.workflow.id"] ?? agent.id];
    const implementationPlan =
      workflow?.plannerId === agent.id ? workflow.plans[workflow.activePlanId ?? ""] : undefined;
    const reviewSource = reviewerPrompt(workflow, agent.id);
    const turn = await this.port.turn(
      agent.id,
      turnId,
      undefined,
      implementationPlan?.approved ? implementationPlan.context.callId : undefined,
      reviewSource ?? handoffPrompt(workflow, agent.id),
    );
    if (!turn) return;
    if (workflow?.handledTurns?.[agent.id] === turn.key) return;
    const text = turn.items
      .filter((item) => item.type === "assistant_message")
      .map((item) => item.text)
      .join("");
    if (
      agent.launchProfileId === profileId("router") &&
      agent.labels["paseo.workflow.role"] !== "executor" &&
      !text.trim().startsWith("{") &&
      !text.trim().startsWith("```")
    )
      return;
    if (!(await this.finishNow(state, agent, text))) return;
    const current = state.workflows[agent.labels["paseo.workflow.id"] ?? agent.id];
    if (current) {
      (current.handledTurns ??= {})[agent.id] = turn.key;
      await this.port.write(state);
    }
  }

  private async reconcilePlanTimeline(state: WorkflowState, workflow: Workflow) {
    const timeline = await this.port.timeline(workflow.plannerId);
    const latest = latestPlanItem(timeline);
    const decisions = new Map(canonicalPlanItems(timeline).map((item) => [item.callId, item]));
    let changed = recoverApprovedPlan(workflow, latest);
    for (const plan of Object.values(workflow.plans)) {
      if (
        plan.handoffRequested &&
        !plan.handoff &&
        (plan.approved ||
          plan.review ||
          latest?.callId !== plan.context.callId ||
          latest.detail.type !== "plan" ||
          latest.detail.text !== plan.context.text ||
          planResolution(latest) ||
          latest.metadata?.approved !== undefined)
      ) {
        plan.handoffRequested = false;
        if (plan.routing)
          plan.routing.error =
            "Pending handoff canceled: the plan was replaced, resolved or reviewed.";
        changed = true;
      }
    }
    for (const item of decisions.values()) {
      const plan = workflow.plans[item.callId];
      if (!plan || item.detail.type !== "plan" || plan.context.text !== item.detail.text) continue;
      changed = applyPlanDecision(workflow, plan, item, latest) || changed;
    }
    if (changed) await this.port.write(state);
    return latest;
  }

  private async reconcile(state: WorkflowState, workflow: Workflow) {
    await this.stopWorkflowReviews(state, workflow);
    // One bounded pass over existing operations, never replay arbitrary agent history.
    await this.reconcilePlanTimeline(state, workflow);
    const candidates = new Set<string>();
    if (
      !workflow.routed &&
      (await this.port.agent(workflow.routerId ?? workflow.plannerId)).launchProfileId ===
        profileId("router")
    )
      candidates.add(workflow.routerId ?? workflow.plannerId);
    for (const plan of Object.values(workflow.plans)) {
      await this.resumePlan(state, workflow, plan);
      for (const id of planCandidates(plan)) candidates.add(id);
    }
    for (const agentId of candidates) {
      await this.consumeTurn(state, await this.port.agent(agentId));
    }
  }

  private async resumePlan(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
  ) {
    if (plan.review?.phase === "closed" && plan.review.agentId && plan.review.promptSent) {
      plan.review.phase = "running";
      await this.port.write(state);
    }
    if (plan.review?.phase === "complete")
      await this.port.claimReview(actionContext(plan.context), false);
  }

  private async routerFinished(agent: WorkflowAgent, state: WorkflowState, text: string) {
    const workflow = await this.workflow(state, agent);
    if (workflow.routed) return false;
    await this.profile("router");
    const decision = routerDecision.parse(decisionJson(text));
    if (!decision.ready) return false;
    const request = requestFrom(await this.port.timeline(agent.id));
    if (!request)
      throw new Error("The original request is unavailable. Reopen the agent history and retry.");
    const planner = await this.profile("planner");
    workflow.routerId = agent.id;
    workflow.request = request;
    workflow.recommendation = decision.recommendation;
    workflow.constraints = decision.constraints;
    workflow.assumptions = decision.assumptions;
    await this.port.write(state);
    const plannerId = await this.port.create({
      workspaceId: workflow.workspaceId,
      launchProfileId: planner.id,
      idempotencyKey: `workflow:${workflow.id}:planner`,
      config: profileConfig(planner, false),
      labels: { "paseo.workflow.id": workflow.id, "paseo.workflow.role": "planner" },
    });
    await this.port.send(
      plannerId,
      `Plan the request interactively. Ask missing questions before producing a plan. Do not implement. Submit a plan for review and approval.\n${briefing(workflow, "")}`,
      `workflow:${workflow.id}:planner:prompt`,
    );
    workflow.plannerId = plannerId;
    workflow.routed = true;
    await this.port.write(state);
    return true;
  }

  private async reviewFinished(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
    text: string,
  ) {
    const current = (await this.port.timeline(workflow.plannerId)).findLast(
      (item) => item.type === "tool_call" && item.detail.type === "plan",
    );
    if (
      plan.approved ||
      current?.type !== "tool_call" ||
      current.callId !== plan.context.callId ||
      current.metadata?.approved === true ||
      (current.detail.type === "plan" && current.detail.text !== plan.context.text)
    ) {
      plan.review!.phase = "complete";
      plan.review!.superseded = true;
      await this.port.write(state);
      await this.port.claimReview(actionContext(plan.context), false);
      return;
    }
    if (!text.trim())
      throw new Error(
        "The review returned no objections or conclusion. Open the reviewer and retry.",
      );
    const accepted = await this.port.revise(
      actionContext(plan.context),
      `Revise the plan using these objections. Produce a new plan call; never rewrite the previous plan. Stay in planning, do not implement.\n${briefing(workflow, plan.context.text)}\nReview:\n${text}`,
      `workflow:${workflow.id}:revision:${plan.context.callId}`,
    );
    plan.review!.phase = "complete";
    if (!accepted) plan.review!.superseded = true;
    await this.port.write(state);
    await this.port.claimReview(actionContext(plan.context), false);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    // ponytail: one queue per plugin; split by workflow if concurrent launches become a bottleneck.
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async profile(role: Role): Promise<AgentProfile> {
    const id = profileId(role);
    const profile = (await this.port.profiles()).find((entry) => entry.id === id);
    if (!profile)
      throw new Error(
        `Profile '${id}' is missing. Open Workflow settings and choose Install / repair profiles.`,
      );
    return profile;
  }

  private async pending(context: PlanContext, requirePlanner = true): Promise<WorkflowAgent> {
    const agent = await this.port.agent(context.agentId);
    if (agent.workspaceId !== context.workspaceId)
      throw new Error("This plan belongs to another workspace.");
    const permission = agent.pendingPermissions.find(
      (entry) =>
        entry.id === context.permissionRequestId &&
        entry.sourcePlanCallId === context.callId &&
        entry.kind === "plan",
    );
    if (!permission) throw new Error("This plan is no longer pending. Open the current plan.");
    const text = permission.input?.plan ?? permission.metadata?.planText;
    if (text !== context.text) throw new Error("The plan text changed. Open the current plan.");
    if (requirePlanner && agent.launchProfileId !== profileId("planner"))
      throw new Error("This agent was not launched with the workflow planner profile.");
    if (requirePlanner) await this.profile("planner");
    return agent;
  }

  private async available(context: StoredPlanContext): Promise<WorkflowAgent> {
    const agent = context.permissionRequestId
      ? await this.pending(actionContext(context), false)
      : await this.port.agent(context.agentId);
    if (agent.workspaceId !== context.workspaceId)
      throw new Error("This plan belongs to another workspace.");
    const latest = latestPlanItem(await this.port.timeline(context.agentId));
    if (
      !latest ||
      latest.callId !== context.callId ||
      latest.detail.type !== "plan" ||
      latest.detail.text !== context.text
    )
      throw new Error("This plan was superseded or its text changed. Open the current plan.");
    if (
      latest.error ||
      planResolution(latest) ||
      latest.metadata?.approved !== undefined ||
      latest.metadata?.reviewClaim
    )
      throw new Error("This plan is already resolved or being reviewed.");
    if (
      !context.permissionRequestId &&
      (latest.status !== "completed" || agent.status !== "idle" || !context.text.trim())
    )
      throw new Error("Wait for the complete actionable plan before preparing handoff.");
    return agent;
  }

  private async workflow(state: WorkflowState, agent: WorkflowAgent): Promise<Workflow> {
    const id = agent.labels["paseo.workflow.id"] ?? agent.id;
    const existing = state.workflows[id];
    if (existing) return existing;
    if (!agent.workspaceId) throw new Error("The agent has no workspace.");
    const workspace = await this.port.workspace(agent.workspaceId);
    const timeline = await this.port.timeline(agent.id);
    const request = requestFrom(timeline);
    if (!request)
      throw new Error("The original request is unavailable. Reopen the agent history and retry.");
    const workflow: Workflow = {
      id,
      workspaceId: agent.workspaceId,
      plannerId: agent.id,
      intent: workspace.intent ?? "",
      request,
      constraints: [],
      assumptions: [],
      git: await this.port.git(workspace.cwd),
      recommendation: null,
      plans: {},
    };
    state.workflows[id] = workflow;
    return workflow;
  }

  private async refreshPlannerTranscript(state: WorkflowState, workflow: Workflow) {
    const timeline = await this.port.timeline(workflow.plannerId, "projected");
    // Reuse the host's message/chunk projection; preserve exchanges without inferring authority.
    const transcript: NonNullable<Workflow["plannerTranscript"]> = [];
    for (const item of timeline) {
      if (item.type === "user_message" && !item.clientMessageId?.startsWith("workflow:"))
        transcript.push({ role: "user", text: item.text });
      if (item.type === "assistant_message")
        transcript.push({ role: "assistant", text: item.text });
      if (
        item.type === "tool_call" &&
        (item.name === "request_user_input" || item.name === "request_user_input_async") &&
        item.detail.type === "plain_text"
      )
        transcript.push({
          role: "assistant",
          text: `[${item.name} (${item.status})]\n${item.detail.text}`,
        });
    }
    workflow.plannerTranscript = transcript;
    await this.port.write(state);
  }

  review(context: PlanContext, source: "automatic" | "manual") {
    return this.serial(async () => {
      if (source !== "manual") throw new Error("Automatic reviews disabled.");
      const state = await this.port.read();
      const agent = await this.port.agent(context.agentId);
      const workflow = await this.workflow(state, agent);
      await this.stopWorkflowReviews(state, workflow);
      await this.reconcilePlanTimeline(state, workflow);
      const previous = workflow.plans[context.callId];
      if (previous && !samePlan(previous.context, context))
        throw new Error("This plan context does not match the recorded plan.");
      const replacesAutomatic = stoppedAutomaticReview(previous?.review);
      const review = currentReview(previous?.review);
      if (review && ["running", "complete"].includes(review.phase))
        return { agentId: review.agentId! };
      if (review?.phase === "outcome_unknown")
        throw new Error(
          "Reviewer delivery outcome_unknown. Open the reviewer to inspect it; automatic retry is disabled.",
        );
      const reviewer = await this.profile("plan-reviewer");
      await this.refreshPlannerTranscript(state, workflow);
      if (
        Object.values(workflow.plans).some(
          (plan) => plan !== previous && plan.review?.source === source,
        )
      )
        throw new Error(`The ${source} plan review has already been used.`);
      const plan = previous ?? (workflow.plans[context.callId] = { context });
      plan.handoffRequested = false;
      if (replacesAutomatic) {
        await this.pending(context);
        plan.review = { source, phase: "closing", replacesAutomatic: true };
      }
      if (plan.review?.phase !== "closed") {
        await this.pending(context);
        await this.port.claimReview(context, true);
      }
      plan.review ??= { source, phase: "closing" };
      await this.port.write(state);
      const childId =
        plan.review.agentId ??
        (await this.port.create({
          workspaceId: workflow.workspaceId,
          parent: context.agentId,
          launchProfileId: reviewer.id,
          idempotencyKey: reviewKey(workflow, plan),
          config: profileConfig(reviewer, true),
          labels: {
            "paseo.workflow.id": workflow.id,
            "paseo.workflow.plan": context.callId,
            "paseo.workflow.role": "plan-reviewer",
          },
        }));
      plan.review!.agentId = childId;
      await this.port.write(state);
      await this.sendReviewPrompt(state, workflow, plan);
      if (plan.review.phase !== "closed") {
        await this.pending(context);
        await this.port.respond(context.agentId, context.permissionRequestId, {
          behavior: "deny",
          interrupt: true,
          message: closureMessage(workflow, context, "review"),
        });
        plan.review.phase = "closed";
        await this.port.write(state);
      }
      plan.review!.phase = "running";
      await this.port.write(state);
      await this.consumeTurn(state, await this.port.agent(childId));
      return { agentId: childId };
    });
  }

  private async sendReviewPrompt(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
  ) {
    const review = plan.review!;
    if (review.promptSent) return;
    const childId = review.agentId!;
    try {
      await this.port.send(
        childId,
        `Review this plan. Report objections, omissions, contradictions and assumptions. Do not edit, execute, commit, or delegate.\n${briefing(workflow, plan.context.text)}`,
        `${reviewKey(workflow, plan)}:prompt`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("agent_request_not_accepted"))
        throw error;
      review.phase = "outcome_unknown";
      await this.port.write(state);
      throw new Error(
        `Reviewer delivery outcome_unknown. Open reviewer ${childId} to inspect it; automatic retry is disabled.`,
        { cause: error },
      );
    }
    review.promptSent = true;
    await this.port.write(state);
  }
}
