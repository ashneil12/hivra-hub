import { plainTitle } from "../../../shared/text/plainTitle";
// New project's interview (scorecard G2; Ash: setup was "fixed questions", not an agent talking to him). Chief of Staff
// talks it through for real: each turn is its own Mono (soul and memory, on its own engine, so Grok 4.7 on the bridge)
// with one short note on what Create needs. It asks what it needs and, when it has enough, ends a reply on a
// `project` block; that block becomes the preview card. Nothing exists until Create. Each turn carries the chat so
// far, so a draft Ash left and came back to just asks again.
import { canRunHarnessTextPrompt, runHarnessTextPrompt } from "../../../integrations/harness";
import { findMono, monoEngine, monoLook } from "../../monos/model/mono";
import { loadMonoFiles, monoContext, monoTurn } from "../../monos/model/monoFiles";
import { loadDefaultModels } from "../../sessions/model/models";
import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import { homeDir } from "../../../platform/tauri/fs";
import { ADDON_OFFER } from "./builtInMonos";
import { defaultProjectFolder, projectSlug } from "./projectActions";
import type { DraftCode } from "./projectDraft";
import { TEMPLATES, type TemplateId } from "./templates";

export const COS_ID = "chief-of-staff";
const TURN_TIMEOUT_MS = 120_000;

export type InterviewLine = { from: "cos" | "ash"; text: string };
export type ProjectProposal = { name?: string; oneLine: string; template: TemplateId; code: DraftCode; folder?: string; addon: boolean };
export type InterviewReply = { text: string; proposal?: ProjectProposal };

/** No engine to talk on: said plainly in the chat, never swapped for scripted questions. */
export class NoInterviewRuntime extends Error {}

/** The short note this chat adds: what Ash is doing and what Create needs. Nothing about how to talk. */
export function interviewNote(name: string): string {
  const id = projectSlug(name);
  return [
    `Ash is setting up a new project in the hub, called "${name}", and you're talking it through with him in this chat. When you know enough, propose it: he sees your proposal as a card with Create and Cancel, and nothing exists until he presses Create.`,
    "",
    "Create needs:",
    `- name: "${name}", unless he wants another`,
    // r69 (PM's blind r67 (b)): the card read "A private page where Ash's mates send him a tip": Ash in the third
    // person, plus a detail he never gave. Said as what the field is; toAsh() below also turns a third-person line round.
    "- oneLine: what it is, in a sentence. It is printed on Ash's card, addressed to him (\"you\", \"your\"), and holds only what he has said in this chat",
    `- template, what its dashboard starts as: ${TEMPLATES.map((t) => `${t.id} (${t.label}: ${t.blurb})`).join("; ")}`,
    `- code: "new" (a new git folder at ${defaultProjectFolder(id)}), "existing" (a folder he already has; put its path in folder if he gives it) or "none"`,
    `- addon: true to also add ${ADDON_OFFER.name}, who ${ADDON_OFFER.what}`,
    "",
    // r61 (PM's blind G2, 28 Oct): the turn is text only, so "I'll check whether a folder exists, then ask" ended the
    // chat with nothing to answer. Said as a fact about this chat, not as a way to talk.
    "This chat has no tools: you can't look at files, folders or anything else from here, and nothing runs after your reply. Each reply ends with either one question for Ash or the project block below.",
    "",
    "To propose, end your reply with:",
    "```project",
    `{"name": "${name}", "oneLine": "...", "template": "...", "code": "new", "addon": false}`,
    "```",
  ].join("\n");
}

/**
 * The turn's prompt: who the Mono is, the note and the chat so far ahead of Ash's latest line. `nudge` takes Ash's
 * place when the last reply left him nothing to answer (askChiefOfStaff).
 */
export function interviewPrompt(name: string, lines: readonly InterviewLine[], who?: string, nudge?: string): string {
  const last = lines[lines.length - 1];
  const fromAsh = !nudge && last?.from === "ash";
  const latest = nudge ?? (fromAsh ? last.text : "(Ash has just named the project and is waiting for you to start.)");
  const before = fromAsh ? lines.slice(0, -1) : lines;
  const transcript = before.length ? `\n\nThis chat so far:\n${before.map((l) => `${l.from === "cos" ? "You" : "Ash"}: ${l.text}`).join("\n")}` : "";
  return monoTurn(latest, [...(who ? [who] : []), `${interviewNote(name)}${transcript}`]);
}

const BLOCK = /```project\s*\n([\s\S]*?)```/i;
const CODES: readonly DraftCode[] = ["new", "existing", "none"];

/** The reply as shown, and the proposal in its `project` block when there is a usable one. */
export function parseInterviewReply(raw: string): InterviewReply {
  const match = BLOCK.exec(raw);
  const text = raw.replace(BLOCK, "").trim();
  if (!match) return { text };
  try {
    const p = JSON.parse(match[1]) as Record<string, unknown>;
    const template = TEMPLATES.find((t) => t.id === p.template)?.id;
    const code = CODES.find((c) => c === p.code) ?? "new";
    // The card and the project's tagline are plain text: no markdown marks (r65).
    const oneLine = typeof p.oneLine === "string" ? toAsh(plainTitle(p.oneLine)) : "";
    if (!template) return { text: text || raw.trim() };
    const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : undefined;
    const folder = typeof p.folder === "string" && p.folder.trim() ? p.folder.trim() : undefined;
    return {
      text: text || "Here's how it will look. Nothing is created until you press Create project.",
      proposal: { ...(name ? { name } : {}), oneLine, template, code, ...(code === "existing" && folder ? { folder } : {}), addon: p.addon === true },
    };
  } catch {
    return { text: text || raw.trim() };
  }
}

/** Chief of Staff's engine: its own, else Claude Code (the team's, and Grok 4.7 on the bridge). */
function cosEngine(): { harness: HarnessId; model?: string } {
  const mono = findMono(COS_ID);
  const engine = mono ? monoEngine(mono) : undefined;
  const harness = engine && HARNESSES.includes(engine.harness as HarnessId) ? (engine.harness as HarnessId) : "claude";
  return { harness, model: engine?.model || loadDefaultModels()[harness] || undefined };
}

/** Its soul and memory, as its chats get them; none when they can't be read (it still answers, as itself by name). */
async function cosContext(): Promise<string | undefined> {
  const mono = findMono(COS_ID);
  if (!mono) return undefined;
  try {
    return monoContext(monoLook(mono), await loadMonoFiles(COS_ID), { soul: true, memory: true });
  } catch {
    return undefined;
  }
}

/** A reply Ash can answer: it asks him something or puts the setup card up. */
export function replyAwaitsAsh(reply: InterviewReply): boolean {
  return !!reply.proposal || reply.text.includes("?");
}

/** Said in Ash's place when a reply left him nothing to answer: the facts of this chat, not a script. */
export const STALLED_TURN_NUDGE =
  "(Your last reply ended without a question for Ash or the project block, and nothing can run from this chat, so he is waiting with nothing to answer. Reply to him again now: ask him your one question, or propose the project with the block.)";

/**
 * One turn of the interview: Chief of Staff's next reply to the chat so far. A reply that neither asks Ash anything nor
 * proposes the project ("I'll check whether a folder exists, then ask": PM's blind G2, 28 Oct, where the chat then sat
 * idle) is asked again once, and Ash sees that second reply instead.
 */
export async function askChiefOfStaff(name: string, lines: readonly InterviewLine[], signal?: AbortSignal): Promise<InterviewReply> {
  const { harness, model } = cosEngine();
  if (!canRunHarnessTextPrompt(harness)) throw new NoInterviewRuntime("Chief of Staff can't answer here: no Claude Code runtime is connected on this Mac, so this chat can't go on yet. Connect it in Settings and come back; your chat is kept.");
  const cwd = await homeDir();
  const who = await cosContext();
  const turn = async (prompt: string) =>
    parseInterviewReply(await runHarnessTextPrompt({ harness, cwd, model, prompt, timeoutMs: TURN_TIMEOUT_MS, signal }));
  const first = await turn(interviewPrompt(name, lines, who));
  if (replyAwaitsAsh(first) || signal?.aborted) return first;
  const again = await turn(interviewPrompt(name, [...lines, { from: "cos", text: first.text }], who, STALLED_TURN_NUDGE));
  return again.text || again.proposal ? again : first;
}

/**
 * r69 (PM's blind r67 (b)): the card speaks to Ash, so a line about him in the third person is turned round: "Ash's" and
 * "his" to "your", "Ash" and "him" to "you", "he/Ash sends" to "you send". The rest of the sentence is left as written.
 */
export function toAsh(line: string): string {
  const cap = (word: string, like: string) => (/^[A-Z]/.test(like) ? word.charAt(0).toUpperCase() + word.slice(1) : word);
  return line
    .replace(/\b(Ash|[Hh]e)\s+(?:(has)|(is)|(was)|(does)|([a-z]+?)(e?s))\b/g, (m, who: string, has, is, was, does, stem: string | undefined, ending: string | undefined) => {
      const verb = has ? "have" : is ? "are" : was ? "were" : does ? "do" : stem ? (ending === "es" && /(?:sh|ch|ss|x|o)$/.test(stem) ? stem : stem + (ending === "es" ? "e" : "")) : "";
      return verb ? `${cap("you", who)} ${verb}` : m;
    })
    .replace(/\bAsh['’]s\b/g, "your")
    .replace(/(^|[.!?]\s+)your\b/g, (_m, lead: string) => `${lead}Your`)
    .replace(/\b[Hh]is\b/g, (m) => cap("your", m))
    .replace(/\b[Hh]imself\b/g, (m) => cap("yourself", m))
    .replace(/\b[Hh]im\b/g, (m) => cap("you", m))
    .replace(/\bAsh\b/g, "you")
    .replace(/(^|[.!?]\s+)you\b/g, (_m, lead: string) => `${lead}You`);
}
