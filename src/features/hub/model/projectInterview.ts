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
    "- oneLine: what it is, in a sentence",
    `- template, what its dashboard starts as: ${TEMPLATES.map((t) => `${t.id} (${t.label}: ${t.blurb})`).join("; ")}`,
    `- code: "new" (a new git folder at ${defaultProjectFolder(id)}), "existing" (a folder he already has; put its path in folder if he gives it) or "none"`,
    `- addon: true to also add ${ADDON_OFFER.name}, who ${ADDON_OFFER.what}`,
    "",
    "To propose, end your reply with:",
    "```project",
    `{"name": "${name}", "oneLine": "...", "template": "...", "code": "new", "addon": false}`,
    "```",
  ].join("\n");
}

/** The turn's prompt: who the Mono is, the note and the chat so far ahead of Ash's latest line. */
export function interviewPrompt(name: string, lines: readonly InterviewLine[], who?: string): string {
  const last = lines[lines.length - 1];
  const latest = last?.from === "ash" ? last.text : "(Ash has just named the project and is waiting for you to start.)";
  const before = last?.from === "ash" ? lines.slice(0, -1) : lines;
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
    const oneLine = typeof p.oneLine === "string" ? p.oneLine.trim() : "";
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

/** One turn of the interview: Chief of Staff's next reply to the chat so far. */
export async function askChiefOfStaff(name: string, lines: readonly InterviewLine[], signal?: AbortSignal): Promise<InterviewReply> {
  const { harness, model } = cosEngine();
  if (!canRunHarnessTextPrompt(harness)) throw new NoInterviewRuntime("Chief of Staff can't answer here: no Claude Code runtime is connected on this Mac, so this chat can't go on yet. Connect it in Settings and come back; your chat is kept.");
  const raw = await runHarnessTextPrompt({
    harness,
    cwd: await homeDir(),
    model,
    prompt: interviewPrompt(name, lines, await cosContext()),
    timeoutMs: TURN_TIMEOUT_MS,
    signal,
  });
  return parseInterviewReply(raw);
}
