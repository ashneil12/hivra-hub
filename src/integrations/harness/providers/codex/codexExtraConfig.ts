// WP-30: a seam for Codex thread config a session gets on top of MonoCode's own. Installed plugins add their MCP
// servers here (src/features/plugins/model/pluginSessions.ts); nothing is registered in MonoCode itself, so its
// sessions are unchanged. Codex lays the `config` of `thread/start` / `thread/resume` over the user's own config as
// a session layer and merges tables, so `mcp_servers` entries are added beside the user's servers, not instead.
type Provider = (cwd: string, sessionId?: string) => Record<string, unknown> | Promise<Record<string, unknown>>;

let provider: Provider | undefined;

export function setCodexExtraConfig(next: Provider | undefined): void {
  provider = next;
}

/** Extra config for a session in `cwd`; never throws. */
export async function codexExtraConfig(cwd: string, sessionId?: string): Promise<Record<string, unknown>> {
  try {
    return (await provider?.(cwd, sessionId)) ?? {};
  } catch {
    return {};
  }
}

// WP-41: the same always-on text Claude appends (the pstack index and the plain-English ending), carried on the
// thread's developerInstructions. Empty means the thread gets none.
type Instructions = (cwd: string, sessionId?: string) => string | Promise<string>;
let instructions: Instructions | undefined;

export function setCodexDeveloperInstructions(next: Instructions | undefined): void {
  instructions = next;
}

export async function codexDeveloperInstructions(cwd: string, sessionId?: string): Promise<string | undefined> {
  if (!instructions) return undefined;
  try {
    // WP-182: sessionId picks the Mono whose skill list this thread should carry.
    const text = (await instructions(cwd, sessionId))?.trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The session's config: `base` (a Mono's private store, if any), the extra config, then the thread's own params on
 * top. `mcp_servers` is merged by server name, and `base`'s servers win a clash. Undefined when there is nothing.
 */
export function mergeCodexConfig(
  base: Record<string, unknown> | undefined,
  extra: Record<string, unknown>,
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base && !Object.keys(extra).length) return undefined;
  const servers = {
    ...(isTable(extra.mcp_servers) ? extra.mcp_servers : {}),
    ...(isTable(base?.mcp_servers) ? base.mcp_servers : {}),
  };
  return {
    ...extra,
    ...(base ?? {}),
    ...(Object.keys(servers).length ? { mcp_servers: servers } : {}),
    ...(params ?? {}),
  };
}
