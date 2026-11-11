import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MonoCard } from "../../src/features/monos/ui/MonoCard";
import { addMono } from "../../src/features/monos/model/mono";
import { setHarnessModels } from "../../src/features/sessions/model/models";
import "../../src/styles/index.css";

const effort = (value: string, label: string) => ({ value, label });

setHarnessModels("claude", [
  {
    id: "claude:opus-fast",
    harness: "claude",
    name: "Opus Fast",
    settings: [
      {
        id: "effort",
        label: "Effort",
        kind: "select",
        value: "high",
        options: [effort("low", "Low"), effort("high", "High")],
      },
      {
        id: "fast",
        label: "Fast",
        kind: "toggle",
        value: "false",
        options: [
          { value: "true", label: "On" },
          { value: "false", label: "Off" },
        ],
      },
    ],
  },
  {
    id: "claude:sonnet-plain",
    harness: "claude",
    name: "Sonnet",
    settings: [
      {
        id: "effort",
        label: "Effort",
        kind: "select",
        value: "high",
        options: [effort("low", "Low"), effort("high", "High")],
      },
    ],
  },
]);

addMono({
  id: "ada",
  name: "Ada",
  mascot: "cat",
  color: "hsl(245 75% 65%)",
  projects: ["/work/hivra"],
  skills: ["gone-skill"],
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="mx-auto w-[640px] px-6 py-8">
      <MonoCard
        monoId="ada"
        cwd="/work/hivra"
        harness="claude"
        model="claude:opus-fast"
        modelSettings={{ effort: "high" }}
        offers={[
          { name: "grill-me", kind: "skill" },
          { name: "tdd", kind: "skill" },
          { name: "ship", kind: "command" },
        ]}
        onModelChange={() => undefined}
        onModelSettingsChange={() => undefined}
      />
    </div>
  </StrictMode>,
);
