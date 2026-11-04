// WP-51: every first mate past a size uses the summary tree, not only "Keep one long chat".

/** UTF-8 bytes of finished user and assistant text. Tool output does not count. */
export const LONG_CHAT_THRESHOLD = 16_000;

export type ChatBlock = {
  role?: string;
  text?: string;
  streaming?: boolean;
  draft?: boolean;
};

export function chatBytes(blocks: readonly ChatBlock[]): number {
  let total = 0;
  const encode = new TextEncoder();
  for (const block of blocks) {
    if (block.streaming || block.draft) continue;
    if (block.role !== "user" && block.role !== "assistant") continue;
    total += encode.encode((block.text ?? "").replace(/\r\n/g, "\n")).length;
  }
  return total;
}

export function usesSummaryTree(input: { firstMate: boolean; longChat: boolean; bytes: number }): boolean {
  if (!input.firstMate) return false;
  if (input.longChat) return true;
  return input.bytes >= LONG_CHAT_THRESHOLD;
}

export type TreePick = { id: string; evenWithoutSetting: boolean };

/**
 * Which tree a turn should open. A room does not get the threshold (that would mix chats). A coding-team chat uses
 * the project lead's tree only when the lead has no chat of its own yet, so two transcripts never share one tree.
 */
export function pickSummaryTree(input: {
  sessionId: string;
  mono: boolean;
  teamId: string | undefined;
  raw: boolean;
  hasProviderSession: boolean;
  blocks: readonly ChatBlock[];
  own: { id: string; longChat?: boolean; sessionId?: string } | undefined;
  lead: { id: string; longChat?: boolean; sessionId?: string } | undefined;
}): TreePick | undefined {
  if (input.raw || input.hasProviderSession) return undefined;
  const bytes = chatBytes(input.blocks);
  if (input.mono) {
    const own = input.own;
    if (!own) return undefined;
    if (own.longChat === true) return { id: own.id, evenWithoutSetting: false };
    if (own.sessionId === input.sessionId && usesSummaryTree({ firstMate: true, longChat: false, bytes })) {
      return { id: own.id, evenWithoutSetting: true };
    }
    return undefined;
  }
  const lead = input.lead;
  if (!input.teamId || !lead) return undefined;
  if (lead.sessionId && lead.sessionId !== input.sessionId) return undefined;
  if (lead.longChat === true) return undefined;
  if (!usesSummaryTree({ firstMate: true, longChat: false, bytes })) return undefined;
  return { id: lead.id, evenWithoutSetting: true };
}
