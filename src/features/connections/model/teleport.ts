// Moving a chat between this Mac and a host the person has added (WP-177).
//
// A move is a custody handover, and the order is what keeps the chat from being lost:
//   1. the source freezes the chat,
//   2. the target stores a copy as incoming (it does not run),
//   3. the target checks the copy's hash,
//   4. the target activates its copy (it throws if the copy is missing),
//   5. only then does the source release its transcript.
// Every step persists on the machine that does it, so a crash at any point leaves the chat on one machine or the
// other, and recoverMove finishes or undoes the move from what is stored.
//
// Secrets: every string in the transcript, the title and the queued messages is redacted with the shared list
// (src/features/portable/model/secretPatterns.json) before it is planned, so the copy that travels is the redacted
// one. The plan shows the queued text and how many values were redacted.
//
// Approval: a move needs a PersonApproval, which only a trusted click can create (approvePlan). A plan id alone is
// not an approval. This module has no network, no timers and no listener.

import { redactText, redactValue } from "../../portable/model/secrets";

export type Provider = "claude" | "codex";

/** What a move carries of a chat. The transcript is the chat's saved blocks, as JSON text. */
export interface ChatSnapshot {
  chatId: string;
  provider: Provider;
  providerSessionId: string;
  model: string;
  effort: string;
  title: string;
  transcript: string;
  queued: readonly string[];
  turnRunning: boolean;
  approvalPending: boolean;
  /** Settings the chat actually has (Codex keeps its effort as reasoningEffort). Absent keys are not invented. */
  modelSettings?: Record<string, string>;
}

/** The fields a target receives. Built by allow list, never by copying the whole chat. */
export type TransferChat = Pick<
  ChatSnapshot,
  "chatId" | "provider" | "providerSessionId" | "model" | "effort" | "title" | "transcript" | "queued" | "modelSettings"
>;

/** Who holds a chat, and its live copy if this machine is the one that runs it. */
export interface ChatRecord {
  owner: string;
  live: ChatSnapshot | null;
}

export interface Manifest {
  format: "hivra-teleport-v1";
  moveId: string;
  chatId: string;
  provider: Provider;
  providerSessionId: string;
  model: string;
  effort: string;
  title: string;
  queuedCount: number;
  transcriptBytes: number;
  transcriptSha256: string;
  from: string;
  to: string;
  at: string;
}

export interface MovePayload {
  manifest: Manifest;
  chat: TransferChat;
}

export type CanResume = { ok: true } | { ok: false; reason: string };
export type ReceiveReply = { ok: true; transcriptSha256: string } | { ok: false; reason: "held" };
export type Holds = "live" | "incoming" | "none";

/**
 * Lease for a chat on one machine (WP-60). On the host this is the session lease file, which refuses a second
 * holder while the first is alive. A holder that died counts as released.
 */
export interface LeasePort {
  acquire(chatId: string, holder: string): boolean;
  release(chatId: string, holder: string): void;
}

/**
 * One machine's side of a move. The source uses read, freeze, thaw and release. The target uses canResume,
 * receive, activate and discard. holds reports what this machine stores for a move, so recovery can tell where the
 * chat is. Every write names the move, so a late or repeated call cannot touch another move's copy.
 */
export interface MoveEndpoint {
  readonly id: string;
  read(chatId: string): Promise<ChatRecord | null>;
  /** Stop new turns on this chat. False when another move already froze it. */
  freeze(chatId: string, moveId: string, peer: string): Promise<boolean>;
  thaw(chatId: string, moveId: string): Promise<void>;
  canResume(provider: Provider, model: string, effort: string): Promise<CanResume>;
  /** Store the copy as incoming (it does not run) and take the lease. */
  receive(chatId: string, moveId: string, payload: MovePayload): Promise<ReceiveReply>;
  /** Remove an incoming copy this move stored. Nothing else is touched. */
  discard(chatId: string, moveId: string): Promise<void>;
  /**
   * The target's atomic answer for a move that will not complete (M1). It either drops the move's incoming copy and
   * refuses this move id from now on, so a late copy or activation of it is turned away (returns "aborted"), or, when
   * it already opened the copy, reports "live". Only "aborted" lets the source thaw its freeze.
   */
  abort(chatId: string, moveId: string): Promise<"aborted" | "live">;
  /** Turn the incoming copy into the live one, owned here. Throws when there is no copy. Idempotent for this move. */
  activate(chatId: string, moveId: string): Promise<void>;
  /** Drop this machine's transcript and record the new owner. Only after the target activated. */
  release(chatId: string, moveId: string, to: string): Promise<void>;
  /**
   * The target drops its "release owed" note once the source has released. Optional: a machine that never records one
   * leaves it unset. Idempotent.
   */
  settleRelease?(chatId: string, moveId: string): Promise<void>;
  /** What this machine stores for the move: a live copy it activated, an incoming copy, or nothing. */
  holds(chatId: string, moveId: string): Promise<Holds>;
  /**
   * Remember, before the other machine is asked to freeze, that this move asked it to. A lost reply then still has a
   * move id to thaw. Optional: a machine that is not this Mac leaves it unset.
   */
  noteFreezeAsk?(chatId: string, moveId: string, sourceId: string): Promise<void>;
  /** Drop that note once the freeze reply arrived, or once the thaw did. */
  clearFreezeAsk?(chatId: string, moveId: string): Promise<void>;
}

export interface FreezeRefusal {
  reason: "turn-running" | "approval-pending";
  message: string;
  offer: "finish-then-move";
}

export type MoveRefusalReason =
  | "turn-running"
  | "approval-pending"
  | "approval-missing"
  | "approval-stale"
  | "invalid-session-id"
  | "private-key-held"
  | "id-mismatch"
  | "not-found"
  | "not-owner"
  | "cannot-resume"
  | "held-elsewhere"
  | "state-changed";

export interface MoveRefusal {
  reason: MoveRefusalReason;
  message: string;
  recapOffered?: boolean;
}

/** What the person reads before approving. The queued text and the redaction count are shown. */
export interface MovePlan {
  planId: string;
  chatId: string;
  from: string;
  to: string;
  provider: Provider;
  model: string;
  effort: string;
  title: string;
  queued: readonly string[];
  redactions: number;
  transcriptSha256: string;
}

/** Only approvePlan creates one. A plain object with a plan id is refused. */
export interface PersonApproval {
  readonly planId: string;
  readonly grant: symbol;
}

export type MoveStage = "read" | "freeze" | "resume-check" | "manifest" | "receive" | "verify" | "activate" | "release";

export type MoveResult =
  | { status: "moved"; chatId: string; to: string; from?: string; manifest?: Manifest }
  | { status: "refused"; refusal: MoveRefusal }
  | { status: "failed"; stage: MoveStage; message: string; chatStayedOn: string }
  | { status: "partial"; stage: "release"; chatId: string; to: string; moveId: string; message: string }
  | { status: "recovered"; chatId: string; chatStayedOn: string }
  | { status: "unknown"; chatId: string; to: string; moveId: string; message: string };

export interface MoveInput {
  chatId: string;
  from: MoveEndpoint;
  to: MoveEndpoint;
  approval: PersonApproval | null | undefined;
  moveId: string;
  at: string;
}

const FREEZE_COPY: Record<FreezeRefusal["reason"], string> = {
  "turn-running": "This chat is still working on a turn. It can move once that turn finishes.",
  "approval-pending": "This chat is waiting for your approval. Answer it, and then it can move.",
};

const MANIFEST_FIELDS = [
  "at",
  "chatId",
  "effort",
  "format",
  "from",
  "model",
  "moveId",
  "provider",
  "providerSessionId",
  "queuedCount",
  "title",
  "to",
  "transcriptBytes",
  "transcriptSha256",
] as const;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\.credentials\.json|\bauth\.json\b|\bkeychain\b/i,
];

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SECRET_SETTING_NAME = /^(token|api[_-]?key|access[_-]?key|secret|password|passwd|private[_-]?key|credential)$/i;
const SECRET_SETTING_VALUE = /sk-[A-Za-z0-9_-]{8,}|AGE-SECRET-KEY-1|PRIVATE KEY|PuTTY-User-Key-File/;

/** A model setting whose name or value is a key. It is dropped, not carried. */
export function settingLooksSecret(key: string, value: string): boolean {
  return SECRET_SETTING_NAME.test(key) || SECRET_SETTING_VALUE.test(value);
}

/** Settings a move may carry. Anything else stays on the machine that saved it, including names the secret list misses. */
const CARRIED_SETTING_KEYS = new Set(["effort", "reasoningEffort"]);

/** True when this setting is on the carry list and is not a secret. */
export function settingMayTravel(key: string, value: string): boolean {
  return CARRIED_SETTING_KEYS.has(key) && !settingLooksSecret(key, value);
}

/** Why a chat that is running or waiting cannot move yet. Null when it can move now. */
export function freezeRefusal(chat: Pick<ChatSnapshot, "turnRunning" | "approvalPending">): FreezeRefusal | null {
  if (chat.turnRunning) return { reason: "turn-running", message: FREEZE_COPY["turn-running"], offer: "finish-then-move" };
  if (chat.approvalPending) {
    return { reason: "approval-pending", message: FREEZE_COPY["approval-pending"], offer: "finish-then-move" };
  }
  return null;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The shared list keeps a value only when it mixes letters and digits, so a letters-only password would pass it. A move
// is stricter: any value written after a secret-looking name is redacted, whatever its characters.
// `[` is excluded so a value already replaced with "[secret removed]" is not matched again (that used to count twice
// and leave "removed]" in the text). Names here cover assignments the shared list skips when the value is letters only.
const ASSIGNED_ANY = /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|db[_-]?pass|encryption[_-]?key|jwt[_-]?signing[_-]?key)(?:\\)?["']?\s*[:=]\s*(?:\\)?["']?)([^\s"',}\]\\[]{6,})/gi;

function redactAny(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(ASSIGNED_ANY, (_match, head: string) => {
    count += 1;
    return `${head}[secret removed]`;
  });
  return { text: out, count };
}

// Forms the shared list does not carry: HTTP Basic credentials, a private key from BEGIN to END or to the end of the
// text (truncated output has no END line), and a base64 encoding of a PEM header.
const BASIC_AUTH = /\b(Basic)\s+[A-Za-z0-9+/=]{8,}/g;
const PEM_TO_END = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const PGP_BLOCK = /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?(?:-----END PGP PRIVATE KEY BLOCK-----|$)/g;
const PUTTY_PRIVATE_LINE = /(Private-Lines:[ \t]*\d+[ \t]*\r?\n)([^\r\n]*)/g;
const AGE_SECRET = /AGE-SECRET-KEY-1[0-9A-Z]+/g;
// base64("-----BEGIN") when that text starts at byte offset 0, 1 or 2. A wrapped encoding splits it across lines.
// The three strings only locate a one-line token. A run is decoded and checked, so a marker alone is not a private key.
const PEM_MARKERS = ["LS0tLS1CRUdJTi", "0tLS0tQkVHSU4", "tLS0tLUJFR0lO"] as const;
const MIN_BASE64_RUN = 40;
// No `g` flag: privateKeyPresent uses test(), which is stateful on a global expression.
// The base64 clause is bounded so a line of repeated markers cannot backtrack.
// OpenSSH bodies start with base64("openssh-key-v1\0") even when the armor lines were cut off. SSH2 (RFC 4716) armor
// uses four dashes and spaces, which "PRIVATE KEY-----" does not match.
const PRIVATE_KEY_HEADER = /PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File|Private-Lines:[ \t]*[0-9]|AGE-SECRET-KEY-1|LS0tLS1CRUdJTi[A-Za-z0-9+/=]{0,24}UFJJVkFURS|b3BlbnNzaC1rZXktdjE|---- BEGIN SSH2 (?:ENCRYPTED )?PRIVATE KEY ----/;
const COOKIE_SESSION = /Cookie\s*:\s*session=([^\s;]{6,})/gi;
const NETRC_PASSWORD = /(^|[\n\r])([ \t]*password[ \t]+)([^\s]{6,})/gi;
const MYSQL_PASSWORD = /(mysql\s+-p)(\S{4,})/gi;
const AUTH_TOKEN = /Authorization\s*:\s*token\s+[A-Fa-f0-9]{8,}/gi;
// A comma-separated row (`aws_secret_access_key,VALUE`) is not an assignment, so the shared list misses it.
const AWS_SECRET_CSV = /((?:aws[_-]?secret[_-]?access[_-]?key)(?:\\)?["']?\s*,\s*(?:\\)?["']?)([^\s"',}\\]{8,})/gi;
// OPENAI_API_KEY matches api_key. OPENAI_KEY does not.
const OPENAI_KEY_ASSIGN = /((?:openai[_-]?key)(?:\\)?["']?\s*[:=]\s*(?:\\)?["']?)([^\s"',}\\]{6,})/gi;
// A Discord user or MFA token. Bot tokens (xoxb-) are already on the shared list.
const DISCORD_TOKEN = /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})\b/g;

function redactExtra(text: string): { text: string; count: number } {
  let count = 0;
  let out = text.replace(BASIC_AUTH, (_m, word: string) => {
    count += 1;
    return `${word} [secret removed]`;
  });
  out = out.replace(PEM_TO_END, () => {
    count += 1;
    return "[secret removed]";
  });
  out = out.replace(PGP_BLOCK, () => {
    count += 1;
    return "[secret removed]";
  });
  out = out.replace(PUTTY_PRIVATE_LINE, (_match, head: string) => {
    count += 1;
    return `${head}[secret removed]`;
  });
  out = out.replace(AGE_SECRET, () => {
    count += 1;
    return "[secret removed]";
  });
  const pem = redactBase64Pem(out);
  count += pem.count;
  out = pem.text;
  out = out.replace(COOKIE_SESSION, () => {
    count += 1;
    return "Cookie: session=[secret removed]";
  });
  out = out.replace(NETRC_PASSWORD, (_match, lead: string, head: string) => {
    count += 1;
    return `${lead}${head}[secret removed]`;
  });
  out = out.replace(MYSQL_PASSWORD, (_match, head: string) => {
    count += 1;
    return `${head}[secret removed]`;
  });
  out = out.replace(AUTH_TOKEN, () => {
    count += 1;
    return "Authorization: token [secret removed]";
  });
  out = out.replace(AWS_SECRET_CSV, (_match, head: string) => {
    count += 1;
    return `${head}[secret removed]`;
  });
  out = out.replace(OPENAI_KEY_ASSIGN, (_match, head: string) => {
    count += 1;
    return `${head}[secret removed]`;
  });
  out = out.replace(DISCORD_TOKEN, () => {
    count += 1;
    return "[secret removed]";
  });
  return { text: out, count };
}

function redactString(text: string): { text: string; count: number } {
  const shared = redactText(text);
  const strict = redactAny(shared.text);
  const extra = redactExtra(strict.text);
  return { text: extra.text, count: shared.count + strict.count + extra.count };
}

function pureBase64Line(line: string, min = 4): boolean {
  const trimmed = line.trim();
  return trimmed.length >= min && /^[A-Za-z0-9+/=]+$/.test(trimmed);
}

/** A pure base64 run of at least 40 characters, including one short wrapped tail. */
function collectBase64Runs(lines: string[]): Array<{ start: number; end: number; compact: string }> {
  const runs: Array<{ start: number; end: number; compact: string }> = [];
  let index = 0;
  while (index < lines.length) {
    if (!pureBase64Line(lines[index] ?? "")) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < lines.length && pureBase64Line(lines[index] ?? "")) index += 1;
    // A wrap's last line can be 1 to 3 characters. Take it only when it does not start another long run.
    if (
      index < lines.length &&
      pureBase64Line(lines[index] ?? "", 1) &&
      !pureBase64Line(lines[index + 1] ?? "")
    ) {
      index += 1;
    }
    const compact = lines
      .slice(start, index)
      .map((line) => (line ?? "").trim())
      .join("");
    if (compact.length >= MIN_BASE64_RUN) runs.push({ start, end: index, compact });
  }
  return runs;
}

function decodeBase64Text(compact: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length < MIN_BASE64_RUN) return null;
  // One leftover character is a truncated quantum, not a reason to skip the key in front of it.
  const body = compact.length % 4 === 1 ? compact.slice(0, -1) : compact;
  if (body.length < MIN_BASE64_RUN) return null;
  const padded = body.length % 4 === 0 ? body : `${body}${"=".repeat(4 - (body.length % 4))}`;
  try {
    return globalThis.atob(padded);
  } catch {
    return null;
  }
}

function decodedIsPrivateKey(compact: string): boolean {
  const decoded = decodeBase64Text(compact);
  return decoded !== null && PRIVATE_KEY_HEADER.test(decoded);
}

/** The earliest marker at or after `from`, or -1. */
function markerIndex(text: string, from: number): number {
  let found = -1;
  for (const marker of PEM_MARKERS) {
    const at = text.indexOf(marker, from);
    if (at >= 0 && (found < 0 || at < found)) found = at;
  }
  return found;
}

/**
 * The base64 word that contains `at`. Scanning back stops at `=`, so a token like KEY= is not pulled into the word.
 * The caller always continues from `end`, so repeated markers are one word.
 */
function isBase64Body(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 43 ||
    code === 47
  );
}

function base64WordAt(text: string, at: number): { start: number; end: number } {
  let start = at;
  while (start > 0 && isBase64Body(text.charCodeAt(start - 1))) start -= 1;
  let end = at;
  while (end < text.length && isBase64Body(text.charCodeAt(end))) end += 1;
  let pads = 0;
  while (pads < 2 && end < text.length && text.charCodeAt(end) === 61) {
    end += 1;
    pads += 1;
  }
  return { start, end };
}

function lineHoldsPrivateKey(line: string): boolean {
  let from = 0;
  while (from < line.length) {
    const at = markerIndex(line, from);
    if (at < 0) return false;
    const word = base64WordAt(line, at);
    if (decodedIsPrivateKey(line.slice(word.start, word.end))) return true;
    from = Math.max(word.end, at + 1);
  }
  return false;
}

/** A base64 run that decodes to a private-key header, including one wrapped across lines or written on one line. */
function decodedPemMatchesHeader(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const inRun = new Set<number>();
  for (const run of collectBase64Runs(lines)) {
    if (decodedIsPrivateKey(run.compact)) return true;
    for (let i = run.start; i < run.end; i += 1) inRun.add(i);
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (inRun.has(i)) continue;
    if (lineHoldsPrivateKey(lines[i] ?? "")) return true;
  }
  return false;
}

/** Replaces a one-line base64 private key. A word that is not a key is copied through, and the scan jumps past it. */
function redactBase64Words(line: string): { text: string; count: number } {
  let count = 0;
  let out = "";
  let cursor = 0;
  while (cursor < line.length) {
    const at = markerIndex(line, cursor);
    if (at < 0) {
      out += line.slice(cursor);
      break;
    }
    const word = base64WordAt(line, at);
    const end = Math.max(word.end, at + 1);
    if (decodedIsPrivateKey(line.slice(word.start, word.end))) {
      out += `${line.slice(cursor, word.start)}[secret removed]`;
      count += 1;
    } else {
      out += line.slice(cursor, end);
    }
    cursor = end;
  }
  return { text: out, count };
}

/**
 * Replaces a base64 private key, including one wrapped across lines. A run that is not a key is copied once and the
 * scan jumps to the run's end, so a long file of ordinary base64 is not read again from every line.
 */
function redactBase64Pem(text: string): { text: string; count: number } {
  const lines = text.split("\n");
  const runs = collectBase64Runs(lines);
  let count = 0;
  const out: string[] = [];
  let index = 0;
  let runAt = 0;
  while (index < lines.length) {
    const run = runs[runAt];
    if (run && run.start === index) {
      if (decodedIsPrivateKey(run.compact)) {
        out.push("[secret removed]");
        count += 1;
      } else {
        for (let line = run.start; line < run.end; line += 1) {
          const redacted = redactBase64Words(lines[line] ?? "");
          out.push(redacted.text);
          count += redacted.count;
        }
      }
      index = run.end;
      runAt += 1;
      continue;
    }
    const redacted = redactBase64Words(lines[index] ?? "");
    out.push(redacted.text);
    count += redacted.count;
    index += 1;
  }
  return { text: out.join("\n"), count };
}

/** The text a move would carry, joined: a private key split across blocks shows up here, not in any one block. */
function privateKeyPresent(strings: string[]): boolean {
  const joined = strings.join("\n");
  return PRIVATE_KEY_HEADER.test(joined) || decodedPemMatchesHeader(joined);
}

/** Which part of the chat holds a private key, named so a person can find it. The key itself is never included. */
function keyHoldWhere(chat: ChatSnapshot): string | null {
  const safe = (value: string) => value.length > 0 && value.length <= 80 && !privateKeyPresent([value]);
  if (privateKeyPresent([chat.title])) return "the title";
  for (let index = 0; index < chat.queued.length; index += 1) {
    if (privateKeyPresent([chat.queued[index] ?? ""])) return `queued message ${index + 1}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(chat.transcript) as unknown;
  } catch {
    return privateKeyPresent([chat.transcript]) ? "the transcript" : null;
  }
  if (!Array.isArray(parsed)) return privateKeyPresent([chat.transcript]) ? "the transcript" : null;
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (!privateKeyPresent(collectStrings(block))) continue;
    const id = typeof block.id === "string" && safe(block.id) ? block.id : "";
    const tool = block.tool && typeof block.tool === "object" ? (block.tool as { title?: unknown }).title : undefined;
    const role = typeof block.role === "string" && safe(block.role) ? block.role : "message";
    const toolTitle = typeof tool === "string" && safe(tool.trim()) ? tool.trim() : "";
    const label = toolTitle || role;
    return id ? `the ${label} message ${id}` : `a ${label} message`;
  }
  return null;
}

function keyHoldMessage(chat: ChatSnapshot): string {
  const where = keyHoldWhere(chat);
  if (!where) return "A private key is in this chat, so the move is held. Nothing was sent.";
  return `A private key is in ${where}, so the move is held. Nothing was sent.`;
}

/** Every string in a parsed value, mapped; keys are kept. Redaction runs on the strings, not on their JSON text. */
function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, mapStrings(item, fn)]));
  }
  return value;
}

/** Redact the transcript (parsed, so every string and secret key is reached), the title and the queued messages. */
export function redactChat(chat: ChatSnapshot): { chat: ChatSnapshot; redactions: number } {
  let redactions = 0;
  let transcript: string;
  try {
    const parsed = redactValue(JSON.parse(chat.transcript) as unknown);
    redactions += parsed.count;
    const walked = mapStrings(parsed.value, (text) => {
      const out = redactString(text);
      redactions += out.count;
      return out.text;
    });
    transcript = JSON.stringify(walked);
  } catch {
    const plain = redactString(chat.transcript);
    redactions += plain.count;
    transcript = plain.text;
  }
  const title = redactString(chat.title);
  redactions += title.count;
  const queued = chat.queued.map((text) => {
    const out = redactString(text);
    redactions += out.count;
    return out.text;
  });
  const keptSettings: Record<string, string> = {};
  for (const [key, value] of Object.entries(chat.modelSettings ?? {})) {
    if (typeof value !== "string") continue;
    if (!settingMayTravel(key, value)) {
      redactions += 1;
      continue;
    }
    const out = redactString(value);
    redactions += out.count;
    keptSettings[key] = out.text;
  }
  const next: ChatSnapshot = { ...chat, transcript, title: title.text, queued };
  if (Object.keys(keptSettings).length > 0) next.modelSettings = keptSettings;
  else delete next.modelSettings;
  return { chat: next, redactions };
}

function transcriptStrings(transcript: string): string[] {
  try {
    return collectStrings(JSON.parse(transcript) as unknown);
  } catch {
    return [transcript];
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
  return [];
}

/** Throws when the manifest or payload names a different chat than the one being moved. */
export function assertSameChat(chatId: string, payload: MovePayload): void {
  if (payload.chat.chatId !== chatId || payload.manifest.chatId !== chatId) {
    throw new Error("The move names a different chat than the one being moved");
  }
}

export function assertManifestClean(manifest: Manifest): void {
  const allowed: readonly string[] = MANIFEST_FIELDS;
  for (const key of Object.keys(manifest)) {
    if (!allowed.includes(key)) throw new Error(`The move manifest has a field this move does not allow: ${key}`);
  }
  for (const [key, value] of Object.entries(manifest)) {
    if (typeof value !== "string") continue;
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error(`The move manifest value for ${key} looks like a secret, so the move was stopped`);
    }
  }
}

export function buildManifest(
  chat: ChatSnapshot,
  opts: { moveId: string; from: string; to: string; at: string; transcriptSha256: string },
): Manifest {
  return {
    format: "hivra-teleport-v1",
    moveId: opts.moveId,
    chatId: chat.chatId,
    provider: chat.provider,
    providerSessionId: chat.providerSessionId,
    model: chat.model,
    effort: chat.effort,
    title: chat.title,
    queuedCount: chat.queued.length,
    transcriptBytes: new TextEncoder().encode(chat.transcript).length,
    transcriptSha256: opts.transcriptSha256,
    from: opts.from,
    to: opts.to,
    at: opts.at,
  };
}

function pickTransferChat(chat: ChatSnapshot): TransferChat {
  return {
    chatId: chat.chatId,
    provider: chat.provider,
    providerSessionId: chat.providerSessionId,
    model: chat.model,
    effort: chat.effort,
    title: chat.title,
    transcript: chat.transcript,
    queued: [...chat.queued],
    ...(chat.modelSettings && Object.keys(chat.modelSettings).length > 0 ? { modelSettings: { ...chat.modelSettings } } : {}),
  };
}

async function buildPayload(
  chat: ChatSnapshot,
  opts: { moveId: string; from: string; to: string; at: string },
): Promise<MovePayload> {
  const transcriptSha256 = await sha256Hex(chat.transcript);
  const manifest = buildManifest(chat, { ...opts, transcriptSha256 });
  return { manifest, chat: pickTransferChat(chat) };
}

/**
 * The plan the person approves before anything moves. The plan carries the redacted chat, so what the person reads is
 * what travels. Refused with the reason when the chat cannot move now.
 */
export async function planMove(
  chat: ChatSnapshot,
  from: string,
  to: string,
): Promise<{ ok: true; plan: MovePlan } | { ok: false; refusal: MoveRefusal }> {
  const frozen = freezeRefusal(chat);
  if (frozen) return { ok: false, refusal: { reason: frozen.reason, message: frozen.message } };
  const strings = [chat.title, ...chat.queued, ...transcriptStrings(chat.transcript)];
  if (privateKeyPresent(strings)) {
    return { ok: false, refusal: { reason: "private-key-held", message: keyHoldMessage(chat) } };
  }
  if (chat.providerSessionId && !SESSION_ID.test(chat.providerSessionId)) {
    return { ok: false, refusal: { reason: "invalid-session-id", message: "This chat's session id is not in a form a move accepts." } };
  }
  const redacted = redactChat(chat);
  const transcriptSha256 = await sha256Hex(redacted.chat.transcript);
  const basis = {
    chatId: chat.chatId,
    from,
    to,
    provider: chat.provider,
    model: chat.model,
    effort: chat.effort,
    title: redacted.chat.title,
    queued: redacted.chat.queued,
    redactions: redacted.redactions,
    transcriptSha256,
  };
  const planId = await sha256Hex(JSON.stringify(basis));
  return { ok: true, plan: { planId, ...basis } };
}

const grants = new WeakSet<object>();

/** The approval a person's trusted click creates for one plan. Anything else is not an approval. */
export function approvePlan(plan: MovePlan, gesture: unknown): PersonApproval {
  // Only a real browser MouseEvent the person produced counts: a plain object with the same fields does not.
  const isRealClick =
    typeof MouseEvent !== "undefined" &&
    gesture instanceof MouseEvent &&
    gesture.isTrusted === true &&
    gesture.type === "click";
  if (!isRealClick) throw new Error("Only a person's click on the move approves it");
  const approval = Object.freeze({ planId: plan.planId, grant: Symbol("person-approval") });
  grants.add(approval);
  return approval;
}

function isGranted(approval: PersonApproval | null | undefined): approval is PersonApproval {
  return !!approval && typeof approval === "object" && grants.has(approval);
}

const noop = () => undefined;

function refuse(reason: MoveRefusalReason, message: string, recapOffered?: boolean): MoveResult {
  return { status: "refused", refusal: recapOffered ? { reason, message, recapOffered } : { reason, message } };
}

function failed(stage: MoveStage, chatStayedOn: string, error: unknown): MoveResult {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "failed", stage, message, chatStayedOn };
}

/**
 * Asks the target to refuse the move for good, then lets the source thaw only if the target answered "aborted" (M1). The
 * target's answer is atomic, so a copy it opened in the meantime is never thawed here: "live" and "unknown" both leave
 * the source frozen, and recoverMove settles the move once the target can be asked.
 */
async function refuseOnTarget(from: MoveEndpoint, to: MoveEndpoint, chatId: string, moveId: string): Promise<"aborted" | "live" | "unknown"> {
  let answer: "aborted" | "live";
  try {
    answer = await to.abort(chatId, moveId);
  } catch {
    return "unknown";
  }
  if (answer === "aborted") {
    try {
      await from.thaw(chatId, moveId);
    } catch {
      // The chat stays frozen here, which is safe: recovery thaws it later.
      return "unknown";
    }
    await to.clearFreezeAsk?.(chatId, moveId).catch(noop);
  }
  return answer;
}

/**
 * Hand a chat from one machine to the other, in the order the module comment gives. Every result except "partial"
 * leaves the chat live on exactly one machine. "partial" means the target has the chat and the source still holds its
 * transcript; completeMove finishes it.
 */
export async function moveChat(input: MoveInput): Promise<MoveResult> {
  const { chatId, from, to, approval, moveId, at } = input;
  if (!isGranted(approval)) return refuse("approval-missing", "Ask the person to approve this move first.");

  let record: ChatRecord | null;
  try {
    record = await from.read(chatId);
  } catch (error) {
    return failed("read", from.id, error);
  }
  if (!record) return refuse("not-found", "This chat is not on this machine.");
  if (record.owner !== from.id) return refuse("not-owner", `This chat is on ${record.owner}, not on this machine.`);
  if (!record.live || record.live.chatId !== chatId) return refuse("id-mismatch", "This chat's record names another chat.");

  const planned = await planMove(record.live, from.id, to.id);
  if (!planned.ok) return { status: "refused", refusal: planned.refusal };
  if (planned.plan.planId !== approval.planId) {
    return refuse("approval-stale", "The chat changed after you approved the move. Review it again.");
  }

  let resume: CanResume;
  let back: CanResume;
  try {
    resume = await to.canResume(record.live.provider, record.live.model, record.live.effort);
    // A provider the source cannot run again must not leave: the chat could not be moved back.
    back = await from.canResume(record.live.provider, record.live.model, record.live.effort);
  } catch (error) {
    return failed("resume-check", from.id, error);
  }
  if (!resume.ok) {
    return refuse(
      "cannot-resume",
      `The other machine cannot resume this chat's transcript: ${resume.reason}. Start a new chat from a recap instead.`,
      true,
    );
  }
  if (!back.ok) {
    return refuse(
      "cannot-resume",
      `This machine could not take the chat back later: ${back.reason}. Start a new chat from a recap instead.`,
      true,
    );
  }

  // The note is written before the freeze, on the machine that will recover. It stays until the incoming copy
  // replaces it, or until a thaw is confirmed. Clearing it on the freeze reply left nothing to thaw after a drop.
  try {
    await to.noteFreezeAsk?.(chatId, moveId, from.id);
  } catch (error) {
    return failed("freeze", from.id, error);
  }
  let frozen: boolean;
  try {
    frozen = await from.freeze(chatId, moveId, to.id);
  } catch (error) {
    let thawed = false;
    try {
      await from.thaw(chatId, moveId);
      thawed = true;
    } catch {
      thawed = false;
    }
    // The reply and the thaw were both lost: keep the note, so recovery can thaw this move id later.
    if (thawed) await to.clearFreezeAsk?.(chatId, moveId).catch(noop);
    return failed("freeze", from.id, error);
  }
  if (!frozen) {
    const again = await from.read(chatId).catch(() => null);
    const why = again?.live ? freezeRefusal(again.live) : null;
    if (why) return refuse(why.reason, why.message);
    return refuse("held-elsewhere", "Another move or a resume already holds this chat. Its result shows when it finishes.");
  }
  const undoFreeze = async () => {
    try {
      await from.thaw(chatId, moveId);
    } catch {
      // The thaw did not land. The freeze-ask note stays, and recovery thaws this move id later.
      return;
    }
    await to.clearFreezeAsk?.(chatId, moveId).catch(noop);
  };

  let payload: MovePayload;
  try {
    // Re-read under the freeze: the copy is the one that is frozen, not the one read before it.
    const now = await from.read(chatId);
    if (!now || now.owner !== from.id || !now.live || now.live.chatId !== chatId) {
      await undoFreeze();
      return refuse("state-changed", "The chat changed while the move started. Review it again.");
    }
    const again = await planMove(now.live, from.id, to.id);
    if (!again.ok) {
      await undoFreeze();
      return { status: "refused", refusal: again.refusal };
    }
    if (again.plan.planId !== approval.planId) {
      await undoFreeze();
      return refuse("approval-stale", "The chat changed after you approved the move. Review it again.");
    }
    const redacted = redactChat(now.live).chat;
    payload = await buildPayload(redacted, { moveId, from: from.id, to: to.id, at });
    assertManifestClean(payload.manifest);
    assertSameChat(chatId, payload);
  } catch (error) {
    await undoFreeze();
    return failed("manifest", from.id, error);
  }

  // Every failure after the target was asked goes through its atomic abort (M1): the target answers for this move id, and
  // only "aborted" lets the source thaw. A target that cannot answer leaves the chat frozen here, as "unknown".
  const unknownAfter = (message: string): MoveResult => ({ status: "unknown", chatId, to: to.id, moveId, message });
  let received: ReceiveReply;
  try {
    received = await to.receive(chatId, moveId, payload);
  } catch (error) {
    const answer = await refuseOnTarget(from, to, chatId, moveId);
    if (answer !== "aborted") return unknownAfter(error instanceof Error ? error.message : String(error));
    return failed("receive", from.id, error);
  }
  if (!received.ok) {
    const answer = await refuseOnTarget(from, to, chatId, moveId);
    if (answer !== "aborted") return unknownAfter("The other machine did not answer the move's copy step.");
    return refuse("held-elsewhere", "Another move or a resume already holds this chat. Its result shows when it finishes.");
  }
  if (received.transcriptSha256 !== payload.manifest.transcriptSha256) {
    const answer = await refuseOnTarget(from, to, chatId, moveId);
    if (answer !== "aborted") return unknownAfter("The other machine did not answer the transcript check.");
    return failed("verify", from.id, new Error("The copy on the other machine does not match the transcript. Nothing moved."));
  }

  // The target activates before the source lets go. If activation fails, the target refuses the move and the chat stays here.
  try {
    await to.activate(chatId, moveId);
  } catch (error) {
    // Activation may have stored the live copy before its reply was lost. Ask the target. If it cannot be asked, the
    // outcome is unknown: the source keeps its freeze, and recoverMove finishes the move once the target answers.
    let held: Holds;
    try {
      held = await to.holds(chatId, moveId);
    } catch (holdsError) {
      return unknownAfter(holdsError instanceof Error ? holdsError.message : String(holdsError));
    }
    if (held !== "live") {
      const answer = await refuseOnTarget(from, to, chatId, moveId);
      if (answer !== "aborted") return unknownAfter(error instanceof Error ? error.message : String(error));
      return failed("activate", from.id, error);
    }
  }

  try {
    await from.release(chatId, moveId, to.id);
  } catch (error) {
    return {
      status: "partial",
      stage: "release",
      chatId,
      to: to.id,
      moveId,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  await to.settleRelease?.(chatId, moveId).catch(noop);
  return { status: "moved", chatId, from: from.id, to: to.id, manifest: payload.manifest };
}

/**
 * Finish or undo a move after a crash or a failed step, from what each machine stores. The chat ends live on one
 * machine. If the target holds the live copy, the source releases its transcript. If the target holds only an
 * incoming copy, the copy is discarded and the source thaws. If the target holds nothing, the source thaws.
 */
export async function recoverMove(input: { chatId: string; moveId: string; from: MoveEndpoint; to: MoveEndpoint }): Promise<MoveResult> {
  const { chatId, moveId, from, to } = input;
  const unknown = (error: unknown): MoveResult => ({
    status: "unknown",
    chatId,
    to: to.id,
    moveId,
    message: error instanceof Error ? error.message : String(error),
  });
  // The target decides, atomically (M1): a copy it opened completes the move; otherwise it refuses this move id for good,
  // and only then does the source thaw. A target that cannot be asked leaves the chat frozen until it can.
  let answer: "aborted" | "live";
  try {
    answer = await to.abort(chatId, moveId);
  } catch (error) {
    return unknown(error);
  }
  if (answer === "live") {
    let record: ChatRecord | null;
    try {
      record = await from.read(chatId);
    } catch (error) {
      return unknown(error);
    }
    if (record?.live) {
      try {
        await from.release(chatId, moveId, to.id);
      } catch (error) {
        return { status: "partial", stage: "release", chatId, to: to.id, moveId, message: error instanceof Error ? error.message : String(error) };
      }
    }
    await to.settleRelease?.(chatId, moveId).catch(noop);
    return { status: "moved", chatId, to: to.id, from: from.id };
  }
  try {
    await from.thaw(chatId, moveId);
  } catch (error) {
    return unknown(error);
  }
  return { status: "recovered", chatId, chatStayedOn: from.id };
}

/** Retry the source's release of a partial move. Idempotent: an already released source reports moved. */
export async function completeMove(input: { chatId: string; from: MoveEndpoint; to: MoveEndpoint; moveId: string }): Promise<MoveResult> {
  return recoverMove({ chatId: input.chatId, moveId: input.moveId, from: input.from, to: input.to });
}
