// A Mono whose last turn failed (an API error: out of credits, overloaded, a usage limit, signed out) is in a state of
// its own, not idle with a line of provider text in its chat (Ash, 20 Oct baseline: a 402 left the Tally lead "idle" with
// "402 openrouter.ai said: Insufficient credits"). This reads that state from the chat: the plain reason the Monos
// rail, Today and Being built show ("Out of credits", "Out of usage until 05:00"), amber when it should work again by
// itself or with Try again, red when something has to be fixed first, and the provider's own words for "details".
import type { ProviderErrorClass } from "../../../integrations/harness/core/types";
import type { Block, Session } from "../../sessions/model/session";

export type TurnFailure = {
  /** The error notice it comes from ("usage-limit" for a chat stopped at its limit with no notice). */
  blockId: string;
  /** Plain words: "Out of credits", "The model is overloaded", "Out of usage until 05:00". */
  reason: string;
  /** Red: nothing works until something is fixed (billing, sign-in). Amber: it should work again (Try again, a reset). */
  tone: "red" | "amber";
  /** What the provider said, behind "details". */
  detail: string;
  errorClass?: ProviderErrorClass;
  /** Trying again as it is can work. */
  retryable: boolean;
  resetsAt?: number;
  /** Epoch ms it failed, when known. */
  at?: number;
};

const CREDITS = /credit|balance|insufficient|payment required|funds|quota/i;
const SIGNED_OUT = /log ?in|sign[ -]?in|expired|revoked|not logged/i;
const CONNECTION = /connection|timed out|timeout|econnreset|etimedout|socket hang up|fetch failed|no response/i;
/**
 * A provider turning the key or the sign-in away, in its own words: HTTP 401/403, "invalid (API) key", "incorrect API
 * key", "unauthorized", "authentication …". Some providers send it with no error kind (or a generic one), and it is
 * still Ash's to fix in Settings: red Needs you, never grey Can't answer (PM 22 Oct).
 */
const REJECTED_KEY =
  /\b(?:HTTP\s*)?40[13]\b|\binvalid[_ -]?(?:api[_ -]?)?key\b|\bincorrect api key\b|\bapi[_ -]?key\b[^.\n]{0,40}\b(?:invalid|not valid|revoked|expired|disabled|wrong)\b|\bunauthori[sz]ed\b|\bauthentication\b|\bnot authenticated\b/i;

/** The class to show a failure under: a key or sign-in the provider rejected is "auth" even when it gave no kind. */
export function failureClass(errorClass: ProviderErrorClass | undefined, detail: string): ProviderErrorClass | undefined {
  if ((errorClass === undefined || errorClass === "provider_error") && REJECTED_KEY.test(detail)) return "auth";
  return errorClass;
}

/** The CLI's own assistant line for a failed request ("API Error: 402 …"): part of the failure, not a reply. */
const API_ERROR_LINE = /^\s*API Error\b/i;

/** "05:00" in the Mac's own time; "Thu 05:00" when it is more than a day away. */
export function resetClock(at: number, now = Date.now()): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return at - now > 20 * 3_600_000 ? `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${hm}` : hm;
}

/** The plain reason and its colour, from what failed. */
export function plainFailure(
  failure: { errorClass?: ProviderErrorClass; retryable?: boolean; resetsAt?: number },
  detail: string,
  now = Date.now(),
): Pick<TurnFailure, "reason" | "tone"> {
  switch (failure.errorClass) {
    case "usage_limit":
      return {
        reason: failure.resetsAt != null && failure.resetsAt > now ? `Out of usage until ${resetClock(failure.resetsAt, now)}` : "Out of usage",
        tone: "amber",
      };
    case "billing":
      return { reason: CREDITS.test(detail) ? "Out of credits" : "Billing refused", tone: "red" };
    case "auth":
      return { reason: SIGNED_OUT.test(detail) ? "Signed out of the model" : "Sign-in refused", tone: "red" };
    case "overloaded":
      return { reason: "The model is overloaded", tone: "amber" };
    case "provider_error":
      if (CONNECTION.test(detail)) return { reason: "Lost the connection to the model", tone: "amber" };
      return failure.retryable === false
        ? { reason: "The model refused the request", tone: "red" }
        : { reason: "The model's API failed", tone: "amber" };
    default:
      return { reason: "Its last turn failed", tone: "amber" };
  }
}

function isFailureNotice(block: Block): boolean {
  return block.role === "system" && block.notice === "error";
}

/**
 * Why this chat's last turn failed, if it did and nothing has happened since: its last turn ended on an error notice
 * (status lines and the CLI's own "API Error" line around it don't count as anything happening), or it stopped at its
 * usage limit. A turn running, or anything said after the error, clears it.
 */
export function lastTurnFailure(
  session: Pick<Session, "blocks" | "busy" | "usageLimit" | "worktreeRemoved">,
  now = Date.now(),
): TurnFailure | undefined {
  if (session.busy || session.worktreeRemoved) return undefined;
  const { blocks } = session;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (isFailureNotice(block)) {
      const failure = block.failure ?? {};
      const detail = block.text.trim();
      const errorClass = failureClass(failure.errorClass ?? (session.usageLimit ? "usage_limit" : undefined), detail);
      const rejected = errorClass === "auth" && failure.errorClass !== "auth";
      const resetsAt = failure.resetsAt ?? session.usageLimit?.resetsAt;
      return {
        blockId: block.id,
        ...plainFailure({ ...failure, errorClass, resetsAt }, detail, now),
        detail,
        ...(errorClass ? { errorClass } : {}),
        retryable: rejected ? false : (failure.retryable ?? (errorClass !== "billing" && errorClass !== "auth")),
        ...(resetsAt != null ? { resetsAt } : {}),
        ...(failure.at != null ? { at: failure.at } : {}),
      };
    }
    if (block.role === "system") continue;
    if (block.role === "assistant" && API_ERROR_LINE.test(block.text)) continue;
    break;
  }
  if (session.usageLimit) {
    const resetsAt = session.usageLimit.resetsAt;
    return {
      blockId: "usage-limit",
      ...plainFailure({ errorClass: "usage_limit", resetsAt }, "", now),
      detail: "",
      errorClass: "usage_limit",
      retryable: true,
      ...(resetsAt != null ? { resetsAt } : {}),
    };
  }
  return undefined;
}

/**
 * The message of a turn that failed before the agent did anything for it (only the CLI's own "API Error" line and
 * notices after it): Try again sends it again, as Ash's words. A plain "continue" instead makes the agent take up
 * whatever it was on before (the realtest's Lead resumed a long task it had been stopped on). Undefined when the turn
 * had begun (it continues), or its message was the app's own hidden turn.
 */
export function failedTurnMessage(session: Pick<Session, "blocks">): Block | undefined {
  const { blocks } = session;
  let sawFailure = false;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (isFailureNotice(block)) {
      sawFailure = true;
      continue;
    }
    if (block.role === "system") continue;
    if (block.role === "assistant" && API_ERROR_LINE.test(block.text)) continue;
    if (!sawFailure || block.role !== "user" || block.draft) return undefined;
    return !block.internal && block.text.trim() ? block : undefined;
  }
  return undefined;
}

const NEXT_STEP: Partial<Record<ProviderErrorClass, string>> = {
  billing: " Add credits, then try again.",
  auth: " Sign in again, then try again.",
  overloaded: " Try again in a moment.",
};

/**
 * A failed turn's notice in a Mono's 1:1, in plain words (PM's r44 check: "Usage limit reached (429): You've hit your
 * weekly limit…"). The same error kinds as the rail, Today and Being built (plainFailure); never a status code. The
 * provider's own words stay on hover.
 */
export function plainChatError(block: Pick<Block, "text" | "failure">, now = Date.now()): string {
  const failure = block.failure ?? {};
  const detail = block.text.trim();
  if (failure.errorClass === "usage_limit") {
    const week = /week/i.test(detail) ? " this week" : "";
    const reset = failure.resetsAt != null && failure.resetsAt > now ? ` It resets ${resetClock(failure.resetsAt, now)}.` : "";
    return `Out of usage${week}.${reset}`;
  }
  if (failure.errorClass) {
    const { reason } = plainFailure(failure, detail, now);
    return `${reason}.${NEXT_STEP[failure.errorClass] ?? ""}`;
  }
  // Not classed: the words as they came, without status codes.
  return detail.replace(/^API Error:?\s*\d{3}\s*/i, "").replace(/\s*\(\d{3}\)/g, "").replace(/\b(HTTP|status)\s*\d{3}\b:?\s*/gi, "").trim() || "Its last turn failed.";
}

/** The CLI's own "API Error: 429 …" line in a chat: part of the failure notice beside it, not a reply. */
export function isApiErrorLine(block: Pick<Block, "role" | "text">): boolean {
  return block.role === "assistant" && API_ERROR_LINE.test(block.text);
}
