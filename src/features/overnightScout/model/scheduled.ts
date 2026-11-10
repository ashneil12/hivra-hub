// WP-165: the night run is code. It does not call a model, and a store that does not answer is not a finished night.

import type { LocalHubDisk } from "../../hub/model/localHub/localHub";
import { runScout } from "./run";
import { fileInside, projectKeyFromCwd, SOURCES_FILE, WATCH_FILE_NAME } from "./paths";
import { changeScoutDoc, readScoutDoc, type ScoutDoc } from "./store";

export type ScoutTurn = { kind: "quiet" | "retry" };

async function defaultDisk(): Promise<LocalHubDisk> {
  const { tauriLocalHubDisk } = await import("../../hub/model/localHub/localTransport");
  return tauriLocalHubDisk;
}

async function readProjectFile(path: string): Promise<string> {
  const { readTextFile } = await import("../../../platform/tauri/fs");
  return readTextFile(path);
}

/** A missing file is empty input. Anything else, including a timeout, is not. */
function missingRead(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /os error 2\b|no such file|not a file/i.test(text);
}

async function readOptional(read: (path: string) => Promise<string>, path: string): Promise<string> {
  try {
    const text = await read(path);
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
  readText?: (path: string) => Promise<string>;
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
  if (doc.settings.enabled !== true) return { kind: "quiet" };

  const read = input.readText ?? readProjectFile;
  let sourcesText = "";
  let watchText = "";
  try {
    const sourcesPath = fileInside(input.cwd, SOURCES_FILE);
    if (sourcesPath) sourcesText = await readOptional(read, sourcesPath);
    const folder = doc.settings.watchFolder;
    if (folder) {
      const watchPath = fileInside(folder, WATCH_FILE_NAME);
      if (watchPath) watchText = await readOptional(read, watchPath);
    }
  } catch {
    return { kind: "retry" };
  }

  try {
    await changeScoutDoc(
      disk,
      (latest) => {
        if (latest.settings.enabled !== true) return latest;
        const placed = runScout({
          settings: latest.settings,
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
  } catch {
    return { kind: "retry" };
  }
  return { kind: "quiet" };
}
