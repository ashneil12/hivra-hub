// A seam for arguments a Claude Code session gets on top of MonoCode's own (the hub gives its chats their ash-os
// identity and its Monos the delegate tool here, hub/model/hubMcp.ts). Nothing is registered in MonoCode itself, so its
// sessions are unchanged.
type Provider = (sessionId: string) => string[] | Promise<string[]>;

let provider: Provider | undefined;

export function setClaudeExtraArgs(next: Provider | undefined): void {
  provider = next;
}

/** Extra arguments for this session; never throws. A provider still reading what it needs is waited for. */
export async function claudeExtraArgs(sessionId: string): Promise<string[]> {
  try {
    return (await provider?.(sessionId)) ?? [];
  } catch {
    return [];
  }
}
