// Hivra WP-11: the app's side of a look, reading a worker chat's transcript into the facts the classifier judges
// (`WorkerLook`, stall.ts). It stays out of the headless classifier: transcript reading leans on the session model,
// which knows the window. A remote host (WP-60) builds the same facts from its own sessions.
import { toolCallLabel, toolCallState } from "../../sessions/model/transcriptActivity";
import type { Block } from "../../sessions/model/session";
import { providerErrorAtEnd, type WorkerChat, type WorkerLook } from "./stall";

/** The blocks of the turn running now (or the last one): everything after its user message. */
function currentTurn(blocks: readonly Block[]): readonly Block[] {
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].role === "user") return blocks.slice(i + 1);
  return blocks;
}

const callOf = (block: Block) => {
  const preview = block.tool?.preview;
  return JSON.stringify([block.tool?.kind ?? "", block.text || block.tool?.title || "", preview?.path ?? "", preview?.query ?? ""]);
};
const resultOf = (block: Block) =>
  JSON.stringify([callOf(block), block.tool?.status ?? "", (block.tool?.detail ?? "").slice(0, 4_000)]);

/**
 * A shell step that waits by sleeping (`sleep 60`, `sleep 30 && gh pr checks`, `while ...; do sleep 10; done`). Each one
 * is a model turn spent on nothing; a timer or ending the turn waits for free (contract.md "Waiting").
 */
const SLEEP_WAIT = /(?:^|[\s;&|(`])sleep\s+\d/;
export function isSleepWait(block: Block): boolean {
  if (block.role !== "tool" || !block.tool) return false;
  const command = block.tool.command ?? block.tool.preview?.query ?? block.text ?? block.tool.title ?? "";
  return SLEEP_WAIT.test(command);
}

export function lookAt(chat: WorkerChat): WorkerLook {
  const turn = currentTurn(chat.blocks);
  const tools = turn.filter((block) => block.role === "tool" && block.tool);
  const last = tools[tools.length - 1];
  const running = last && toolCallState(last) === "pending" && !last.approval ? last : undefined;
  const finished = running ? tools.slice(0, -1) : tools;
  let repeat: WorkerLook["repeat"];
  if (finished.length) {
    const tail = resultOf(finished[finished.length - 1]);
    let count = 0;
    for (let i = finished.length - 1; i >= 0 && resultOf(finished[i]) === tail; i--) count++;
    if (count > 1) repeat = { title: toolCallLabel(finished[finished.length - 1], chat.cwd), count };
  }
  const sleepWaits = finished.filter(isSleepWait).length;
  const distinct = new Set(tools.map(callOf));
  const said = turn.filter((block) => block.role === "assistant" && block.text.trim()).length;
  const approval = turn.some((block) => !!block.approval && !block.approval.decided);
  const lastBlock = chat.blocks[chat.blocks.length - 1];
  const providerError = chat.busy ? providerErrorAtEnd(turn) : undefined;
  return {
    busy: !!chat.busy,
    asking: !!chat.pendingQuestion || approval,
    queued: !!chat.queuedMessages?.length && chat.queueStatus !== "paused",
    limited: !!chat.usageLimit,
    resumeStopped: lastBlock?.notice === "resume-stopped",
    ...(running ? { runningTool: toolCallLabel(running, chat.cwd) } : {}),
    ...(repeat ? { repeat } : {}),
    ...(sleepWaits ? { sleepWaits } : {}),
    steps: distinct.size + said,
    ...(providerError ? { providerError } : {}),
  };
}
