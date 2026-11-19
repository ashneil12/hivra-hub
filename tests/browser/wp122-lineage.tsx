// Browser proof for the native subagent list (WP-122). The list is the real one, read off the agent rows the
// harness builds from the events a Claude subagent raises.
import { createRoot } from "react-dom/client";
import { applyHarnessEvent } from "../../src/integrations/harness/core/apply";
import type { HarnessEvent } from "../../src/integrations/harness/core/types";
import { newSession } from "../../src/features/sessions/model/session";
import { lineageForThread } from "../../src/features/sessions/model/subagentLineage";
import { ChildApprovalNote } from "../../src/features/sessions/ui/ChildApprovalNote";
import { LineageList } from "../../src/features/sessions/ui/LineageList";
import "../../src/styles/index.css";

const events: HarnessEvent[] = [
  { type: "tool.started", callId: "toolu_agent", title: "Subagent", kind: "agent", status: "in_progress" },
  { type: "tool.updated", callId: "toolu_agent", title: "Explore the auth module", kind: "agent", status: "in_progress" },
  { type: "tool.updated", callId: "toolu_agent", kind: "agent", agentModel: "claude-haiku-5" },
  {
    type: "agent.step",
    callId: "toolu_agent",
    stepId: "step_1",
    kind: "message",
    text: "Looking.",
    agentType: "explore",
  },
  {
    type: "tool.updated",
    callId: "toolu_agent",
    title: "Explore the auth module",
    kind: "agent",
    status: "completed",
    detail: "Auth lives in src/auth.",
  },
  { type: "tool.started", callId: "toolu_fail", title: "Check the migration", kind: "agent", status: "in_progress" },
  {
    type: "tool.updated",
    callId: "toolu_fail",
    title: "Check the migration",
    kind: "agent",
    status: "failed",
    detail: "The model name was unknown.",
  },
];

const blocks = events.reduce(applyHarnessEvent, newSession("claude", "/repo")).blocks;

createRoot(document.getElementById("list")!).render(<LineageList lineage={lineageForThread("claude", blocks)!} />);
createRoot(document.getElementById("unreported")!).render(<LineageList lineage={lineageForThread("hermes", blocks)!} />);
createRoot(document.getElementById("empty")!).render(
  <LineageList lineage={{ reported: true, children: [] }} />,
);
createRoot(document.getElementById("approval")!).render(
  <ChildApprovalNote name="Explore the auth module" detail="Read the config file" />,
);
