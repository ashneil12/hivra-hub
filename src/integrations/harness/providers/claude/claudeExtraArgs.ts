// A seam for arguments a Claude Code session gets on top of MonoCode's own (the hub gives its project Leads their
// ash-os identity here). Nothing is registered in MonoCode itself, so its sessions are unchanged.
type Provider = (sessionId: string) => string[];

let provider: Provider | undefined;

export function setClaudeExtraArgs(next: Provider | undefined): void {
  provider = next;
}

/** Extra arguments for this session; never throws. */
export function claudeExtraArgs(sessionId: string): string[] {
  try {
    return provider?.(sessionId) ?? [];
  } catch {
    return [];
  }
}
