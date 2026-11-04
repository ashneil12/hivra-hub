// WP-30: hand every Claude Code and Codex session the skills and MCP servers of the plugins switched on for its
// folder. Imported once at start (main.tsx). Outside the app (a browser preview) nothing is registered.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { setClaudePluginArgs } from "../../../integrations/harness/providers/claude/claudeExtraArgs";
import { setCodexExtraConfig } from "../../../integrations/harness/providers/codex/codexExtraConfig";
import { REMOTE_PATH_PREFIX } from "../../../shared/lib/remotePaths";
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
}

if (isTauri()) registerPluginSessions();
