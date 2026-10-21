// A seam for arguments a Claude Code session gets on top of MonoCode's own (the hub gives its chats their ash-os
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

/** Extra arguments for this session; never throws. A provider still reading what it needs is waited for. */
export async function claudeExtraArgs(sessionId: string): Promise<string[]> {
  try {
    return (await provider?.(sessionId)) ?? [];
  } catch {
    return [];
  }
}
