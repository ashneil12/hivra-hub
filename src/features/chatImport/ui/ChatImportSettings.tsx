// Settings, Chat history: the live chat import run, with the app's own projects for "Goes into".

import { useSyncExternalStore } from "react";
import { liveHubStore } from "../../hub/model/hubData";
import { chatImportRun } from "../model/live";
import type { ProjectRef } from "../model/plan";
import { ChatImportPanel } from "./ChatImportPanel";

const none = () => () => undefined;
const noProjects: ProjectRef[] = [];
let lastProjects: unknown;
let lastRefs: ProjectRef[] = noProjects;

function projectRefs(): ProjectRef[] {
  const projects = liveHubStore()?.getSnapshot().projects;
  if (!projects) return noProjects;
  if (projects === lastProjects) return lastRefs;
  lastProjects = projects;
  lastRefs = projects.map((project) => ({ id: project.id, name: project.name, folder: project.folder }));
  return lastRefs;
}

export function ChatImportSettings() {
  const store = liveHubStore();
  const projects = useSyncExternalStore(store ? store.subscribe : none, projectRefs, projectRefs);
  return <ChatImportPanel run={chatImportRun()} projects={projects} />;
}
