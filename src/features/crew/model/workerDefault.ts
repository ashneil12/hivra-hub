// WP-89: a worker default is { cli?, model?, effort? }. Reading an old project row
// (a Claude model and effort, no CLI) stays that Claude choice. Nothing here rewrites the row.

import { isCli } from "./clis";
import type { Pick } from "./resolve";

export type StoredProjectDefault = {
  cli?: string | null;
  model?: string | null;
  effort?: string | null;
};

function clean(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > 200 || /[\r\n]/.test(text)) return undefined;
  return text;
}

/**
 * What a stored project row means. A model or effort with no CLI is the old
 * Claude-only setting. A CLI that isn't one is dropped, not rewritten to Claude.
 * A blank row is unset.
 */
export function readProjectWorkerDefault(stored: StoredProjectDefault | null | undefined): Pick | undefined {
  if (!stored) return undefined;
  const model = clean(stored.model);
  const effort = clean(stored.effort);
  const rawCli = clean(stored.cli);
  const cli = rawCli && isCli(rawCli) ? rawCli : undefined;
  if (!cli && !model && !effort) return undefined;
  const assumed = !rawCli && (model || effort) ? "claude" : undefined;
  const use = cli ?? assumed;
  return {
    ...(use ? { cli: use } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}
