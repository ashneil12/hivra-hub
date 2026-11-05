import { invoke } from "@tauri-apps/api/core";
import { projectKey, projectName } from "../../../shared/lib/paths";
import { clearProjectLogo } from "./projectLogos";
import { clearProjectChatBackground } from "./chatBackground";
import {
  clearProjectChatBackgroundSetting,
  rebaseProjectChatBackgroundSetting,
} from "./projectChatBackground";
import { normalizeProjectPath } from "./recents";
import { listSessionsByProject } from "../../sessions/data/sessionStore";
import {
  clearTabGroupSettings,
  rebaseProjectTabGroupSettings,
} from "../../workspace/model/tabGroups";
import {
  rebaseProjectGroupAssignment,
  removeProjectGroupAssignment,
} from "./projectGroups";
import { rebaseSessionFolderSettings } from "../../sessions/model/sessionFolders";
import { clearProjectProviders, rebaseProjectProviders } from "../../sessions/model/projectProviders";
import {
  clearProjectSidebarTab,
  rebaseProjectSidebarTab,
} from "../../settings/model/projectSidebarTab";

/** Saved chats filed under this project, so the confirm prompt can count them. */
export async function projectSessionCount(path: string): Promise<number> {
  const sessions = await listSessionsByProject(path).catch(() => []);
  return sessions.length;
}

/** Moves a project, and the chats, tasks and docs filed under it, to the trash. */
export async function removeProjectData(path: string): Promise<void> {
  const normalized = normalizeProjectPath(path);
  await invoke("trash_project", {
    folder: normalized,
    title: projectName(normalized),
  });
}

/** Rail appearance for a project that was deleted forever. Chats are already gone. */
export async function purgeProjectLocal(path: string): Promise<void> {
  const normalized = normalizeProjectPath(path);
  const key = projectKey(normalized);
  await clearProjectLogo(key).catch(() => undefined);
  await clearProjectChatBackground(key).catch(() => undefined);
  clearProjectChatBackgroundSetting(key);
  clearTabGroupSettings(key);
  removeProjectGroupAssignment(normalized);
  clearProjectProviders(key);
  clearProjectSidebarTab(normalized);
}

/** Move local project settings after the filesystem resolver finds a rename. */
export function rebaseProjectData(from: string, to: string): void {
  const oldKey = projectKey(normalizeProjectPath(from));
  const newKey = projectKey(normalizeProjectPath(to));
  rebaseProjectTabGroupSettings(from, to);
  rebaseProjectGroupAssignment(from, to);
  rebaseProjectChatBackgroundSetting(oldKey, newKey);
  rebaseSessionFolderSettings(from, to);
  rebaseProjectProviders(oldKey, newKey);
  rebaseProjectSidebarTab(from, to);
}
