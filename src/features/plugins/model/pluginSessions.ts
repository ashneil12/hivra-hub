// WP-30: hand every Claude Code and Codex session the skills and MCP servers of the plugins switched on for its
// folder. Imported once at start (main.tsx). Outside the app (a browser preview) nothing is registered.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { setClaudePluginAppend, setClaudePluginArgs } from "../../../integrations/harness/providers/claude/claudeExtraArgs";
import { setCodexDeveloperInstructions, setCodexExtraConfig } from "../../../integrations/harness/providers/codex/codexExtraConfig";
import { REMOTE_PATH_PREFIX } from "../../../shared/lib/remotePaths";
import { plainEnglishEndings } from "../../firstmate/model/plainEnglish";
import { pstackInstallRoot, sessionInstruction } from "./pstackAutopilot";
import { claudeAdditions, codexConfig, NO_WIRING, type PluginWiring } from "./pluginWiring";

/** The wiring for a session in `cwd`. A folder on a connected machine gets none: plugins live on this one. */
export async function pluginWiringFor(cwd: string): Promise<PluginWiring> {
  if (!cwd || cwd.startsWith(REMOTE_PATH_PREFIX)) return NO_WIRING;
  try {
    return await invoke<PluginWiring>("plugins_session_wiring", { cwd });
  } catch {
    return NO_WIRING;
  }
}

export function registerPluginSessions(read: (cwd: string) => Promise<PluginWiring> = pluginWiringFor): void {
  setClaudePluginArgs(async (cwd) => claudeAdditions(await read(cwd)));
  setCodexExtraConfig(async (cwd) => codexConfig(await read(cwd)));
  // WP-41: the pstack index and the plain-English ending, on the session text both engines already take.
  const text = async (cwd: string) => {
    const wiring = await read(cwd);
    return sessionInstruction({ pstackRoot: pstackInstallRoot(wiring.claudePluginDirs), plainEnglish: plainEnglishEndings() });
  };
  setClaudePluginAppend(text);
  setCodexDeveloperInstructions(text);
}

if (isTauri()) registerPluginSessions();
