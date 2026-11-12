// The ready-made Projects hub as it comes with every setup: kept with nothing allowed (as the seed keeps it), opened in
// the real Pages screen. A stock ready-made hub needs no Allow, so it shows the projects straight away.
import { createRoot } from "react-dom/client";
import { setHubDataSource, hubData } from "../../src/features/hub/model/hubData";
import type { HubDataSource } from "../../src/features/hub/model/types";
import { addMono } from "../../src/features/monos/model/mono";
import { keepPage, pageFromSpec, requestOpenPage, setPagesBackend } from "../../src/features/pages/model/pages";
import { PROJECTS_PAGE, READY_BY, READY_PAGES } from "../../src/features/pages/model/readyPages";
import { PagesContent } from "../../src/features/pages/ui/PagesView";
import "../../src/styles/index.css";

localStorage.clear();
const base = hubData();
const src = Object.create(base) as HubDataSource;
src.listProjects = () => [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/Users/example/Projects/vg-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/Users/example/Projects/hivra" },
  { id: "safetube", name: "SafeTube", shortName: "SafeTube", iconShape: "folder", folder: "/Users/example/Projects/safetube" },
];
src.listNeeds = () => [];
setHubDataSource(src);
setPagesBackend("local");
addMono({ id: "exo-lead", name: "EXO lead", mascot: "letter", color: "#888", projects: ["/Users/example/Projects/vg-game"] });
addMono({ id: "hivra-lead", name: "Hivra lead", mascot: "letter", color: "#888", projects: ["/Users/example/Projects/hivra"] });

const request = READY_PAGES.find((r) => r.id === "projects")!.request;
const kept = { ...pageFromSpec(PROJECTS_PAGE, request, READY_BY, "today", [], Date.now()), id: "page-projects" };
void keepPage(kept, Date.now(), { allow: false }).then(() => {
  if (!location.search.includes("list")) requestOpenPage(kept.id);
  createRoot(document.getElementById("root")!).render(<PagesContent />);
});
