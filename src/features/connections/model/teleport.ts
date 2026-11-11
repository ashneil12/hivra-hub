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
// The base64url form of each marker is the same string (none of them contains + or /). A bare marker decodes to
// "-----BEGIN" and is not a key. A marker that does not decode, or that decodes to a cut or unknown label, holds.
const PEM_MARKERS = ["LS0tLS1CRUdJTi", "0tLS0tQkVHSU4", "tLS0tLUJFR0lO"] as const;
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
  // `-` and `_` are base64url. A line of either alphabet joins a run.
  return trimmed.length >= min && /^[A-Za-z0-9+/=_-]+$/.test(trimmed);
}

/** A pure base64 run, including one short wrapped tail. There is no minimum length: a short wrap can still be a key. */
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
    if (compact.length > 0) runs.push({ start, end: index, compact });
  }
  return runs;
}

function isBase64Body(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 43 ||
    code === 47 ||
    code === 45 ||
    code === 95
  );
}

/** Standard or url-safe base64, or null when it does not decode. A length of 1 mod 4 drops one character and tries again. */
function tryDecodeBase64(compact: string): string | null {
  let body = compact.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return null;
  if (body.length % 4 === 1) body = body.slice(0, -1);
  if (body.length < 4) return null;
  const padded = body.length % 4 === 0 ? body : `${body}${"=".repeat(4 - (body.length % 4))}`;
  try {
    return globalThis.atob(padded);
  } catch {
    return null;
  }
}

type KeyVerdict = "private" | "hold" | "clear";

// A complete BEGIN line clears only when its label is one of these. A private key is not here, and neither is a cut
// label: both hold. The bare BEGIN marker (no label at all) is not a key either; a long repeat of it is the timing case.
const HARMLESS_BEGIN_LABELS = new Set([
  "CERTIFICATE",
  "TRUSTED CERTIFICATE",
  "X509 CERTIFICATE",
  "PUBLIC KEY",
  "RSA PUBLIC KEY",
  "DSA PUBLIC KEY",
  "EC PUBLIC KEY",
  "ECDSA PUBLIC KEY",
  "CERTIFICATE REQUEST",
  "NEW CERTIFICATE REQUEST",
  "X509 CRL",
  "PKCS7",
  "CMS",
  "DH PARAMETERS",
  "EC PARAMETERS",
  "DSA PARAMETERS",
  "ECDSA PARAMETERS",
]);
const BEGIN_LINE = /-----BEGIN ([A-Z0-9]+(?: [A-Z0-9]+)*)-----/;

// Whitespace that must not keep a wrapped encoding from being one run. The ASCII class misses U+2028 and no-break space.
const KEY_WHITESPACE = new RegExp(
  "[\\t\\n\\r \\f\\v\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+",
  "g",
);

// A run up to this length is decoded whole. A longer one is decoded at both ends and searched for a header, so a
// megabyte of base64 is not decoded four times.
const WHOLE_DECODE_LIMIT = 32768;

type WindowKind = "private" | "harmless" | "labeled" | "bare" | "none";

function hasPemMarker(text: string): boolean {
  return PEM_MARKERS.some((marker) => text.indexOf(marker) >= 0);
}

/** Percent-encoding, one level. A form body or a webhook log writes the key this way. Invalid sequences are left as they are. */
function percentDecode(text: string): string {
  if (text.indexOf("%") < 0) return text;
  return text.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** A quoted reply (`> ` at the start of a line) is not part of the encoding. */
function stripQuotePrefixes(text: string): string {
  if (text.indexOf(">") < 0) return text;
  return text.replace(/(^|\r?\n)[ \t]*(?:>[ \t]?)+/g, "$1");
}

function classifyDecoded(text: string | null): WindowKind {
  if (text === null) return "none";
  if (PRIVATE_KEY_HEADER.test(text)) return "private";
  const line = BEGIN_LINE.exec(text);
  if (line && HARMLESS_BEGIN_LABELS.has(line[1] ?? "")) return "harmless";
  if (/-----BEGIN [A-Z0-9]/.test(text)) return "labeled";
  if (text.includes("-----BEGIN")) return "bare";
  return "none";
}

/** The four alignments of one run. `nested` decodes one more level when the plaintext holds a BEGIN marker. */
function decodeMatch(run: string, nested: boolean): boolean {
  for (let offset = 0; offset < 4; offset += 1) {
    if (offset >= run.length) break;
    const text = tryDecodeBase64(offset === 0 ? run : run.slice(offset));
    if (!text) continue;
    if (PRIVATE_KEY_HEADER.test(text)) return true;
    if (nested && nestedHolds(text)) return true;
  }
  return false;
}

/**
 * One more level, and no further. A base64 Kubernetes secret is a key encoded twice: the outer decode is the manifest,
 * and the inner base64 decodes to the PEM. A nested marker that is never proved harmless holds.
 */
function nestedHolds(decoded: string): boolean {
  if (!hasPemMarker(decoded)) return false;
  const find = markerFinder(decoded);
  const seen = new Set<string>();
  let from = 0;
  while (from < decoded.length) {
    const at = find(from);
    if (at < 0) return false;
    const word = base64WordAt(decoded, at);
    const inner = decoded.slice(word.start, word.end);
    const key = inner.length <= 160 ? inner : `${word.start}:${word.end}`;
    if (!seen.has(key)) {
      seen.add(key);
      if (seen.size > 16) return true;
      if (inner.length >= 8 && decodeMatch(inner, false)) return true;
    }
    from = Math.max(word.end, at + 1);
  }
  return false;
}

let headerNeedles: string[] | null = null;

/** Base64 of each header phrase at the three byte alignments, with the lead quantum cut off so the bytes before it do not matter. */
function headerNeedleList(): string[] {
  if (headerNeedles) return headerNeedles;
  const phrases = [
    "PRIVATE KEY-----",
    "PRIVATE KEY BLOCK-----",
    "PuTTY-User-Key-File",
    "AGE-SECRET-KEY-1",
    "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----",
    "---- BEGIN SSH2 PRIVATE KEY ----",
    "b3BlbnNzaC1rZXktdjE",
  ];
  const needles: string[] = [];
  for (const phrase of phrases) {
    for (let lead = 0; lead < 3; lead += 1) {
      let encoded = "";
      try {
        encoded = globalThis.btoa(`${"\0".repeat(lead)}${phrase}`).replace(/=+$/, "");
      } catch {
        continue;
      }
      const start = lead === 0 ? 0 : 4;
      const needle = encoded.slice(start, start + 20);
      if (needle.length >= 12 && !needles.includes(needle)) needles.push(needle);
    }
  }
  headerNeedles = needles;
  return needles;
}

function uniformRun(run: string): boolean {
  const first = run.charCodeAt(0);
  for (let i = 1; i < run.length; i += 1) {
    if (run.charCodeAt(i) !== first) return false;
  }
  return true;
}

/** A header anywhere in a long run, without decoding the whole run. */
function encodedHeaderInRun(run: string): boolean {
  if (uniformRun(run)) return false;
  const normalized = run.indexOf("-") >= 0 || run.indexOf("_") >= 0 ? run.replace(/-/g, "+").replace(/_/g, "/") : run;
  for (const needle of headerNeedleList()) {
    if (normalized.indexOf(needle) >= 0) return true;
  }
  return false;
}

function alignmentsMatchHeader(run: string, nested: boolean): boolean {
  if (run.length < 8) return false;
  if (run.length <= WHOLE_DECODE_LIMIT) return decodeMatch(run, nested);
  if (decodeMatch(run.slice(0, 8192), nested)) return true;
  if (decodeMatch(run.slice(-8192), nested)) return true;
  // Many BEGIN markers in a long run are judged by the marker windows (and held if they are not proved). Searching the
  // whole run for a header as well would dominate a megabyte of markers.
  if (hasPemMarker(run) && moreThan(run, 32)) return false;
  return encodedHeaderInRun(run);
}

/** True when more than `limit` BEGIN markers occur. Overlapping alignments count separately, and the walk stops at the limit. */
function moreThan(text: string, limit: number): boolean {
  const find = markerFinder(text);
  let from = 0;
  let count = 0;
  while (from < text.length) {
    const at = find(from);
    if (at < 0) return false;
    count += 1;
    if (count > limit) return true;
    from = at + 1;
  }
  return false;
}

/**
 * Split on internal `=` padding. Each run is decoded whole at every alignment and checked against the private-key rule.
 * A run with no BEGIN marker is not cleared for that reason: a PuTTY key, an age identity, an SSH2 key and a PEM whose
 * BEGIN line was cut off all decode to a header the marker windows never see.
 */
function runVerdict(compact: string): KeyVerdict {
  let hold = false;
  let start = 0;
  for (let i = 0; i <= compact.length; i += 1) {
    const code = i < compact.length ? compact.charCodeAt(i) : -1;
    const pad = code === 61;
    const end = pad || code < 0 || !isBase64Body(code);
    if (!end) continue;
    let cut = i;
    if (pad) {
      let pads = 0;
      while (pads < 2 && cut < compact.length && compact.charCodeAt(cut) === 61) {
        cut += 1;
        pads += 1;
      }
    }
    if (cut > start) {
      const verdict = segmentVerdict(compact.slice(start, cut));
      if (verdict === "private") return "private";
      if (verdict === "hold") hold = true;
    }
    start = pad ? cut : i + 1;
    if (pad) i = cut - 1;
  }
  return hold ? "hold" : "clear";
}

function segmentVerdict(segment: string): KeyVerdict {
  if (segment.length < 8) return "clear";
  // A pure repeat of the bare BEGIN marker is not a key, and decoding it whole is the slow case.
  if (repeatedRun(segment) > 0) return verdictOf(segment);
  if (alignmentsMatchHeader(segment, true)) return "private";
  if (!hasPemMarker(segment)) return "clear";
  return verdictOf(segment);
}

/** Enough base64 for any PEM header line, and no more. A long run is not decoded whole. */
const HEADER_WINDOW = 96;

/** The marker length when `segment` is nothing but that marker repeated, else 0. */
function repeatedRun(segment: string): number {
  for (const marker of PEM_MARKERS) {
    if (segment.length < marker.length || segment.length % marker.length !== 0) continue;
    if (!segment.startsWith(marker)) continue;
    let same = true;
    for (let i = marker.length; i < segment.length; i += marker.length) {
      if (!segment.startsWith(marker, i)) {
        same = false;
        break;
      }
    }
    if (same) return marker.length;
  }
  return 0;
}

/**
 * A window at each of the four alignments at or before every marker. A private-key header holds. A window clears only
 * when it decodes to a complete BEGIN line on the allow-list, or to the bare BEGIN marker with no label. A cut label,
 * an unknown label, or a marker that never decodes holds. The window is cached, so a line of the same marker is not
 * decoded again. A pure repeat is sampled once: every copy has the same windows. A long run with many markers is held:
 * the ones in the middle were not proved harmless.
 */
function verdictOf(segment: string): KeyVerdict {
  if (!hasPemMarker(segment)) return "clear";
  const period = repeatedRun(segment);
  if (period > 0) return classifyMarkerRegion(segment.slice(0, Math.min(segment.length, period + HEADER_WINDOW)));
  if (segment.length > 8192 && moreThan(segment, 32)) {
    // Ordinary chat text is joined in front of the run, so a pure marker repeat no longer starts at 0. The tail is
    // still that repeat: sample it. Anything else in a long run was not proved, so it holds.
    const at = markerFinder(segment)(0);
    // The head of a long run is already decoded. A short prefix in front of a pure marker tail is covered by that. A
    // longer prefix was not, so the run holds.
    if (at > 0 && at <= 8192) {
      const tail = segment.slice(at);
      const tailPeriod = repeatedRun(tail);
      if (tailPeriod > 0) return classifyMarkerRegion(tail.slice(0, Math.min(tail.length, tailPeriod + HEADER_WINDOW)));
    }
    return "hold";
  }
  return classifyMarkerRegion(segment);
}

function classifyMarkerRegion(body: string): KeyVerdict {
  const find = markerFinder(body);
  const seen = new Map<string, WindowKind>();
  let from = 0;
  let proved = false;
  while (from < body.length) {
    const at = find(from);
    if (at < 0) break;
    let decoded = false;
    let labeled = false;
    let harmless = false;
    for (let offset = 0; offset < 4; offset += 1) {
      const start = at - offset;
      if (start < 0) continue;
      const window = body.slice(start, Math.min(body.length, start + HEADER_WINDOW));
      let kind = seen.get(window);
      if (!kind) {
        kind = classifyDecoded(tryDecodeBase64(window));
        seen.set(window, kind);
      }
      if (kind === "private") return "private";
      if (kind === "labeled") labeled = true;
      else if (kind === "harmless" || kind === "bare") harmless = true;
      if (kind === "bare" || kind === "harmless" || kind === "labeled") decoded = true;
    }
    // The four offsets are one marker read four ways. A reading that is only the bare BEGIN marker, or a complete
    // allow-listed line, is proof. A shifted reading that looks like a cut label does not throw that proof out. A
    // private-key header already returned above. With no such proof, a cut or unknown label holds, and so does a
    // marker that never decodes.
    if (harmless) {
      proved = true;
    } else if (!decoded || labeled) return "hold";
    from = at + 1;
  }
  return proved ? "clear" : "hold";
}

/**
 * The next marker at or after `from`. Each marker's position is remembered, and a marker that is not in the text is
 * searched once. Searching again from every word is quadratic.
 */
function markerFinder(text: string): (from: number) => number {
  const next = PEM_MARKERS.map((marker) => ({ marker, at: text.indexOf(marker) }));
  return (from: number) => {
    let found = -1;
    for (const slot of next) {
      if (slot.at >= 0 && slot.at < from) slot.at = text.indexOf(slot.marker, from);
      if (slot.at >= 0 && (found < 0 || slot.at < found)) found = slot.at;
    }
    return found;
  };
}

/** Same short words repeat. Decoding each one again dominates a long line of markers. */
function cachedVerdicts(): (word: string) => KeyVerdict {
  const cache = new Map<string, KeyVerdict>();
  return (word: string) => {
    const hit = cache.get(word);
    if (hit) return hit;
    const verdict = runVerdict(word);
    if (word.length <= 96) cache.set(word, verdict);
    return verdict;
  };
}

/**
 * The base64 word that contains `at`. Scanning back stops at `=`, so a token like KEY= is not pulled into the word.
 * The caller always continues from `end`, so repeated markers are one word.
 */
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

function lineHoldsPrivateKey(line: string, verdict: (word: string) => KeyVerdict): boolean {
  const find = markerFinder(line);
  let from = 0;
  while (from < line.length) {
    const at = find(from);
    if (at < 0) return false;
    const word = base64WordAt(line, at);
    const kind = verdict(line.slice(word.start, word.end));
    if (kind === "private" || kind === "hold") return true;
    from = Math.max(word.end, at + 1);
  }
  return false;
}

/**
 * A base64 private key holds the move, including one wrapped across lines or written on one line. No line is skipped:
 * a run that does not decode from its first character is still scanned, and a marker that does not decode holds.
 */
function decodedPemMatchesHeader(text: string): boolean {
  const prepared = stripQuotePrefixes(percentDecode(text));
  if (PRIVATE_KEY_HEADER.test(prepared)) return true;
  KEY_WHITESPACE.lastIndex = 0;
  const compact = prepared.replace(KEY_WHITESPACE, "");
  const whole = runVerdict(compact);
  if (whole === "private" || whole === "hold") return true;
  const verdict = cachedVerdicts();
  const lines = prepared.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lineHoldsPrivateKey(lines[i] ?? "", verdict)) return true;
  }
  return false;
}

/** Replaces a one-line base64 private key. A word that is not a key is copied through, and the scan jumps past it. */
function redactBase64Words(line: string, verdict: (word: string) => KeyVerdict): { text: string; count: number } {
  const find = markerFinder(line);
  let count = 0;
  let out = "";
  let cursor = 0;
  while (cursor < line.length) {
    const at = find(cursor);
    if (at < 0) {
      out += line.slice(cursor);
      break;
    }
    const word = base64WordAt(line, at);
    const end = Math.max(word.end, at + 1);
    const kind = verdict(line.slice(word.start, word.end));
    if (kind === "private" || kind === "hold") {
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
 * Replaces a base64 private key, including one wrapped across lines. A run that is not a key is still scanned line by
 * line, so a key sharing its run with a label is not copied through.
 */
function redactBase64Pem(text: string): { text: string; count: number } {
  const lines = text.split("\n");
  const runs = collectBase64Runs(lines);
  const verdict = cachedVerdicts();
  let count = 0;
  const out: string[] = [];
  let index = 0;
  let runAt = 0;
  while (index < lines.length) {
    const run = runs[runAt];
    if (run && run.start === index) {
      const kind = runVerdict(run.compact);
      if (kind === "private" || kind === "hold") {
        out.push("[secret removed]");
        count += 1;
      } else {
        for (let line = run.start; line < run.end; line += 1) {
          const redacted = redactBase64Words(lines[line] ?? "", verdict);
          out.push(redacted.text);
          count += redacted.count;
        }
      }
      index = run.end;
      runAt += 1;
      continue;
    }
    const redacted = redactBase64Words(lines[index] ?? "", verdict);
    out.push(redacted.text);
    count += redacted.count;
    index += 1;
  }
  return { text: out.join("\n"), count };
}

/** The text a move would carry, joined: a private key split across blocks shows up here, not in any one block. */
function privateKeyPresent(strings: string[]): boolean {
  return decodedPemMatchesHeader(strings.join("\n"));
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
