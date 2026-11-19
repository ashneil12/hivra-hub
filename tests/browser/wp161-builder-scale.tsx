import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectWorkers } from "../../src/features/hub/ui/ProjectMenu";
import { BuilderScaleControls } from "../../src/features/monos/ui/BuilderScaleControls";
import type { HubProject } from "../../src/features/hub/model/types";
import "../../src/styles/index.css";

const project: HubProject = {
  id: "hivra",
  name: "Hivra",
  shortName: "Hivra",
  iconShape: "sparkles",
  folder: "hivra",
};

function Page() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <section aria-label="Crew defaults" className="px-4 py-3">
        <h2 className="text-[13px] font-medium text-content">Crew defaults</h2>
        <BuilderScaleControls showSharedMax />
      </section>
      <button ref={setAnchor} type="button" className="m-4 text-[13px] text-content">
        Project workers
      </button>
      {anchor ? <ProjectWorkers project={project} anchor={anchor} onClose={() => undefined} /> : null}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
