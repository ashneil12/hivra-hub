// WP-166: run the weekly check. The fetch and the file write are passed in
// by tests. The app uses gh or git through the Rust commands.

import { QUIET_MARKER } from "../../monos/model/monoHabits";
import { githubSlug, parsePinDocument, type PinDocument, type RepoPin } from "./pins";
import {
  activityLine,
  changesMarkdown,
  chatReply,
  emptyFetch,
  interpretFetch,
  projectLabel,
  watchIsQuiet,
  type FetchBodies,
  type PinReport,
} from "./watch";

export type WatchRun = {
  outcome: "posted" | "quiet" | "failed";
  reply: string;
  cancelled?: boolean;
  error?: string;
};

export type RunInput = {
  projectRoot: string;
  monoId: string;
  monoName: string;
  actorId: string;
  signal?: { aborted: boolean };
  load?: () => Promise<PinDocument>;
  fetchPin?: (pin: RepoPin) => Promise<FetchBodies>;
  write?: (markdown: string) => Promise<void>;
  note?: (summary: string, project: string) => Promise<void>;
};

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out|timeout/i.test(error.message);
}

function cancelled(): WatchRun {
  return { outcome: "failed", reply: "", cancelled: true };
}

async function defaultLoad(projectRoot: string): Promise<PinDocument> {
  const { invoke } = await import("@tauri-apps/api/core");
  const text = await invoke<string>("repo_watch_load", { project: projectRoot });
  return parsePinDocument(text);
}

async function defaultFetch(pin: RepoPin): Promise<FetchBodies> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<FetchBodies>("repo_watch_fetch", { url: pin.url, pinSha: pin.pinSha });
}

async function defaultWrite(projectRoot: string, markdown: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("repo_watch_write_summary", { project: projectRoot, body: markdown });
}

async function defaultNote(input: RunInput, summary: string, project: string): Promise<void> {
  if (!input.actorId.trim() || !summary.trim()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("activity_note", {
    kind: "repo.watch",
    summary,
    project,
    target: "repo-watch",
    actorId: input.actorId,
    actorName: input.monoName,
  });
}

/**
 * Compare the pinned repos and write the summary. A stop before the write
 * leaves the file alone. A timeout on one repo is a line in the summary, not
 * a failed habit.
 */
export async function runRepoWatchHabit(input: RunInput): Promise<WatchRun> {
  if (input.signal?.aborted) return cancelled();
  const root = input.projectRoot.trim();
  if (!root) return { outcome: "failed", reply: "", error: "Open a project first." };
  let doc: PinDocument;
  try {
    doc = input.load ? await input.load() : await defaultLoad(root);
  } catch (error) {
    return {
      outcome: "failed",
      reply: "",
      error: isTimeout(error) ? "Could not read the pin list this time." : "Could not read the pin list.",
    };
  }
  if (input.signal?.aborted) return cancelled();
  const reports: PinReport[] = [];
  for (const pin of doc.pins) {
    if (input.signal?.aborted) return cancelled();
    if (!githubSlug(pin.url)) {
      reports.push(interpretFetch(pin, emptyFetch({ rejected: true, started: false })));
      continue;
    }
    try {
      const bodies = input.fetchPin ? await input.fetchPin(pin) : await defaultFetch(pin);
      reports.push(interpretFetch(pin, bodies));
    } catch {
      reports.push(interpretFetch(pin, emptyFetch({ unreachable: true })));
    }
  }
  if (input.signal?.aborted) return cancelled();
  const markdown = changesMarkdown(root, reports);
  try {
    if (input.write) await input.write(markdown);
    else await defaultWrite(root, markdown);
  } catch (error) {
    return {
      outcome: "failed",
      reply: "",
      error: isTimeout(error) ? "Could not write the summary this time." : "Could not write the summary.",
    };
  }
  const reply = watchIsQuiet(reports) ? QUIET_MARKER : chatReply(reports);
  const summary = activityLine(markdown);
  if (summary && input.actorId.trim()) {
    try {
      if (input.note) await input.note(summary, projectLabel(root));
      else await defaultNote(input, summary, projectLabel(root));
    } catch {
      // The summary file is the record. A missed activity row is not a failed check.
    }
  }
  return { outcome: watchIsQuiet(reports) ? "quiet" : "posted", reply };
}
