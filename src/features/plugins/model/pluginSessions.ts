// WP-30: hand every Claude Code and Codex session the skills and MCP servers of the plugins switched on for its
// folder. Imported once at start (main.tsx). Outside the app (a browser preview) nothing is registered.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { setClaudePluginLaunch } from "../../../integrations/harness/providers/claude/claudeExtraArgs";
import { setCodexDeveloperInstructions, setCodexExtraConfig } from "../../../integrations/harness/providers/codex/codexExtraConfig";
import { REMOTE_PATH_PREFIX } from "../../../shared/lib/remotePaths";
import { browserAgentFor } from "../../browser/model/agent";
import { plainEnglishEndings } from "../../firstmate/model/plainEnglish";
import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import { loadSkills } from "../../skills/model/skills";
import { monoForSession } from "../../monos/model/mono";
import { monoSessionInstruction } from "../../monos/model/monoSession";
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

function catalogHarness(engine: string | undefined): HarnessId {
  return engine && (HARNESSES as readonly string[]).includes(engine) ? (engine as HarnessId) : "claude";
}

/** What a session is told about the skills of the plugins that are on for it, from one wiring read. */
async function instructionFor(wiring: PluginWiring, cwd: string, sessionId?: string): Promise<string> {
  const input = {
    pstackRoot: pstackInstallRoot(wiring.claudePluginDirs),
    mcodeRoot: mcodeInstallRoot(wiring.claudePluginDirs),
    plainEnglish: plainEnglishEndings(),
  };
  // WP-182: a Mono that names its skills is told only those. Unset keeps today's text.
  if (!sessionId) return sessionInstruction(input);
  const mono = monoForSession(sessionId);
  if (!mono?.skills?.length) return sessionInstruction(input);
  // A missed catalog is not a reason to drop the names. The instruction still lists each one.
  const discovered = await loadSkills({ harness: catalogHarness(mono.engine), cwd }).catch(() => []);
  return monoSessionInstruction({
    ...input,
    skills: mono.skills,
    commands: mono.commands,
    discovered: discovered.map((skill) => ({ name: skill.name, description: skill.description })),
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
      append: await instructionFor(wiring, cwd, sessionId),
    };
  });
  setCodexDeveloperInstructions(async (cwd, sessionId) => {
    const wiring = await read(cwd, sessionId);
    return instructionFor(wiring, cwd, sessionId);
  });
}

/**
 * Whether the app is running inside Tauri. A test mock of the Tauri core may not define isTauri at all, and reading a
 * missing export throws at import, so the check is guarded: no Tauri host means nothing is registered.
 */
function insideTauri(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

if (insideTauri()) registerPluginSessions();
