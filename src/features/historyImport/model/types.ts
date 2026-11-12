// WP-50: chat history import. Shared shapes. The readers and the run live beside this file.

/** One source, turned on by itself. Claude Code, then Codex, then Hermes. */
export type SourceId = "claude_code" | "codex" | "hermes";

export const SOURCES: readonly { id: SourceId; label: string }[] = [
  { id: "claude_code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "hermes", label: "Hermes" },
];

/** A prose turn kept for distillation. Tool output never becomes one of these. */
export type TranscriptMessage = {
  conversationId: string;
  messageId: string;
  role: "user" | "assistant";
  content: string;
  /** Unix milliseconds. */
  timestamp: number;
  /** The secret scan matched the full text. Kept for its id, never sent. */
  secret: boolean;
};

/** One conversation read from a transcript file. */
export type Conversation = {
  id: string;
  /** Resume key. A file that holds several chats gets one key per chat. */
  sourceKey: string;
  source: SourceId;
  project: string;
  /** The folder the chat ran in, when the transcript says. */
  cwd?: string;
  title: string;
  messages: TranscriptMessage[];
  /** Lines that were not valid JSON. */
  skippedLines: number;
  /** Prose messages left out because the secret scan matched. Never their text. */
  secrets: number;
};

/** A file the lister saw. `header` is the first bytes only, never the rest of the file. */
export type ListedFile = {
  path: string;
  bytes: number;
  mtimeMs: number;
  header: string;
  tooBig: boolean;
};

export type ListReport = {
  missing: boolean;
  files: ListedFile[];
  /** Chats still being written. Left out, not failed. */
  active: number;
  links: number;
  /** Hermes keeps other chats in a database. They are not read from here. */
  database: boolean;
  truncated: boolean;
};

/** What the preview shows. No message text. */
export type Preview = {
  missing: boolean;
  conversations: number;
  from: number | null;
  to: number | null;
  projects: { name: string; conversations: number }[];
  files: { path: string; bytes: number; mtimeMs: number }[];
  active: number;
  duplicates: number;
  secretsNote: number;
  tooBig: number;
  links: number;
  database: boolean;
  truncated: boolean;
};

export const ACTIVE_MS = 300_000;
export const BATCH_MSG_LIMIT = 10;
export const BATCH_CHAR_LIMIT = 30_000;
export const CONTENT_TRUNCATE = 10_000;
/** A batch the model refuses is tried again after these waits, then given up for this run. */
export const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000] as const;
export const HEADER_BYTES = 8192;
export const MAX_READ_BYTES = 32 * 1024 * 1024;

/** One unit of a run. A file that holds several chats is several chats. */
export type Unit =
  | { kind: "chat"; conversation: Conversation }
  | { kind: "unreadable"; source: SourceId; sourceKey: string }
  | { kind: "empty"; source: SourceId; sourceKey: string };

export type AskResult =
  | { ok: true; text: string }
  | { ok: false; kind: "retryable" | "refused"; reason: string };

export type StateStatus = "submitted" | "failed" | "deferred";

export type StateEntry = {
  status: StateStatus;
  timestamp: number;
  error: string | null;
};

/** Resume file. Only `submitted` is done; failed and deferred run again. */
export type ImportStateFile = {
  entries: Record<string, StateEntry>;
};

export type ProposalMeta = {
  format: 1;
  kind: "history-import";
  status: "unreviewed";
  applied: false;
  source: SourceId;
  conversationId: string;
  project: string;
  /** The resume key, so a folder that already exists can be told apart. */
  sourceKey: string;
};
