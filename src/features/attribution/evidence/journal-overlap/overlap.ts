// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution journal overlap (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.
// Rust src-tauri/src/attribution/logic.rs must hash the same bytes.

import { createHash } from "node:crypto";
import { isBoilerplate } from "../../gate";
import { normalizeLine } from "./normalize";

export type JournalLine = {
  hash: string;
  chatId: string;
  taskId: string | null;
  agent: string | null;
  at: number;
};

export { normalizeLine } from "./normalize";

/** Lower-case hex SHA-256 of the normalized line. */
export function hashLine(line: string): string {
  return createHash("sha256").update(normalizeLine(line), "utf8").digest("hex");
}

export type InferredRun = {
  chatId: string;
  taskId: string | null;
  agent: string | null;
  at: number;
  matches: number;
};

/**
 * The run with the most matching distinctive lines. A tie keeps the earliest
 * journal time. Inference needs at least two matches, and at least half of
 * the distinctive added lines. Boilerplate and repeated hashes do not count.
 */
export function inferRun(added: readonly string[], journal: readonly JournalLine[]): InferredRun | null {
  const seen = new Set<string>();
  const distinctive: string[] = [];
  for (const line of added) {
    if (isBoilerplate(line)) continue;
    const hash = hashLine(line);
    if (seen.has(hash)) continue;
    seen.add(hash);
    distinctive.push(hash);
  }
  if (distinctive.length === 0) return null;

  const runs = new Map<string, { hashes: Set<string>; at: number; chatId: string; taskId: string | null; agent: string | null }>();
  for (const row of journal) {
    if (!row.hash || !row.chatId) continue;
    const key = `${row.chatId}\0${row.taskId ?? ""}`;
    const found = runs.get(key);
    if (!found) {
      runs.set(key, {
        hashes: new Set([row.hash]),
        at: row.at,
        chatId: row.chatId,
        taskId: row.taskId,
        agent: row.agent,
      });
      continue;
    }
    found.hashes.add(row.hash);
    if (row.at < found.at) {
      found.at = row.at;
      found.agent = row.agent;
    }
  }

  let best: InferredRun | null = null;
  for (const run of runs.values()) {
    let matches = 0;
    for (const hash of distinctive) {
      if (run.hashes.has(hash)) matches += 1;
    }
    if (matches < 2) continue;
    if (matches * 2 < distinctive.length) continue;
    if (!best || matches > best.matches || (matches === best.matches && run.at < best.at)) {
      best = { chatId: run.chatId, taskId: run.taskId, agent: run.agent, at: run.at, matches };
    }
  }
  return best;
}
