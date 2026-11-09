// WP-135: the real compare picker, with made-up models and a fake git port.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { launchFanOut } from "../../src/features/sessions/model/fanOutLaunch";
import type { FanOutChoice } from "../../src/features/sessions/model/fanOutChoices";
import { FanOutPicker } from "../../src/features/sessions/ui/FanOutPicker";
import "../../src/styles/index.css";

const choices: FanOutChoice[] = [
  { provider: "claude", model: "one", label: "Claude: one" },
  { provider: "codex", model: "two", label: "Codex: two" },
  { provider: "cursor", model: "three", label: "Cursor: three" },
  { provider: "pi", model: "four", label: "Pi: four" },
  { provider: "hermes", model: "five", label: "Hermes: five" },
];

function Page() {
  const [started, setStarted] = useState(0);
  return (
    <>
      <div style={{ height: 360 }} />
      <FanOutPicker
        prompt="Fix the flaky test"
        choices={choices}
        onLaunch={async (prompt, targets) => {
          const result = await launchFanOut(
            { prompt, targets, cwd: "/work/proj" },
            {
              git: async () => true,
              createWorktree: async (_cwd, branch) => ({
                path: `/work/trees/${branch.replace(/[^\w]+/g, "-")}`,
                branch,
              }),
            },
          );
          if (!result.ok) return false;
          setStarted(result.sessions.length);
          return true;
        }}
      />
      <p data-fan-out-started="">{started === 0 ? "No chats yet" : `Started ${started} chats`}</p>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
