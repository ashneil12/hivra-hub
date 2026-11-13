// r93 (c02 blind 8ff9, mid shot): an app note the hub sends a Lead or coding-team chat ("[MonoCode fix mismatch] From
// the app: ...", r92's "[MonoCode latest result]") went in as an ordinary turn and showed to Ash as his own bubble,
// bracket tag and all. A user turn that is an app note reads as one small neutral line in plain words instead.
// A brief ("[MonoCode brief from ...]") keeps its own collapsed Brief line (briefView.ts).
import type { Block } from "./session";

const TAG = /^\s*\[MonoCode ([^\]\n]{1,40})\]/;

const LINES: Record<string, string> = {
  "fix mismatch": "The app asked the Lead to hand out a fix for a mismatch it found",
  "latest result": "The app pointed the Lead to a newer test result",
  "start workers": "The app asked the Lead to start the workers",
  "save rule": "The app asked the Lead to save your standing rule",
  "keep going": "The app asked the chat to do the step it said it would do",
  "empty turn": "The reply came back empty, so the app asked once more",
  "report request": "The app asked for a report",
  "moved tasks": "Tasks that were still going moved to this chat",
  "ash answered": "The app passed your answer on",
  question: "A worker asked the Lead a question",
  report: "A worker's report reached the Lead",
  landed: "The app told the Lead what landed",
  check: "The app asked for a check",
  room: "A note from the room",
};

/** The plain line an app note shows as, or undefined for anything Ash or a brief wrote. */
export function appNoteText(text: string): string | undefined {
  const tag = TAG.exec(text)?.[1]?.trim().toLowerCase();
  if (!tag || tag.startsWith("brief from")) return undefined;
  return LINES[tag] ?? "A note from the app";
}

/** A user turn that is the app's note to the chat, not Ash's message: its plain line. */
export function appNoteLine(block: Pick<Block, "role" | "text" | "draft">): string | undefined {
  if (block.role !== "user" || block.draft) return undefined;
  return appNoteText(block.text);
}
