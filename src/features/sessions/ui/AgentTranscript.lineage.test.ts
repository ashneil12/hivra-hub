import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Block } from "../model/session";
import { lineageForThread } from "../model/subagentLineage";
import { AgentTranscript } from "./AgentTranscript";

const blocks: Block[] = [
  { id: "u1", role: "user", text: "Check the auth module." },
  {
    id: "agent",
    role: "tool",
    text: "Explore the auth module",
    tool: { callId: "toolu_agent", kind: "agent", title: "Explore the auth module", status: "completed", detail: "Auth is fine." },
    agentRun: { name: "Explore the auth module", steps: [] },
  },
  { id: "a1", role: "assistant", text: "All clear." },
];

function render(lineage: ReturnType<typeof lineageForThread>) {
  return renderToStaticMarkup(createElement(AgentTranscript, { blocks, lineage }));
}

describe("the subagent list inside the transcript", () => {
  it("is part of the scroll content, ahead of the first turn", () => {
    const markup = render(lineageForThread("claude", blocks));
    const content = markup.indexOf("data-transcript-content");
    const list = markup.indexOf("data-lineage");
    const firstTurn = markup.indexOf("Check the auth module.");
    expect(content).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(content);
    expect(list).toBeLessThan(firstTurn);
    expect(markup).toContain("1 done");
  });

  it("draws nothing without a list, and the label for a CLI that reports none", () => {
    expect(render(null)).not.toContain("data-lineage");
    expect(render(lineageForThread("hermes", blocks))).toContain("Not reported by this CLI");
  });
});
