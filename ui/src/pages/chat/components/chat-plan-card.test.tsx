import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ClaudePlanCard, readClaudePlanMarkdown } from "./chat-plan-card.solid.tsx";
import { renderToolCard, renderToolFixture } from "./chat-tool-render.test-support.ts";

afterEach(() => {
  cleanupSolid();
});

const card = (name: string, args: unknown) => ({ id: "tool-1", name, args }) as unknown as ToolCard;

describe("Claude plan card", () => {
  it("reads the plan of ExitPlanMode only", () => {
    expect(readClaudePlanMarkdown(card("ExitPlanMode", { plan: "  # Plan\n- step  " }))).toBe(
      "# Plan\n- step",
    );
    expect(readClaudePlanMarkdown(card("ExitPlanMode", { plan: " " }))).toBeUndefined();
    expect(readClaudePlanMarkdown(card("ExitPlanMode", {}))).toBeUndefined();
    expect(readClaudePlanMarkdown(card("Write", { plan: "# Plan" }))).toBeUndefined();
  });

  it.each([
    ["running", "Waiting for your approval below"],
    ["succeeded", "Plan approved"],
    ["failed", "Kept planning"],
  ] as const)("renders the plan as Markdown while %s", (outcome, state) => {
    const view = mountSolid(() => (
      <ClaudePlanCard markdown={"# Refactor\n\n1. Split `a.ts`\n2. Test it"} outcome={outcome} />
    ));
    const root = view.container.querySelector("[data-chat-plan-card]");
    expect(root?.querySelector("h1")?.textContent).toBe("Refactor");
    expect(root?.querySelectorAll("ol li")).toHaveLength(2);
    expect(root?.querySelector("code")?.textContent).toBe("a.ts");
    expect(root?.querySelector(".chat-plan-card__state")?.textContent).toBe(state);
  });
});

describe("Claude plan card in the transcript", () => {
  it("replaces the ExitPlanMode tool row and keeps other tools as rows", async () => {
    const container = document.createElement("div");
    await renderToolFixture(
      renderToolCard(
        {
          id: "plan-1",
          name: "ExitPlanMode",
          args: { plan: "## Steps\n\n- **Edit** the parser" },
          completed: true,
        } as unknown as ToolCard,
        { messageKey: "m", expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );
    const plan = container.querySelector("[data-chat-plan-card]");
    expect(plan?.querySelector("h2")?.textContent).toBe("Steps");
    expect(plan?.querySelector("strong")?.textContent).toBe("Edit");
    expect(container.querySelector(".chat-tool-row")).toBeNull();
  });
});
