import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Block } from "../../src/features/sessions/model/session";
import { AgentTranscript } from "../../src/features/sessions/ui/AgentTranscript";
import "../../src/styles/index.css";

function Example() {
  const [stage, setStage] = useState(0);
  const [overview, setOverview] = useState(false);
  const blocks: Block[] = [
    {
      id: "example-user",
      role: "user",
      text: "Example: check the invoice dates",
    },
    {
      id: "example-tool",
      role: "assistant",
      text: "Example: read invoice dates",
      tool: {
        kind: "read",
        title: "Example: read invoice dates",
        status: "completed",
      },
    },
    {
      id: "example-reply",
      role: "assistant",
      streaming: stage < 2,
      text:
        stage === 0
          ? "Example: the first part of the reply"
          : "Example: the first part of the reply, followed by the next chunk.",
    },
  ];
  return (
    <main className="flex h-screen flex-col text-content">
      <div className="flex gap-4 p-2">
        <button onClick={() => setStage(1)}>Example: next chunk</button>
        <button onClick={() => setStage(2)}>Example: finish</button>
        <button onClick={() => setOverview(!overview)}>
          Example: toggle overview
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div data-example-chat className="min-w-0 flex-1">
          <AgentTranscript
            blocks={blocks}
            busy={stage < 2}
            inlineWork
            layout="chat"
            bottomAligned
          />
        </div>
        {overview ? (
          <aside
            style={{ width: "40%" }}
            className="shrink-0 border-l border-stroke"
          >
            Example: overview
          </aside>
        ) : null}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Example />);
