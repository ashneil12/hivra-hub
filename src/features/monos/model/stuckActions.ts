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
import { findMono } from "./mono";
import { dismissStuck, storedQuestion, type StuckWorker } from "./workerStuck";

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

/**
 * The options of an asking worker's stored question ("How long? [0.25 s (Recommended) | 0.4 s]"), for a window that
 * doesn't hold its live question: each one a button (the suggested one first), answered as Ash's words in its chat.
 * One question only, two to four options; none otherwise.
 */
export function storedOptions(stuck: Pick<StuckWorker, "kind" | "row">): StuckOption[] {
  if (stuck.kind !== "asking") return [];
  const raw = stuck.row.pendingQuestion?.trim() ?? "";
  if (raw.includes(" / ")) return [];
  const match = /\[([^[\]]+)\]\s*$/.exec(raw);
  const parts = match ? match[1].split(" | ").map((part) => part.trim()).filter(Boolean) : [];
  if (parts.length < 2 || parts.length > 4) return [];
  const RECOMMENDED = /\s*[([]\s*recommended\s*[)\]]\s*/i;
  const options = parts.map((part, i) => ({
    id: `stored-${i}`,
    label: part.replace(RECOMMENDED, " ").trim(),
    recommended: RECOMMENDED.test(part),
  }));
  return [...options.filter((o) => o.recommended), ...options.filter((o) => !o.recommended)];
}

/** The question's words without its "[a | b]" options, when the options show as buttons. */
export function questionWithoutOptions(text: string): string {
  return text.replace(/\s*\[[^[\]]+\]\s*$/, "").trim();
}

/** Answer with one of the stored question's options: Ash's words naming it, into the worker's chat. */
export function answerWithStoredOption(stuck: StuckWorker, optionId: string): Promise<StuckResult> {
  const option = storedOptions(stuck).find((o) => o.id === optionId);
  if (!option) return Promise.resolve({ ok: false, reason: "That question isn't open here any more. Open the chat to answer." });
  return sendWords(stuck, option.label);
}

/**
 * The worker's recommended answer, in plain words, when every question has one: from its live question, else from the
 * question its row stores (a window that doesn't run it, or a turn cut off by a restart).
 */
export function suggestion(prompt: UserQuestionPrompt | undefined, stuck?: Pick<StuckWorker, "kind" | "row">): string | undefined {
  if (!prompt?.questions.length) return stuck?.kind === "asking" ? storedQuestion(stuck.row.pendingQuestion).pick : undefined;
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

/** Take the worker's own recommendation, for every question it asked (in place, else as Ash's message naming it). */
export async function takeSuggestion(stuck: StuckWorker): Promise<StuckResult> {
  const prompt = liveQuestion(stuck);
  const reply = prompt ? pickReply(prompt) : undefined;
  if (prompt && reply) return answerLive(stuck, prompt, reply, suggestion(prompt) ?? "its pick");
  const pick = suggestion(undefined, stuck);
  if (!pick) return { ok: false, reason: "It didn't suggest an answer. Answer in your words or open the chat." };
  return sendWords(stuck, `Go with your pick: ${pick}`);
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
  const asked = storedQuestion(stuck.row.pendingQuestion).text;
  const message = stuck.kind === "asking" && asked ? wordsMessage({ source: "ask", question: asked }, words) : words;
  return (await sendToChat(stuck.row.childSession, message))
    ? { ok: true, said: words }
    : { ok: false, reason: "It couldn't take a message right now. Open the chat instead." };
}

/** Open the worker's chat under the Mono that started it. */
export function openStuck(stuck: StuckWorker): void {
  delegationActions()?.openChild(stuck.row.ownerSession, stuck.row.childSession);
}

/** Open a Mono's own chat (a stuck job whose worker this app has no row for: its Lead's chat is where it stands). */
export function openLead(monoId: string | null | undefined): boolean {
  const session = monoId ? findMono(monoId)?.sessionId : undefined;
  const actions = delegationActions();
  if (!session || !actions) return false;
  actions.openOwner(session);
  return true;
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
