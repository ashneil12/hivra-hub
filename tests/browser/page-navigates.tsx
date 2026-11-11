// A kept bespoke page with its read approved, in the real Pages screen and the real bridge. The spec drives it: it
// navigates the frame away (to about:blank, where the sandboxed frame keeps the same contentWindow) and then speaks to
// the bridge as whatever is there now.
import { createRoot } from "react-dom/client";
import { setHubDataSource, hubData } from "../../src/features/hub/model/hubData";
import type { HubDataSource } from "../../src/features/hub/model/types";
import { SessionStateContext, SessionStateStore } from "../../src/features/sessions/model/sessionStateStore";
import { keepPage, pageFromSpec, requestOpenPage, setPagesBackend } from "../../src/features/pages/model/pages";
import type { BespokeSpec } from "../../src/features/pages/model/pageSpec";
import { PagesContent } from "../../src/features/pages/ui/PagesView";
import "../../src/styles/index.css";

localStorage.clear();
const src = Object.create(hubData()) as HubDataSource;
src.listProjects = () => [];
src.listNeeds = () => [];
setHubDataSource(src);
setPagesBackend("local");

const SPEC: BespokeSpec = {
  kind: "bespoke", title: "Navigator", permissions: ["agents.read"],
  html: `<h1>Navigator</h1><p id="ok">ready</p>`, css: "",
  js: `hub.call("agents.read", {}).then(() => { document.getElementById("ok").textContent = "bridge works"; });`,
};
const kept = { ...pageFromSpec(SPEC, "a page", "test", "today", [], Date.now()), id: "page-nav" };
void keepPage(kept).then(() => {
  requestOpenPage(kept.id);
  createRoot(document.getElementById("root")!).render(
    <SessionStateContext.Provider value={new SessionStateStore([])}>
      <PagesContent />
    </SessionStateContext.Provider>,
  );
});
