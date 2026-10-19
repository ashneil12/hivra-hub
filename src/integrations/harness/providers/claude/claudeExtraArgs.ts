// A seam for arguments a Claude Code session gets on top of MonoCode's own (the hub gives its project Leads their
// ash-os identity here, and a Mono's session its connectors). Nothing is registered in MonoCode itself, so its sessions
// are unchanged.
type Provider = (sessionId: string) => string[];

const providers = new Map<string, Provider>();

/** Register (or with `undefined`, remove) one provider. Each part of the app uses its own key. */
export function setClaudeExtraArgs(next: Provider | undefined, key = "default"): void {
  if (next) providers.set(key, next);
  else providers.delete(key);
}

/** Extra arguments for this session; never throws. One provider failing never blocks the session or the others. */
export function claudeExtraArgs(sessionId: string): string[] {
  const all: string[] = [];
  for (const provider of providers.values()) {
    try {
      all.push(...(provider(sessionId) ?? []));
    } catch {
      /* that provider adds nothing */
    }
  }
  return mergeMcpConfigs(all);
}

/**
 * Several providers may each give `--mcp-config <json>`. They are folded into one JSON list of servers, so Claude Code
 * reads one value whatever it does with repeated flags. A file path (not JSON) is passed through as it is.
 */
export function mergeMcpConfigs(args: string[]): string[] {
  const configs: Record<string, unknown>[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === "--mcp-config" && value !== undefined) {
      try {
        const parsed = JSON.parse(value) as { mcpServers?: unknown };
        if (parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers) {
          configs.push(parsed.mcpServers as Record<string, unknown>);
          i++;
          continue;
        }
      } catch {
        /* a file path */
      }
    }
    rest.push(args[i]);
  }
  if (configs.length <= 1) return args;
  return [...rest, "--mcp-config", JSON.stringify({ mcpServers: Object.assign({}, ...configs) })];
}
