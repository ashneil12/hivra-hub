// WP-30: what installed plugins give one agent session (src-tauri/src/plugins/wiring.rs works it out). Plain data in,
// plain data out, so the CLI seams stay small: Claude Code takes `--plugin-dir`s and `mcpServers` entries, Codex takes
// `mcp_servers` entries in its thread config.
import type { ClaudePluginAdditions } from "../../../integrations/harness/providers/claude/claudeExtraArgs";

/** `plugins_session_wiring`'s answer. */
export type PluginWiring = {
  claudePluginDirs: string[];
  claudeMcpServers: Record<string, unknown>;
  codexMcpServers: Record<string, unknown>;
  /** Every server name the person's own configs use for this folder, as Claude Code reads it (WP-101). */
  namesInUse: string[];
  reports: { path: string; message: string }[];
};

export const NO_WIRING: PluginWiring = {
  claudePluginDirs: [],
  claudeMcpServers: {},
  codexMcpServers: {},
  namesInUse: [],
  reports: [],
};

export function claudeAdditions(wiring: PluginWiring): ClaudePluginAdditions {
  return { pluginDirs: wiring.claudePluginDirs, mcpServers: wiring.claudeMcpServers };
}

export function codexConfig(wiring: PluginWiring): Record<string, unknown> {
  return Object.keys(wiring.codexMcpServers).length ? { mcp_servers: wiring.codexMcpServers } : {};
}
