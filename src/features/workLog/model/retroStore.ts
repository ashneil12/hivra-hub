// WP-157: where a retro's proposals wait, and how they are accepted. The retro stages edits in the
// learn state. Only an accept writes opinions.md, through the learn store's own save (a hash check
// on the file, the size cap and the secret check). Staging, listing and rejecting never write it.

import { invoke } from "@tauri-apps/api/core";
import { hasSecretText } from "../../portable/model/secrets";
import { mentionsSecret } from "../../memory/model/doc";
import type { PendingEdit } from "./retro";
import {
  agentsWillSee,
  opinionBlock,
  parseRetroState,
  planStaging,
  proposalFor,
  withoutStaged,
  type StagedEdit,
} from "./retroStage";

const TRIES = 3;

export const QUEUE_FAILED = "The edits could not be queued. Try again.";
export const FILE_FULL = "Opinions is full. Remove or merge something there first.";
const SECRET_REFUSED = "That edit looks like it contains a secret, so it was not saved.";
const WAITS_FOR_SECOND = "Agents will see this once a second log line backs it.";
const ALREADY_THERE = "This is already in Opinions. Accept to clear it.";

export type StageOutcome = {
  /** Edits this run queued. */
  staged: number;
  /** Edits waiting for the person after this run. */
  waiting: number;
  declined: number;
  present: number;
  full: number;
};

/** What the learn screen shows for one waiting edit. The same shape its other proposals have. */
export type StagedShown = {
  id: string;
  title: string;
  diff: string;
  quotes: { sessionId: string; quote: string }[];
  note?: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function loadState(): Promise<{ revision: number; state: Record<string, unknown> }> {
  const loaded = asObject(await invoke("learn_state_load"));
  return {
    revision: typeof loaded.revision === "number" ? loaded.revision : 0,
    state: asObject(loaded.state),
  };
}

async function loadOpinions(): Promise<{ text: string; sha: string }> {
  const row = asObject(await invoke("learn_profile_load"));
  return {
    text: typeof row.opinions === "string" ? row.opinions : "",
    sha: typeof row.opinionsSha256 === "string" ? row.opinionsSha256 : "",
  };
}

async function saveState(revision: number, state: Record<string, unknown>): Promise<boolean> {
  const text = JSON.stringify(state);
  if (hasSecretText(text) || mentionsSecret(text)) {
    throw new Error("That looks like a secret, so it was not saved.");
  }
  return (await invoke<boolean>("learn_state_cas", { revision, state })) === true;
}

/**
 * Change the learn state through its revision check. `change` returns the whole next state, or
 * null when there is nothing to save. A lost race loads the state again and tries once more.
 */
async function changeState(change: (state: Record<string, unknown>) => Record<string, unknown> | null): Promise<boolean> {
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const { revision, state } = await loadState();
    const next = change(state);
    if (next === null) return true;
    if (await saveState(revision, next)) return true;
  }
  return false;
}

/**
 * Queue a retro's edits as pending learn store changes. Writes only the learn state, never a
 * profile file, so nothing reaches opinions.md until the person accepts it.
 */
export async function stageRetroEdits(edits: readonly PendingEdit[], at: string): Promise<StageOutcome> {
  const opinions = await loadOpinions();
  let outcome: StageOutcome = { staged: 0, waiting: 0, declined: 0, present: 0, full: 0 };
  const saved = await changeState((state) => {
    const plan = planStaging(state, opinions.text, edits, at);
    const waiting = plan.state ? plan.staged.length : plan.staged.length || parseRetroState(state).staged.length;
    outcome = { staged: plan.staged.length, waiting, ...plan.skipped };
    return plan.state;
  });
  if (!saved) throw new Error(QUEUE_FAILED);
  return outcome;
}

function shown(edit: StagedEdit, text: string): StagedShown | null {
  const verdict = proposalFor(text, edit);
  const quotes = edit.evidence.map((row) => ({ sessionId: `work log ${row.day}`, quote: row.line }));
  if (verdict.kind === "ready") {
    return {
      id: edit.id,
      title: edit.title,
      diff: verdict.proposal.diff,
      quotes,
      ...(agentsWillSee(edit) ? {} : { note: WAITS_FOR_SECOND }),
    };
  }
  if (verdict.kind === "present") return { id: edit.id, title: edit.title, diff: "", quotes, note: ALREADY_THERE };
  if (verdict.kind === "full") {
    const diff = opinionBlock(edit)
      .split("\n")
      .map((line) => `+ ${line}`)
      .join("\n");
    return { id: edit.id, title: edit.title, diff, quotes, note: FILE_FULL };
  }
  return null;
}

/** The edits waiting for the person, measured against opinions.md as it is now. Writes nothing. */
export async function listStaged(): Promise<StagedShown[]> {
  const { state } = await loadState();
  const waiting = parseRetroState(state).staged;
  if (waiting.length === 0) return [];
  const opinions = await loadOpinions();
  return waiting.flatMap((edit) => {
    const row = shown(edit, opinions.text);
    return row ? [row] : [];
  });
}

/**
 * The person accepted one edit. The block is built from the file as it is now and saved with
 * that file's hash, so a file that moved is not overwritten (false, and the edit keeps waiting).
 * An edit already in the file is cleared, not added a second time.
 */
export async function acceptStaged(id: string): Promise<boolean> {
  const { state } = await loadState();
  const edit = parseRetroState(state).staged.find((row) => row.id === id);
  if (!edit) return false;
  const opinions = await loadOpinions();
  const verdict = proposalFor(opinions.text, edit);
  if (verdict.kind === "stale") return false;
  if (verdict.kind === "full") throw new Error(FILE_FULL);
  if (verdict.kind === "ready") {
    if (mentionsSecret(verdict.next) || mentionsSecret(edit.evidence.map((row) => row.line).join("\n"))) {
      throw new Error(SECRET_REFUSED);
    }
    const wrote = await invoke<boolean>("learn_profile_save", {
      which: "opinions",
      expectedSha256: opinions.sha,
      next: verdict.next,
    });
    if (wrote !== true) return false;
  }
  return changeState((current) => withoutStaged(current, id, false));
}

/** The person rejected one edit. Nothing is written to a profile file, and the next retro leaves it out. */
export async function rejectStaged(id: string): Promise<boolean> {
  const { state } = await loadState();
  if (!parseRetroState(state).staged.some((row) => row.id === id)) return false;
  return changeState((current) => withoutStaged(current, id, true));
}
