import { describe, expect, it } from "vitest";
import { visibleAgentProfiles } from "./profile-visibility";

describe("agent profile visibility", () => {
  it("keeps ordinary profiles and hides every Workflow profile", () => {
    expect(
      visibleAgentProfiles([
        { id: "ordinary", name: "Personal" },
        { id: "paseo-workflow-planner", name: "Workflow · planner" },
        { id: "paseo-workflow-executor-standard", name: "Workflow · executor-standard" },
        { id: "paseo-workflow-executor-advanced", name: "Workflow · executor-advanced" },
        { id: "lowercase", name: "workflow helper" },
      ]).map(({ id }) => id),
    ).toEqual(["ordinary", "lowercase"]);
    expect(
      visibleAgentProfiles([{ id: "paseo-workflow-planner", name: "Workflow planner" }]),
    ).toEqual([]);
  });
});
