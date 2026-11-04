// Version rules translated from Orbit page_versions.rs (WP-72).
// Orbit waits ten minutes between snapshots. Hivra does not: a version is saved
// when the editor goes idle or the page closes, and on every agent edit.
// Blank states and a state equal to the newest version are still skipped.
// Restoring writes the restored content as a new version and keeps the
// pre-restore state when it would otherwise be lost.

import { blocksToMarkdown, stripBlockIds } from "./markdown";
import type { Block } from "./types";

export type VersionKind = "auto" | "restore" | "agent";
export type AuthorKind = "person" | "agent";

export type DocState = {
  title: string;
  body: string;
  blocks: readonly Block[];
};

export type VersionDecision = {
  store: boolean;
  kind: VersionKind;
};

/** No real title, and nothing but empty paragraphs. */
export function isBlank(state: DocState): boolean {
  if (state.title.trim()) return false;
  return state.blocks.every(
    (block) => block.type === "paragraph" && plain(block).trim() === "" && block.children.length === 0,
  );
}

function plain(block: Block): string {
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((part) => (part.type === "text" ? part.text : part.type === "link" ? part.content.map((item) => item.text).join("") : ""))
    .join("");
}

export function sameState(a: DocState, b: DocState): boolean {
  return a.title === b.title && JSON.stringify(stripBlockIds(a.blocks)) === JSON.stringify(stripBlockIds(b.blocks));
}

/**
 * Whether this save stores a version. Blank and duplicate states never do.
 * An agent edit is not held back by the idle timer; the caller only asks once
 * the editor is idle, the page is closing, or an agent wrote.
 */
export function shouldSnapshot(state: DocState, newest: DocState | null): boolean {
  if (isBlank(state)) return false;
  if (newest && sameState(state, newest)) return false;
  return true;
}

export function versionKind(origin: AuthorKind): VersionKind {
  return origin === "agent" ? "agent" : "auto";
}

/**
 * Restoring `restored` makes a new `restore` version of that content.
 * The current state is kept first when it is not blank and not already the newest,
 * so a restore cannot throw away unsaved edits.
 */
export function planRestore(
  current: DocState,
  newest: DocState | null,
  restored: DocState,
): { keepCurrent: boolean; restore: boolean } {
  return {
    keepCurrent: shouldSnapshot(current, newest) && !sameState(current, restored),
    restore: !sameState(current, restored),
  };
}

export function stateFrom(title: string, blocks: readonly Block[]): DocState {
  return { title, body: blocksToMarkdown(blocks), blocks };
}
