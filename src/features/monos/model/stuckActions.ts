// What Ash can do about a stuck worker from wherever he sees it (the Lead's chat, Today, Being built), in one or two
// clicks: answer its question (an option, or his words), tell it what to do (a stalled worker: his words steer its
// running turn), open its chat under its Mono, stop it, or (a failure) say he has seen it. Every path goes through the
// app's own hands: the waiting-chats host for answers and messages, the delegation actions for open and Stop.
import {
  pickReply,
  plainOptionLabel,
  recommendedOption,
  wordsMessage,
  wordsReply,
} from "../../hub/model/chatQuestions";
import { liveChatQuestion, respondInChat, sendToChat } from "../../hub/model/waitingChats";
import type { UserQuestionPrompt, UserQuestionReply } from "../../sessions/model/userQuestion";
import { delegationActions, noteStopFailures } from "./delegationStore";
import { dismissStuck, type StuckWorker } from "./workerStuck";

export type StuckResult = { ok: true; said: string } | { ok: false; reason: string };

/** One option of an asking worker's question, as a button. */
export type StuckOption = { id: string; label: string; recommended: boolean };

/** The live question of an asking worker, when this window has it and it is the one its row says. */
export function liveQuestion(stuck: Pick<StuckWorker, "kind" | "row">): UserQuestionPrompt | undefined {
  if (stuck.kind !== "asking") return undefined;
  return liveChatQuestion(stuck.row.childSession);
}

/** Buttons for a one-question, one-choice ask (the recommended option first); none for anything bigger. */
export function questionOptions(prompt: UserQuestionPrompt | undefined): StuckOption[] {
  const only = prompt?.questions.length === 1 ? prompt.questions[0] : undefined;
  if (!only || only.multiSelect || !only.options.length || only.options.length > 4) return [];
  const pick = recommendedOption(only);
  const options = only.options.map((option) => ({
    id: option.id,
    label: plainOptionLabel(option.label),
    recommended: option.id === pick?.id,
  }));
  return [...options.filter((o) => o.recommended), ...options.filter((o) => !o.recommended)];
}

/** The worker's recommended answer, in plain words, when every question has one. */
export function suggestion(prompt: UserQuestionPrompt | undefined): string | undefined {
  if (!prompt?.questions.length) return undefined;
  const picks = prompt.questions.map(recommendedOption);
  return picks.every(Boolean) ? picks.map((o) => plainOptionLabel(o!.label)).join("; ") : undefined;
}

function answerLive(stuck: StuckWorker, prompt: UserQuestionPrompt, reply: UserQuestionReply, said: string): StuckResult {
  delegationActions()?.noteAnswer?.(stuck.row.childSession, prompt.requestId, reply);
  return respondInChat(stuck.row.childSession, prompt.requestId, reply)
    ? { ok: true, said }
    : { ok: false, reason: "That question was answered or moved on. Open the chat to see where it stands." };
}

/** Answer an asking worker with one of its options. */
export function answerWithOption(stuck: StuckWorker, optionId: string): StuckResult {
  const prompt = liveQuestion(stuck);
  const question = prompt?.questions.length === 1 ? prompt.questions[0] : undefined;
  const option = question?.options.find((o) => o.id === optionId);
  if (!prompt || !question || !option) return { ok: false, reason: "That question isn't open here any more. Open the chat to answer." };
  return answerLive(stuck, prompt, { kind: "answered", answers: { [question.id]: [option.id] } }, plainOptionLabel(option.label));
}

/** Take the worker's own recommendation, for every question it asked. */
export function takeSuggestion(stuck: StuckWorker): StuckResult {
  const prompt = liveQuestion(stuck);
  const reply = prompt ? pickReply(prompt) : undefined;
  if (!prompt || !reply) return { ok: false, reason: "It didn't suggest an answer. Answer in your words or open the chat." };
  return answerLive(stuck, prompt, reply, suggestion(prompt) ?? "its pick");
}

/**
 * Ash's words: they answer a live question that takes words; otherwise they go into the worker's chat as his message
 * (a stalled worker's running turn is steered by it; an idle one starts again).
 */
export async function sendWords(stuck: StuckWorker, text: string): Promise<StuckResult> {
  const words = text.trim();
  if (!words) return { ok: false, reason: "Type something first." };
  const prompt = liveQuestion(stuck);
  const reply = prompt ? wordsReply(prompt, words) : undefined;
  if (prompt && reply) return answerLive(stuck, prompt, reply, words);
  const message =
    stuck.kind === "asking" && stuck.row.pendingQuestion
      ? wordsMessage({ source: "ask", question: stuck.row.pendingQuestion }, words)
      : words;
  return (await sendToChat(stuck.row.childSession, message))
    ? { ok: true, said: words }
    : { ok: false, reason: "It couldn't take a message right now. Open the chat instead." };
}

/** Open the worker's chat under the Mono that started it. */
export function openStuck(stuck: StuckWorker): void {
  delegationActions()?.openChild(stuck.row.ownerSession, stuck.row.childSession);
}

/** Stop the worker and everything it delegated in turn (Ash's Stop: no report follows). */
export async function stopStuck(stuck: StuckWorker): Promise<StuckResult> {
  const actions = delegationActions();
  if (!actions) return { ok: false, reason: "The app isn't ready to stop it yet." };
  try {
    const result = await actions.stopRow(stuck.row);
    noteStopFailures(stuck.row.ownerSession, result);
    return result.stopFailed.length ? { ok: false, reason: "It wouldn't stop. Open the chat and stop it there." } : { ok: true, said: "Stopped" };
  } catch {
    noteStopFailures(stuck.row.ownerSession, { stopFailed: [stuck.row.childSession] });
    return { ok: false, reason: "It wouldn't stop. Open the chat and stop it there." };
  }
}

/** Ash has seen this failure: it leaves every surface (the Lead has its report). */
export function dismissFailure(stuck: StuckWorker): void {
  if (stuck.kind === "failed") dismissStuck(stuck.key);
}
