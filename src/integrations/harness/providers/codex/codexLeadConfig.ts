// WP-120: Codex lead tools, separate from the plugin seam (setCodexExtraConfig).
// The hub registers a provider once it knows the app CLI. Nothing registered
// means a Codex thread is unchanged.

type Provider = (sessionId: string) => Record<string, unknown> | Promise<Record<string, unknown>>;

let provider: Provider | undefined;

export function setCodexLeadConfig(next: Provider | undefined): void {
  provider = next;
}

/** Lead config for one chat. Never throws, and empty until the hub registers it. */
export async function codexLeadConfig(sessionId: string): Promise<Record<string, unknown>> {
  try {
    return (await provider?.(sessionId)) ?? {};
  } catch {
    return {};
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Plugin servers stay. The lead's server wins when both use the name monocode.
 * Other plugin servers are left as they are.
 */
export function mergeCodexLead(
  extra: Record<string, unknown>,
  lead: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.keys(lead).length) return extra;
  const servers = {
    ...(isTable(extra.mcp_servers) ? extra.mcp_servers : {}),
    ...(isTable(lead.mcp_servers) ? lead.mcp_servers : {}),
  };
  return {
    ...extra,
    ...lead,
    ...(Object.keys(servers).length ? { mcp_servers: servers } : {}),
  };
}
