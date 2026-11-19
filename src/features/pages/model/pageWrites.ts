// A page writing back to the hub (C4's "write back where supported"). Today that is one change, a project's name: it
// goes through the hub's real store (projectActions.ts, the same call the hub's own project menu makes), and the row
// lands in Bot changes under the page's title, so Ash sees it there and Undo puts the old name back the same way.
//
// Nothing a page sends is trusted: the project and the name are checked here, a refusal comes back in plain words the
// page can show, and the action name and payload are fixed here rather than taken from the page, so a page can't ask
// the store to do anything else.
import { recordPageWrite, setWriteHook } from "../../hub/model/botChanges";
import { hubData, liveHubStore } from "../../hub/model/hubData";
import { renameProjectEverywhere } from "../../hub/model/projectActions";
import type { HubProject } from "../../hub/model/types";
import type { BridgeHandlers } from "./bridge";

/** The action the hub's own project menu uses, so Undo and Redo run exactly what Ash's tap runs. */
const RENAME = "project-rename";
const MAX_NAME = 80;

/** The stores a write touches; a test stands in for them. */
export type WriteDeps = {
  projects(): HubProject[];
  rename(project: HubProject, name: string): Promise<void>;
};
const app: WriteDeps = { projects: () => hubData().listProjects(), rename: renameProjectEverywhere };

/**
 * The bridge handlers a framed page's write calls run, given who is writing so the Bot changes row names the page.
 */
export function pageWriteHandlers(pageTitle: string, deps: WriteDeps = app): BridgeHandlers {
  return {
    "project.write": async (args) => {
      const op = typeof args.op === "string" ? args.op : "";
      if (op !== "rename") throw new Error("A hub can change a project's name. That's the one project change it makes for now.");
      const wanted = typeof args.projectId === "string" ? args.projectId.trim() : "";
      const name = typeof args.name === "string" ? args.name.replace(/\s+/g, " ").trim() : "";
      if (!name) throw new Error("A new name can't be empty.");
      if (name.length > MAX_NAME) throw new Error(`That name is too long: ${MAX_NAME} characters at most.`);
      const projects = deps.projects();
      const project = projects.find((p) => p.id === wanted) ?? projects.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
      if (!project) throw new Error(wanted ? `There's no project called “${wanted}”.` : "Say which project to rename.");
      if (project.name === name) return { done: true, projectId: project.id, name };
      await deps.rename(project, name);
      recordPageWrite({
        by: pageTitle,
        line: `The hub “${pageTitle}” renamed ${project.name} to ${name}`,
        now: `Called ${project.name}`,
        after: `Called ${name}`,
        undoneText: `Undone: the project is called ${project.name} again.`,
        write: { action: RENAME, payload: { project_id: project.id }, before: { name: project.name }, after: { name } },
      });
      return { done: true, projectId: project.id, name };
    },
  };
}

/**
 * Undo and Redo of a page's write run the same action again with the old or new value, through the hub's real store.
 * Registered here so botChanges.ts doesn't import the Pages feature.
 */
setWriteHook(async (action, payload) => {
  const projectId = typeof payload.project_id === "string" ? payload.project_id : "";
  const name = typeof payload.name === "string" ? payload.name : "";
  if (action === RENAME && projectId && name) {
    const project = hubData().listProjects().find((p) => p.id === projectId);
    if (!project) throw new Error("That project isn't on the app any more, so nothing changed.");
    await renameProjectEverywhere(project, name);
    return;
  }
  const store = liveHubStore();
  if (!store) throw new Error("Not connected to the harness service, so nothing changed.");
  await store.act(action, payload, ["projects"]);
});
