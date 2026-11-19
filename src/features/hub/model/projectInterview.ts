import { plainTitle } from "../../../shared/text/plainTitle";
// New project's interview. Each turn is a chat with the first mate contract and one short note on what Create needs.
// It asks what it needs and, when it has enough, ends a reply on a `project` block; that block becomes the preview
// card. Nothing exists until Create. Each turn carries the chat so far, so a draft left and resumed just asks again.
import { canRunHarnessTextPrompt, runHarnessTextPrompt } from "../../../integrations/harness";
import { FIRST_MATE_CONTRACT, withFirstMateContract } from "../../firstmate/model/contract";
import { monoTurn } from "../../monos/model/monoFiles";
import { loadDefaultModels } from "../../sessions/model/models";
import type { HarnessId } from "../../sessions/model/session";
import { homeDir } from "../../../platform/tauri/fs";
import { defaultProjectFolder, projectSlug } from "./projectActions";
import type { DraftCode } from "./projectDraft";
import { TEMPLATES, type TemplateId } from "./templates";

const TURN_TIMEOUT_MS = 120_000;

export type InterviewLine = { from: "cos" | "ash"; text: string };
export type ProjectProposal = { name?: string; oneLine: string; template: TemplateId; code: DraftCode; folder?: string; addon: boolean };
export type InterviewReply = { text: string; proposal?: ProjectProposal };

/** No engine to talk on: said plainly in the chat, never swapped for scripted questions. */
export class NoInterviewRuntime extends Error {}

/** The short note this chat adds: what is being set up and what Create needs. Nothing about how to talk. */
export function interviewNote(name: string): string {
  const id = projectSlug(name);
  return [
    `A new project is being set up in the app, called "${name}", and you're talking it through in this chat. When you know enough, propose it: they see your proposal as a card with Create and Cancel, and nothing exists until they press Create.`,
    "",
    "Create needs:",
    `- name: "${name}", unless they want another`,
    "- oneLine: what it is, in a sentence. It is printed on their card, addressed to them (\"you\", \"your\"), and holds only what they have said in this chat",
    `- template, what its dashboard starts as: ${TEMPLATES.map((t) => `${t.id} (${t.label}: ${t.blurb})`).join("; ")}`,
    `- code: "new" (a new git folder at ${defaultProjectFolder(id)}), "existing" (a folder they already have; put its path in folder if they give it) or "none"`,
    "",
    "This chat has no tools: you can't look at files, folders or anything else from here, and nothing runs after your reply. Each reply ends with either one question or the project block below.",
    "",
    "To propose, end your reply with:",
    "```project",
    `{"name": "${name}", "oneLine": "...", "template": "...", "code": "new"}`,
    "```",
  ].join("\n");
}

/**
 * The turn's prompt: the first mate contract, the note and the chat so far ahead of the latest line. `nudge` takes
 * their place when the last reply left them nothing to answer (askChiefOfStaff).
 */
export function interviewPrompt(name: string, lines: readonly InterviewLine[], who?: string, nudge?: string): string {
  const last = lines[lines.length - 1];
  const fromAsh = !nudge && last?.from === "ash";
  const latest = nudge ?? (fromAsh ? last.text : "(The project has just been named and they are waiting for you to start.)");
  const before = fromAsh ? lines.slice(0, -1) : lines;
  const transcript = before.length ? `\n\nThis chat so far:\n${before.map((l) => `${l.from === "cos" ? "You" : "Them"}: ${l.text}`).join("\n")}` : "";
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

/** The interview runs on Claude, not on a named Mono. */
function interviewEngine(): { harness: HarnessId; model?: string } {
  const harness: HarnessId = "claude";
  return { harness, model: loadDefaultModels()[harness] || undefined };
}

/** A reply Ash can answer: it asks him something or puts the setup card up. */
export function replyAwaitsAsh(reply: InterviewReply): boolean {
  return !!reply.proposal || reply.text.includes("?");
}

/** Said when a reply left them nothing to answer: the facts of this chat, not a script. */
export const STALLED_TURN_NUDGE =
  "(Your last reply ended without a question or the project block, and nothing can run from this chat, so they are waiting with nothing to answer. Reply again now: ask your one question, or propose the project with the block.)";

/**
 * One turn of the interview. A reply that neither asks a question nor proposes the project is asked again once, and
 * that second reply is the one shown.
 */
export async function askChiefOfStaff(name: string, lines: readonly InterviewLine[], signal?: AbortSignal): Promise<InterviewReply> {
  const { harness, model } = interviewEngine();
  if (!canRunHarnessTextPrompt(harness)) throw new NoInterviewRuntime("This chat can't go on yet: no Claude runtime is connected on this Mac. Connect it in Settings and come back; your chat is kept.");
  const cwd = await homeDir();
  // Not the raw text: a prompt that already carries the contract still loses the plain-English line when that switch is off.
  const who = withFirstMateContract(FIRST_MATE_CONTRACT);
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
