// WP-126: disk reads for the per-CLI report. Tauri's directory listing has no
// symlink bit, so a linked skill is not merged here. The model still merges
// one when the reader reports a link.

import { homeDir, listDir, readTextFile } from "../../../platform/tauri/fs";
import { loadParityReport, type ParityFs, type ParityReport } from "./cliParity";

function timedOut(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /timeout|timed out/i.test(message);
}

export function tauriParityFs(): ParityFs {
  return {
    async readText(path) {
      try {
        const text = await readTextFile(path);
        return typeof text === "string" ? text : null;
      } catch (error) {
        if (timedOut(error)) throw error;
        return null;
      }
    },
    async list(path) {
      try {
        const entries = await listDir(path);
        if (!Array.isArray(entries)) return null;
        const out: { name: string; kind: "dir" | "file" }[] = [];
        for (const entry of entries) {
          if (!entry || typeof entry.name !== "string") continue;
          out.push({ name: entry.name, kind: entry.isDir === true ? "dir" : "file" });
        }
        return out;
      } catch (error) {
        if (timedOut(error)) throw error;
        return null;
      }
    },
    async readLink() {
      return null;
    },
  };
}

export async function loadProjectCliParity(project: string): Promise<ParityReport> {
  const home = await homeDir();
  if (typeof home !== "string" || !home.trim()) throw new Error("Home folder is missing");
  return loadParityReport(project, home, tauriParityFs());
}
