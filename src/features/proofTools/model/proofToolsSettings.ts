// PT-2: Settings > Crew > "Proof tools". The webview's typed read and write of a project's proof tools
// (src-tauri/src/proof_tools: `proof_tools_list`, `proof_tools_set`) and the plain words a row and its More popover show.
//
// Everything a person reads about a tool (its name, what it proves, its licence, its repo, its install command) comes from the
// catalogue (proofTools.json), never from what the app answers: an answer only says WHICH tools, whether the project has each,
// whether it is switched off and what was said to a proposal. A value read from the app is untrusted and read defensively.

import { invoke } from "@tauri-apps/api/core";
import {
  PROOF_TOOLS,
  readProofToolList,
  type ProofTool,
  type ProofToolList,
  type ProofToolView,
} from "./proofTools";

/**
 * The line under the heading: what the section is, that every tool the project has is on until it is switched off (PT-4), and
 * that the app never installs a tool by itself.
 */
export const PROOF_TOOLS_HINT =
  "Open-source tools that check the work. Each one this project has is on until you switch it off, and the app never installs one by itself.";
/** A project where nothing in the catalogue fits. */
export const NONE_FIT_LINE = "None of these tools fit this project.";
/** The line shown when a read or a write didn't go through and the app said nothing a person can use. */
export const PROOF_TOOLS_TRY_AGAIN = "That didn't go through. Try again.";

/**
 * What a failed call says: the app's own plain words when it gave some (it rejects with a string), else the usual line. An error
 * thrown on this side ("timed out", a stack) is never shown to a person.
 */
export function failureLine(error: unknown): string {
  return typeof error === "string" && error.trim() ? error.trim() : PROOF_TOOLS_TRY_AGAIN;
}

/** The project's proof tools. Throws the line to show when the app can't say. */
export async function loadProofTools(folder: string): Promise<ProofToolList> {
  let got: unknown;
  try {
    got = await invoke("proof_tools_list", { folder });
  } catch (error) {
    throw new Error(failureLine(error));
  }
  const list = readProofToolList(got);
  if (!list) throw new Error(PROOF_TOOLS_TRY_AGAIN);
  return list;
}

/** What `proof_tools_set` answers: the tools now switched off in the project, and the revision the next write must be based on. */
export type ProofToolSwitches = { off: string[]; revision: number };

/** The answer of a write, read defensively. An answer that isn't one is null; an id the catalogue doesn't know is left out. */
export function readSwitches(payload: unknown): ProofToolSwitches | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  if (!Array.isArray(row.off)) return null;
  if (typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 0) return null;
  const named = new Set(row.off.filter((id): id is string => typeof id === "string"));
  // The catalogue's order, each tool once.
  return { off: PROOF_TOOLS.filter((tool) => named.has(tool.id)).map((tool) => tool.id), revision: row.revision };
}

/**
 * Switches one tool on (`on`) or off for the project, on top of the revision last read. A window that read an older revision is
 * refused by the app with a plain line, which this throws as it is.
 */
export async function setProofTool(
  folder: string,
  toolId: string,
  on: boolean,
  expectedRevision: number,
): Promise<ProofToolSwitches> {
  let got: unknown;
  try {
    got = await invoke("proof_tools_set", { folder, toolId, on, expectedRevision });
  } catch (error) {
    throw new Error(failureLine(error));
  }
  const switches = readSwitches(got);
  if (!switches) throw new Error(PROOF_TOOLS_TRY_AGAIN);
  return switches;
}

/** The list after a write: each installed tool's switch from the answer, and the new revision. The list given is not changed. */
export function applySwitches(list: ProofToolList, switches: ProofToolSwitches): ProofToolList {
  return {
    ...list,
    revision: switches.revision,
    tools: list.tools.map((tool) => ({ ...tool, off: tool.installed && switches.off.includes(tool.id) })),
  };
}

// ---- a row --------------------------------------------------------------------------------------------------------------

export type ProofToolState = "Used" | "Off" | "Not in this project";

/** The word on the right of a row: Used (the project has it and it is on), Off (it has it, switched off) or Not in this project. */
export function stateWord(tool: Pick<ProofToolView, "installed" | "off">): ProofToolState {
  if (!tool.installed) return "Not in this project";
  return tool.off ? "Off" : "Used";
}

/**
 * The small tag beside the name: what was said to a first mate's proposal. Only while the project lacks the tool; once it has
 * it, the proposal is history and the state word is all a person needs.
 */
export function tagOf(tool: Pick<ProofToolView, "installed" | "status">): "Proposed" | "Declined" | null {
  if (tool.installed) return null;
  return tool.status === "proposed" ? "Proposed" : tool.status === "declined" ? "Declined" : null;
}

// ---- More ---------------------------------------------------------------------------------------------------------------

const LICENCE_WORDS: Record<string, string> = {
  MIT: "MIT licence",
  "Apache-2.0": "Apache 2.0 licence",
  "MIT OR Apache-2.0": "MIT or Apache 2.0 licence",
  "MPL-2.0": "MPL 2.0 licence",
  "BSD-3-Clause": "BSD 3-clause licence",
  "LGPL-2.1-or-later": "LGPL 2.1 or later licence",
};

/** A licence's SPDX name in plain words: "MIT" is "MIT licence". One the catalogue doesn't list is said as it is written. */
export function licenceWords(spdx: string): string {
  const known = LICENCE_WORDS[spdx.trim()];
  if (known) return known;
  return spdx.trim() ? `${spdx.trim()} licence` : "Licence not stated";
}

/** A repo address as a person reads it: no scheme, no closing slash. */
export function repoLabel(repo: string): string {
  return repo.replace(/^https:\/\//, "").replace(/\/+$/, "");
}

export const EXTERNAL_LINE = "Runs only if you have it installed. The app never bundles or installs it.";
export const FIRST_MATE_ADDS_LINE = "Your first mate can add this for you; it asks you first.";

/** What More shows for one tool. */
export type ProofToolMore = {
  licence: string;
  /** An https address the app opens in the browser. */
  repo: string;
  repoLabel: string;
  needs: "Needs no model" | "Uses a model";
  /** Only for a tool the app never bundles or installs. */
  external: string | null;
  /** Only for a tool the project doesn't have: the command as plain text, and who can add it. */
  install: { command: string; note: string } | null;
};

export function moreLines(tool: ProofTool, installed: boolean): ProofToolMore {
  return {
    licence: licenceWords(tool.licence),
    repo: tool.repo,
    repoLabel: repoLabel(tool.repo),
    needs: tool.needsModel ? "Uses a model" : "Needs no model",
    external: tool.external ? EXTERNAL_LINE : null,
    install: installed ? null : { command: tool.install, note: FIRST_MATE_ADDS_LINE },
  };
}
