// WP-30: hand every Claude Code and Codex session the skills and MCP servers of the plugins switched on for its
// folder. Imported once at start (main.tsx). Outside the app (a browser preview) nothing is registered.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { setClaudePluginLaunch } from "../../../integrations/harness/providers/claude/claudeExtraArgs";
import { setCodexDeveloperInstructions, setCodexExtraConfig } from "../../../integrations/harness/providers/codex/codexExtraConfig";
import { REMOTE_PATH_PREFIX } from "../../../shared/lib/remotePaths";
import { browserAgentFor } from "../../browser/model/agent";
import { plainEnglishEndings } from "../../firstmate/model/plainEnglish";
import { mcodeInstallRoot, pstackInstallRoot, sessionInstruction } from "./pstackAutopilot";
import { claudeAdditions, codexConfig, NO_WIRING, type PluginWiring } from "./pluginWiring";

/** The wiring for a session in `cwd`. A folder on a connected machine gets none: plugins live on this one. */
export async function pluginWiringFor(cwd: string, sessionId?: string): Promise<PluginWiring> {
  if (!cwd || cwd.startsWith(REMOTE_PATH_PREFIX)) return NO_WIRING;
  try {
    // WP-43: the browser profile is this chat's agent. Other plugins ignore it.
    const agent = sessionId ? browserAgentFor(sessionId) : undefined;
    return await invoke<PluginWiring>("plugins_session_wiring", {
      cwd,
      ...(agent ? { agentId: agent.id, agentName: agent.name } : {}),
    });
  } catch {
    return NO_WIRING;
  }
}

/** What a session is told about the skills of the plugins that are on for it, from one wiring read. */
function instructionFor(wiring: PluginWiring): string {
  return sessionInstruction({
    pstackRoot: pstackInstallRoot(wiring.claudePluginDirs),
    mcodeRoot: mcodeInstallRoot(wiring.claudePluginDirs),
    plainEnglish: plainEnglishEndings(),
  });
}

export function registerPluginSessions(
  read: (cwd: string, sessionId?: string) => Promise<PluginWiring> = pluginWiringFor,
): void {
  setCodexExtraConfig(async (cwd, sessionId) => codexConfig(await read(cwd, sessionId)));
  // WP-41: one wiring read per Claude launch feeds both the index and the plugin dirs.
  setClaudePluginLaunch(async (cwd, sessionId) => {
    const wiring = await read(cwd, sessionId);
    return {
      additions: claudeAdditions(wiring),
      append: instructionFor(wiring),
    };
  });
  setCodexDeveloperInstructions(async (cwd) => {
    const wiring = await read(cwd);
    return instructionFor(wiring);
  });
}

if (isTauri()) registerPluginSessions();
