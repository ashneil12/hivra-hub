// Browser proof for the native subagent list (WP-122). The list is the real one.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { foldLineage } from "../../src/features/sessions/model/subagentLineage";
import { LineageList } from "../../src/features/sessions/ui/LineageList";
import "../../src/styles/index.css";

const claude = [
  {
    type: "assistant",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_agent",
          name: "Task",
          input: {
            description: "Explore the auth module",
            subagent_type: "explore",
            model: "claude-haiku-5",
          },
        },
      ],
    },
  },
  {
    type: "assistant",
    session_id: "sub_1",
    parent_tool_use_id: "toolu_agent",
    message: { model: "claude-haiku-5", content: [{ type: "text", text: "Looking." }] },
  },
  {
    type: "user",
    session_id: "sess_1",
    message: {
      content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: "Auth lives in src/auth." }],
    },
  },
  {
    type: "system",
    subtype: "task_started",
    task_id: "t2",
    tool_use_id: "toolu_fail",
    description: "Check the migration",
    task_type: "local_agent",
  },
  {
    type: "system",
    subtype: "task_notification",
    task_id: "t2",
    tool_use_id: "toolu_fail",
    status: "failed",
    summary: "The model name was unknown.",
  },
];

function List() {
  const [opened, setOpened] = useState("");
  const lineage = foldLineage("claude", claude, [{ id: "hivra-9", providerSessionId: "sub_1" }]);
  return (
    <>
      <LineageList lineage={lineage} onOpenTranscript={setOpened} />
      <p data-opened>{opened}</p>
    </>
  );
}

createRoot(document.getElementById("list")!).render(<List />);
createRoot(document.getElementById("unreported")!).render(
  <LineageList lineage={foldLineage("hermes", claude)} />,
);
createRoot(document.getElementById("empty")!).render(
  <LineageList lineage={foldLineage("claude", [])} />,
);
