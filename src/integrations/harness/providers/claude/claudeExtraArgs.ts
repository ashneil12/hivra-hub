// A seam for arguments a Claude Code session gets on top of MonoCode's own (the hub gives its chats their
// identity and its Monos the delegate tool here, hub/model/hubMcp.ts). Nothing is registered in MonoCode itself, so its
// sessions are unchanged.
type Provider = (sessionId: string) => string[] | Promise<string[]>;

let provider: Provider | undefined;

export function setClaudeExtraArgs(next: Provider | undefined): void {
  provider = next;
}

/**
 * The guard every Claude Code process the app starts carries, a chat's or not: the hub's fence round the Monos' home
 * (hubMcp.ts registerClaudeGuards). A chat gets it in its extra arguments; the app's own helper processes (titles,
 * commit text, the room's gate, the catalog probe) take it from here (claudeText.ts, claudeCatalog.ts). Mac round 2
 * (21 Oct): the chat-title helper was started without it.
 */
let guard: (() => string[]) | undefined;

export function setClaudeGuardArgs(next: (() => string[]) | undefined): void {
  guard = next;
}

/** The guard's arguments; never throws. Empty outside the hub. */
export function claudeGuardArgs(): string[] {
  try {
    return guard?.() ?? [];
  } catch {
    return [];
  }
}

/**
 * WP-30: what installed plugins add to a session in `cwd` (src/features/plugins/model/pluginSessions.ts): a
 * `--plugin-dir` per plugin with skills, and MCP servers to merge into the session's one `--mcp-config`.
 */
export type ClaudePluginAdditions = { pluginDirs: string[]; mcpServers: Record<string, unknown> };
type PluginProvider = (cwd: string) => ClaudePluginAdditions | Promise<ClaudePluginAdditions>;

let pluginProvider: PluginProvider | undefined;

export function setClaudePluginArgs(next: PluginProvider | undefined): void {
  pluginProvider = next;
}

/**
 * Add the plugins' servers to the `--mcp-config` already in `args` (the app's own entries keep their names), or add
 * one when there is none, then the `--plugin-dir`s.
 */
export function withPluginArgs(args: string[], plugins: ClaudePluginAdditions): string[] {
  const out = [...args];
  if (Object.keys(plugins.mcpServers).length) {
    const at = out.indexOf("--mcp-config");
    let merged = false;
    if (at >= 0 && at + 1 < out.length) {
      try {
        const config = JSON.parse(out[at + 1]) as { mcpServers?: Record<string, unknown> };
        out[at + 1] = JSON.stringify({ ...config, mcpServers: { ...plugins.mcpServers, ...(config.mcpServers ?? {}) } });
        merged = true;
      } catch {
        merged = false;
      }
    }
    if (!merged) out.push("--mcp-config", JSON.stringify({ mcpServers: plugins.mcpServers }));
  }
  for (const dir of plugins.pluginDirs) out.push("--plugin-dir", dir);
  return out;
}

/** Extra arguments for this session; never throws. A provider still reading what it needs is waited for. */
export async function claudeExtraArgs(sessionId: string, cwd?: string): Promise<string[]> {
  let args: string[] = [];
  try {
    args = (await provider?.(sessionId)) ?? [];
  } catch {
    args = [];
  }
  if (!cwd || !pluginProvider) return args;
  try {
    return withPluginArgs(args, await pluginProvider(cwd));
  } catch {
    return args;
  }
}

/**
 * What a chat adds to Claude Code's own system prompt (`--append-system-prompt`; the default prompt is never replaced):
 * the hub's short note, and a Mono's soul and memory (hub/model/hubNote.ts). `key` says when a running process needs a
 * restart to take a new one (who it is changed); `text` is what a new process starts with.
 */
export type ClaudeAppend = { key: string; text: string };
type AppendProvider = (sessionId: string) => ClaudeAppend | undefined;

let appendProvider: AppendProvider | undefined;

export function setClaudeAppend(next: AppendProvider | undefined): void {
  appendProvider = next;
}

/** This session's appended prompt, if the app gives it one; never throws. */
export function claudeAppend(sessionId: string): ClaudeAppend | undefined {
  try {
    const append = appendProvider?.(sessionId);
    return append?.text.trim() ? append : undefined;
  } catch {
    return undefined;
  }
}

/** The arguments that carry it. */
export function claudeAppendArgs(append: ClaudeAppend | undefined): string[] {
  return append ? ["--append-system-prompt", append.text] : [];
}
