// The latest turn on the Chief of Staff's own chat, as Home shows it.

export type ExchangeBlock = {
  role: string;
  text?: string;
  internal?: boolean;
  draft?: boolean;
  streaming?: boolean;
  monoNote?: unknown;
  monoSessionCompletion?: unknown;
  monoCheck?: unknown;
};

export type Exchange = {
  you?: string;
  reply?: string;
  streaming: boolean;
};

function hidden(block: ExchangeBlock): boolean {
  return block.internal === true || block.draft === true || block.monoNote != null || block.monoSessionCompletion != null || block.monoCheck != null;
}

/** Ash's last message, then the reply after it. A busy chat with no reply yet is still streaming. */
export function latestExchange(blocks: readonly ExchangeBlock[], busy = false): Exchange {
  let lastUser = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.role !== "user" || hidden(block)) continue;
    if (!(block.text ?? "").trim()) continue;
    lastUser = i;
    break;
  }
  if (lastUser < 0) return { streaming: false };
  let reply = "";
  let streaming = false;
  for (let i = lastUser + 1; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.role === "user" && !hidden(block)) break;
    if (block.role !== "assistant" || !block.text) continue;
    reply += block.text;
    if (block.streaming) streaming = true;
  }
  return {
    you: blocks[lastUser].text?.trim(),
    ...(reply ? { reply } : {}),
    streaming: streaming || (busy && true),
  };
}
