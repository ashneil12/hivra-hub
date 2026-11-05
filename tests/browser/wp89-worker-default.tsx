import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkerDefaultControl } from "../../src/features/crew/ui/WorkerDefaultControl";
import { CrewRulesPage } from "../../src/features/crew/ui/CrewRulesPage";
import { ProjectWorkers } from "../../src/features/hub/ui/ProjectMenu";
import type { HubProject } from "../../src/features/hub/model/types";
import { addMono } from "../../src/features/monos/model/mono";
import { setHarnessModels } from "../../src/features/sessions/model/models";
import "../../src/styles/index.css";

const effort = (value: string, label: string) => ({ value, label });

setHarnessModels("claude", [
  {
    id: "claude:sonnet-5",
    harness: "claude",
    name: "Claude Sonnet 5",
    settings: [
      {
        id: "effort",
        label: "Effort",
        kind: "select",
        value: "low",
        options: [effort("low", "Low"), effort("medium", "Medium")],
      },
    ],
  },
  {
    id: "claude:opus-4-7",
    harness: "claude",
    name: "Claude Opus 4.7",
    settings: [
      {
        id: "effort",
        label: "Effort",
        kind: "select",
        value: "medium",
        options: [effort("medium", "Medium"), effort("high", "High")],
      },
    ],
  },
]);
setHarnessModels("cursor", [
  {
    id: "cursor:composer",
    harness: "cursor",
    name: "Composer",
    settings: [
      {
        id: "effort",
        label: "Effort",
        kind: "select",
        value: "medium",
        options: [effort("medium", "Medium")],
      },
    ],
  },
]);

const hivra: HubProject = {
  id: "hivra",
  name: "Hivra",
  shortName: "Hivra",
  iconShape: "sparkles",
  folder: "/Users/ash/harness/hivra",
};

addMono({
  id: "ada",
  mascot: "cat",
  color: "hsl(245 75% 65%)",
  projects: [hivra.folder],
  crewRules: [{ labels: ["frontend"], paths: [], model: "claude:sonnet-5", source: "person" }],
});

function Page() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <CrewRulesPage
        initial={{
          rules: [],
          plugins: [],
          signedIn: [{ cli: "claude", installed: true, signedIn: true }],
        }}
      />
      <section aria-label="Mono settings">
        <h2 className="px-4 pt-4 text-[13px] font-medium text-content">Model for its workers</h2>
        <div className="px-4 py-2">
          <WorkerDefaultControl scope="mono" monoId="ada" />
        </div>
      </section>
      <button ref={setAnchor} type="button" className="m-4 text-[13px] text-content">
        Project workers
      </button>
      {anchor ? <ProjectWorkers project={hivra} anchor={anchor} onClose={() => undefined} /> : null}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
