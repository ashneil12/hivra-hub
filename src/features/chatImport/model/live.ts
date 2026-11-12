// The app's one chat import run, wired to the real store (src-tauri/src/chat_import.rs, session_store.rs) and the
// hub's projects. One per window, outside every screen, so it keeps going when onboarding or Settings closes.

import { invoke } from "@tauri-apps/api/core";
import { liveHubStore } from "../../hub/model/hubData";
import { addMockProject } from "../../hub/model/mockData";
import { createProject, projectSlug } from "../../hub/model/projectActions";
import { sanitizeSessionForPersist } from "../../sessions/data/sessionStore";
import { ChatImportRun, type ChatImportPorts } from "./runner";
import { SOURCE_TITLE, type ProjectRef } from "./plan";

function hubProjects(): ProjectRef[] {
  return (liveHubStore()?.getSnapshot().projects ?? []).map((project) => ({
    id: project.id,
    name: project.name,
    folder: project.folder,
  }));
}

/** A free name: "app", then "app 2", "app 3". */
function freeName(name: string): string {
  const taken = new Set(hubProjects().map((project) => project.id));
  if (!taken.has(projectSlug(name))) return name;
  for (let n = 2; n < 100; n += 1) {
    const next = `${name} ${n}`;
    if (!taken.has(projectSlug(next))) return next;
  }
  return `${name} ${Date.now()}`;
}

export const livePorts: ChatImportPorts = {
  roots: () => invoke("chat_import_roots"),
  index: (root, source, offset, limit) => invoke("chat_import_index", { root, source, offset, limit }),
  folders: (paths) => invoke("chat_import_folders", { paths }),
  knownIds: () => invoke("session_provider_ids"),
  read: (root, source, path) => invoke("chat_import_read", { root, source, path }),
  projects: hubProjects,
  createProject: async (name, folder, sources) => {
    // The design mockup and the example data have no store: the project is added to the example list, as first run does.
    if (!liveHubStore()) {
      const id = projectSlug(name);
      addMockProject({ id, name, shortName: name.split(/\s+/)[0]?.slice(0, 16) || id, iconShape: "folder", folder });
      return { id, name, folder };
    }
    const from = sources.map((source) => SOURCE_TITLE[source]).join(" and ") || "past chats";
    const made = await createProject({
      name: freeName(name),
      oneLine: `Brought in from ${from}.`,
      code: true,
      folder,
    });
    return { id: made.project.id, name: made.project.name, folder: made.project.folder ?? folder };
  },
  save: (session, createdAt, updatedAt) =>
    invoke<boolean>("session_import_new", {
      session: sanitizeSessionForPersist(session),
      createdAt: Math.round(createdAt),
      updatedAt: Math.round(updatedAt),
    }),
  changed: (folders) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("chat-import:landed", { detail: { folders } }));
  },
};

let run: ChatImportRun | undefined;

export function chatImportRun(): ChatImportRun {
  run ??= new ChatImportRun(livePorts);
  return run;
}
