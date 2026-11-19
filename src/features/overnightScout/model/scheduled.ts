// WP-165: the night run is code. It does not call a model, and a store that does not answer is not a finished night.

import type { LocalHubDisk } from "../../hub/model/localHub/localHub";
import { localDay } from "../../workLog/model/workLog";
import { runScout } from "./run";
import { fileInside, projectKeyFromCwd, SOURCES_FILE, WATCH_FILE_NAME } from "./paths";
import { changeScoutDoc, readScoutDoc, type ScoutDoc } from "./store";

export type ScoutTurn = { kind: "quiet" | "retry" };

async function defaultDisk(): Promise<LocalHubDisk> {
  const { tauriLocalHubDisk } = await import("../../hub/model/localHub/localTransport");
  return tauriLocalHubDisk;
}

type ScoutRead = (root: string, relative: string) => Promise<string>;

async function readProjectFile(root: string, relative: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("mobile_read_text_file", { root, relative });
}

function nightOf(time: number): string {
  const date = new Date(time);
  if (date.getHours() < 12) date.setDate(date.getDate() - 1);
  return localDay(date);
}

/** A missing file is empty input. Anything else, including a timeout, is not. */
function missingRead(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /os error 2\b|no such file|not a file/i.test(text);
}

async function readOptional(read: ScoutRead, root: string, relative: string): Promise<string> {
  if (!fileInside(root, relative)) return "";
  try {
    const text = await read(root, relative);
    if (typeof text !== "string") throw new Error("unreadable");
    return text;
  } catch (error) {
    if (missingRead(error)) return "";
    throw error;
  }
}

/**
 * One night. Off settles quietly. On reads the sources table and the approved watch file,
 * then writes drafts into the app record. A missing file is an empty night. A read or a
 * save that times out stays due, so the next check can try again.
 */
export async function runScheduledScout(input: {
  cwd: string;
  disk?: LocalHubDisk;
  readText?: ScoutRead;
  now?: number;
}): Promise<ScoutTurn> {
  const disk = input.disk ?? (await defaultDisk());
  const now = input.now ?? Date.now();
  let doc: ScoutDoc;
  try {
    doc = (await readScoutDoc(disk, now)).doc;
  } catch {
    return { kind: "retry" };
  }
  if (doc.settings.enabled !== true || !doc.settings.watchFolder || doc.settings.maxDrafts === 0) {
    return { kind: "quiet" };
  }

  const read = input.readText ?? readProjectFile;
  let sourcesText = "";
  let watchText = "";
  try {
    sourcesText = await readOptional(read, input.cwd, SOURCES_FILE);
    if (sourcesText) watchText = await readOptional(read, doc.settings.watchFolder, WATCH_FILE_NAME);
  } catch {
    return { kind: "retry" };
  }

  try {
    const saved = await changeScoutDoc(
      disk,
      (latest) => {
        if (latest.settings.enabled !== true || latest.settings.watchFolder !== doc.settings.watchFolder) return latest;
        const night = nightOf(now);
        const written = latest.rows.filter((row) => row.draft && nightOf(row.createdAt) === night).length;
        const placed = runScout({
          settings: { ...latest.settings, maxDrafts: Math.max(0, latest.settings.maxDrafts - written) },
          sourcesText,
          watchText,
          rows: latest.rows,
          briefs: latest.briefs,
          now,
          projectId: projectKeyFromCwd(input.cwd),
        });
        return { settings: latest.settings, rows: placed.rows, briefs: placed.briefs };
      },
      now,
    );
    if (saved.settings.enabled && saved.settings.watchFolder !== doc.settings.watchFolder) return { kind: "retry" };
  } catch {
    return { kind: "retry" };
  }
  return { kind: "quiet" };
}
