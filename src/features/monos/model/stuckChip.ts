// A stuck worker under the red rule (r30; statusChip.ts): one chip, one plain line. Red "Needs you" only when Ash must act
// (a billing or sign-in refusal: no Lead or retry can fix it); a crash self-repair is still retrying, or one its Lead
// retried, reads a grey "Retrying"; everything else is its Lead's to handle, a grey "With <Lead>". There is no "Stuck"
// word, and the line never carries the raw fault text or a file path.
import { NEEDS_YOU, RETRYING, withLead, type Chip } from "../../hub/model/statusChip";
import { REPAIR_BACKOFF_MS, repairableFailure } from "./selfRepair";
import { ashMustAct, failedTimes, stuckOwner, type StuckWorker } from "./workerStuck";

/** Only Ash can sort it (r30c): out of credits, a rejected key, signed out, a refused request, or out of retries. */
export function stuckNeedsAsh(stuck: Pick<StuckWorker, "kind" | "row">): boolean {
  return stuck.kind !== "asking" && stuckOwner(stuck) === "needs-you";
}

export function stuckWorkerChip(stuck: Pick<StuckWorker, "kind" | "row">, lead: string): Chip {
  if (stuck.kind === "asking") return { word: "Waiting", tone: "grey" };
  const owner = stuckOwner(stuck);
  if (owner === "needs-you") return NEEDS_YOU;
  if (owner === "retrying") return RETRYING;
  return withLead(lead);
}

const PLAIN_CLASS: Record<string, string> = {
  billing: "Out of credits",
  auth: "Signed out of its provider",
  overloaded: "The model is overloaded",
  provider_error: "The model's provider had a problem",
};

function clock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

/** A raw fault as one plain line: no file paths, codes or labels ("Test fault: … (dev-faults/x)" → "This worker …"). */
export function plainFault(raw: string | null | undefined): string {
  let text = (raw ?? "").trim().split("\n")[0] ?? "";
  text = text.split(/(?<=[.!?])\s/)[0] ?? text;
  text = text
    .replace(/\s*[([][^)\]]*(?:[/\\]|\.\w{1,4}\b|\d{3})[^)\]]*[)\]]/g, "") // "(dev-faults/fail-next-workers)", "(402)"
    .replace(/(?:~|\.{0,2})?(?:[/\\][\w.@-]+){2,}[/\\]?/g, "") // paths
    .replace(/\b[\w.-]+\.(?:ts|tsx|js|mjs|json|md|rs|py|log|txt|toml|ya?ml)\b(?::\d+)*/g, "") // file names
    .replace(/^(?:[\w-]+\s){0,2}(?:fault|error|failure|failed|exception)\s*:\s*/i, "")
    .replace(/\b(?:exit(?:ed)? (?:with )?code|status|code)\s*:?\s*\d+\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[\s,;:–—-]+$/, "")
    .trim();
  if (!text || /[{}<>=`$]|::|\b0x[0-9a-f]+/i.test(text) || text.length < 6 || !/\s/.test(text) || /^[A-Z_]{4,}\b/.test(text)) return "It stopped with an error";
  if (text.length > 120) text = `${text.slice(0, 120).replace(/\s+\S*$/, "")}…`;
  return text[0].toUpperCase() + text.slice(1);
}

/** The one plain line a stuck worker's card reads: why it failed, or how it stalled (already plain), or its question. */
export function plainStuckLine(stuck: Pick<StuckWorker, "kind" | "row" | "line">): string {
  if (stuck.kind !== "failed") return stuck.line;
  const row = stuck.row;
  const times = failedTimes(row);
  const ash = stuckOwner(stuck) === "needs-you" ? needsYouLine(stuck) : undefined;
  if (ash) return ash;
  if (times >= 2 && repairableFailure({ ...row, delivery: "pending" }))
    return `It crashed ${times} times${times > REPAIR_BACKOFF_MS.length ? " and its retries ran out" : ""}`;
  if (row.errorClass === "usage_limit") {
    const reset = row.resetsAt ? clock(row.resetsAt) : "";
    return `Out of usage${reset ? `. It resets ${reset}` : ""}`;
  }
  if (row.errorClass && PLAIN_CLASS[row.errorClass]) return PLAIN_CLASS[row.errorClass];
  return plainFault(row.error);
}

/**
 * The reason on a red "Needs you" worker (r30c), one plain line: "Out of credits", "Key rejected", "Signed out of its
 * provider", "Request refused", "Out of retries: it crashed 4 times". Undefined when Ash need not act.
 */
export function needsYouLine(stuck: Pick<StuckWorker, "kind" | "row">): string | undefined {
  if (stuck.kind !== "failed") return undefined;
  const row = stuck.row;
  switch (ashMustAct(row)) {
    case "credits":
      return PLAIN_CLASS.billing;
    case "key":
      return "Key rejected";
    case "signed-out":
      return PLAIN_CLASS.auth;
    case "refused":
      return "Request refused";
    case "out-of-retries": {
      const times = failedTimes(row);
      if (repairableFailure({ ...row, delivery: "pending" })) return `Out of retries: it crashed ${times} times`;
      const fault = plainFault(row.error);
      return `Out of retries: ${fault[0].toLowerCase()}${fault.slice(1).replace(/[.!?\s]+$/, "")}`;
    }
    default:
      return undefined;
  }
}
