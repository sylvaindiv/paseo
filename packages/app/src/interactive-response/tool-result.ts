import { extractInteractiveDocumentId } from "@getpaseo/protocol/interactive-response-reference";
import { isInteractiveResponseToolName } from "@getpaseo/protocol/tool-name-normalization";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import { describeToolCall } from "@/tool-calls/detail-level/grouping";
export function isInteractiveTool(name: string): boolean {
  return isInteractiveResponseToolName(name);
}
export function interactiveToolDocumentId(item: ToolCallItem): string | null {
  const descriptor = describeToolCall(item);
  const result = descriptor.detail.type === "unknown" ? descriptor.detail.output : null;
  return extractInteractiveDocumentId(result);
}

interface InteractiveResponseGroups {
  byHostId: Map<string, ToolCallItem[]>;
  followingIds: Set<string>;
}

export function groupInteractiveResponses(
  items: readonly StreamItem[],
  previous?: InteractiveResponseGroups,
): InteractiveResponseGroups {
  const byHostId = new Map<string, ToolCallItem[]>();
  const followingIds = new Set<string>();
  const byTurn = new Map<string, ToolCallItem[]>();
  let turnId: string | undefined;
  let legacyGroup: ToolCallItem[] | undefined;
  for (const item of items) {
    if (item.kind === "user_message") {
      turnId = item.turnId;
      legacyGroup = undefined;
    } else if (item.turnId) {
      turnId = item.turnId;
    }
    if (item.kind !== "tool_call" || !isInteractiveTool(describeToolCall(item).name)) continue;

    const group = turnId ? byTurn.get(turnId) : legacyGroup;
    if (group) {
      group.push(item);
      followingIds.add(item.id);
    } else {
      const next = [item];
      byHostId.set(item.id, next);
      if (turnId) byTurn.set(turnId, next);
      else legacyGroup = next;
    }
  }
  if (previous && previous.byHostId.size === byHostId.size) {
    for (const [id, group] of byHostId) {
      const old = previous.byHostId.get(id);
      if (old?.length === group.length && group.every((item, index) => old[index] === item)) {
        byHostId.set(id, old);
      }
    }
    if ([...byHostId].every(([id, group]) => previous.byHostId.get(id) === group)) return previous;
  }
  return { byHostId, followingIds };
}
