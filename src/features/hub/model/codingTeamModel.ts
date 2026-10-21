// E7 (Ash, 21 Oct 20:40): "For now, by default, I guess, model, you can just use DeepSeek ... DeepSeek on high." The
// coding team's chats (the main coding agent Ash talks to, and the workers it starts, which take its model) start on
// DeepSeek at High effort when a DeepSeek model is set up under Other models (its key is in the Keychain: the form only
// saves a model whose key it saved). Without one they start on the usual default, and the project's options say so.
// A project's own provider default always wins (models.ts folderDefaultChoice).
//
// The Grok bridge (Ash, 21 Oct 21:03: both Claude Code on Grok 4.7 AND the DeepSeek default): a custom model runs
// through Claude Code with the hub's router (claude.ts customModelRoute). A chat on a non-Grok Other model leaves the
// bridge (claudeGrokBridge.ts routedOffBridge): it starts on the plain `claude` with the router and DeepSeek's own key,
// so the DeepSeek default holds on a Mac whose Claude Code runs through the bridge. GROK_BRIDGE_MODEL (grok-4.7) is
// still forced on every other Claude Code chat: no model chosen (a Claude model), or a Grok model.
import { pathKey } from "../../../shared/lib/paths";
import { CUSTOM_MODEL_PREFIX, effortLabel, listCustomModels, type CustomModel } from "../../sessions/model/customModels";
import { setFolderDefaultChoice, type FolderDefaultChoice } from "../../sessions/model/models";
import { codingTeamsOn } from "./codingTeam";
import { hubData } from "./hubData";
import { isGlobalProject } from "./hubProjects";
import type { HubProject } from "./types";

/** The effort the coding team's DeepSeek default runs at. */
export const CODING_TEAM_EFFORT = "high";

/** The DeepSeek model set up under Other models (the first, if Ash added more than one). */
export function deepSeekModel(): CustomModel | undefined {
  return listCustomModels().find((model) => model.provider === "deepseek");
}

/** What a new coding-team chat starts on: DeepSeek on High, or undefined (the usual default) without a DeepSeek key. */
export function codingTeamDefault(): FolderDefaultChoice | undefined {
  const model = deepSeekModel();
  if (!model) return undefined;
  return { harness: "claude", model: `${CUSTOM_MODEL_PREFIX}${model.id}`, modelSettings: { effort: CODING_TEAM_EFFORT } };
}

/** The hub project whose code folder this is (never Ash's global memory). */
export function codingTeamFolderProject(cwd: string, projects: readonly HubProject[] = hubData().listProjects()): HubProject | undefined {
  const key = pathKey(cwd);
  return projects.find((project) => !!project.folder && !isGlobalProject(project.id) && pathKey(project.folder) === key);
}

/** New chats in a hub project's code folder (its coding team) start on the coding team's default. */
export function installCodingTeamDefault(): void {
  setFolderDefaultChoice((cwd) => (codingTeamsOn() && codingTeamFolderProject(cwd) ? codingTeamDefault() : undefined));
}

/** One plain line for the project's options: which model its coding team starts on, and why. */
export function codingTeamModelLine(projectName: string): string {
  const model = deepSeekModel();
  if (!model)
    return `New ${projectName} coding-team chats use your usual default model: DeepSeek isn't set up yet. Add DeepSeek under Other models and they start on DeepSeek, ${effortLabel(CODING_TEAM_EFFORT)}.`;
  return `New ${projectName} coding-team chats start on ${model.name}, ${effortLabel(CODING_TEAM_EFFORT)}.`;
}
