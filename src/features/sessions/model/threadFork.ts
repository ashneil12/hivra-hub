// WP-123: a new chat with a copy of the history up to one message. The original
// is never written. Ids are new, so the two chats do not share a mutable row.
import {
  temporaryWorktreeBranchName,
  type Worktree,
} from "../../source-control/model/worktrees";
import { askThreadFork } from "./threadForkAsk";
import type {
  Attachment,
  Block,
  BtwMessage,
  BtwThread,
  Session,
} from "./session";

/** Matches the session store's id check. A path or a space must not be saved. */
function persistableId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}

export type ForkIds = {
  next: () => string;
};

const FORKABLE = new Set<Block["role"]>(["user", "assistant"]);

function defaultIds(): ForkIds {
  return { next: () => crypto.randomUUID() };
}

function takeId(ids: ForkIds): string | null {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let value: unknown;
    try {
      value = ids.next();
    } catch {
      return null;
    }
    if (persistableId(value)) return value;
  }
  return null;
}

function plainStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function forkTitle(title: unknown): string {
  const base = typeof title === "string" ? title.replace(/\r?\n/g, " ").trim() : "";
  const next = base ? `Fork of ${base}` : "Fork";
  return next.length > 140 ? `${next.slice(0, 139)}…` : next;
}

/** "skip" drops a value that is not an attachment. null means an id could not be made. */
function copyAttachment(file: unknown, ids: ForkIds): Attachment | "skip" | null {
  if (!file || typeof file !== "object") return "skip";
  const source = file as Attachment;
  const id = takeId(ids);
  if (!id) return null;
  const copy: Attachment = {
    id,
    name: typeof source.name === "string" ? source.name : "",
    mimeType: typeof source.mimeType === "string" ? source.mimeType : "",
    kind:
      source.kind === "image" || source.kind === "audio" || source.kind === "file"
        ? source.kind
        : "file",
    size: typeof source.size === "number" && Number.isFinite(source.size) ? source.size : 0,
  };
  if (typeof source.path === "string") copy.path = source.path;
  if (typeof source.data === "string") copy.data = source.data;
  return copy;
}

function copyMessage(message: BtwMessage, ids: ForkIds): BtwMessage | null {
  const id = takeId(ids);
  if (!id) return null;
  const copy: BtwMessage = {
    id,
    role: message.role === "assistant" ? "assistant" : "user",
    text: typeof message.text === "string" ? message.text : "",
    createdAt: message.createdAt,
  };
  if (message.blocks) {
    if (message.blocks.length === 0) {
      copy.blocks = [];
    } else {
      const blocks = copyBlocks(message.blocks, message.blocks.length - 1, ids);
      if (!blocks) return null;
      copy.blocks = blocks;
    }
  }
  return copy;
}

function copyThreads(
  threads: BtwThread[],
  ids: ForkIds,
  blockIds: Map<string, string>,
): BtwThread[] | null {
  const copies: BtwThread[] = [];
  for (const thread of threads) {
    const id = takeId(ids);
    if (!id) return null;
    const anchor = blockIds.get(thread.sourceEndBlockId);
    if (!anchor) continue;
    const messages: BtwMessage[] = [];
    for (const message of thread.messages ?? []) {
      const copied = copyMessage(message, ids);
      if (!copied) return null;
      messages.push(copied);
    }
    copies.push({
      id,
      sourceEndBlockId: anchor,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      status: thread.status === "running" ? "ready" : thread.status,
      messages,
      ...(thread.harness ? { harness: thread.harness } : {}),
      ...(thread.model ? { model: thread.model } : {}),
      ...(thread.modelSettings ? { modelSettings: { ...thread.modelSettings } } : {}),
      ...(thread.error ? { error: thread.error } : {}),
    });
  }
  return copies;
}

function copyBlocks(blocks: readonly Block[], end: number, ids: ForkIds): Block[] | null {
  if (end < 0 || end >= blocks.length) return null;
  let cloned: Block[];
  try {
    cloned = structuredClone(blocks.slice(0, end + 1));
  } catch {
    return null;
  }
  const blockIds = new Map<string, string>();
  for (const block of cloned) {
    const previous = block.id;
    const id = takeId(ids);
    if (!id) return null;
    if (typeof previous === "string" && previous && !blockIds.has(previous)) {
      blockIds.set(previous, id);
    }
    block.id = id;
    block.streaming = false;
    delete block.providerTurnId;
    if (block.approval && !block.approval.decided) delete block.approval;
    if (block.attachments) {
      const files: Attachment[] = [];
      for (const file of block.attachments) {
        const copied = copyAttachment(file, ids);
        if (copied === null) return null;
        if (copied !== "skip") files.push(copied);
      }
      block.attachments = files;
    }
  }
  for (const block of cloned) {
    if (!block.btwThreads) continue;
    const threads = copyThreads(block.btwThreads, ids, blockIds);
    if (!threads) return null;
    block.btwThreads = threads;
  }
  return cloned;
}

/**
 * A new chat whose blocks are a copy of `source` through `blockId`, inclusive.
 * Returns null when that message is not a user or assistant message. Does not
 * mutate `source`.
 */
export function forkSessionAtMessage(
  source: Session,
  blockId: string,
  ids: ForkIds = defaultIds(),
  sessionId?: string,
): Session | null {
  if (
    !source ||
    typeof source.cwd !== "string" ||
    source.cwd.length === 0 ||
    typeof source.harness !== "string" ||
    typeof source.model !== "string" ||
    !Array.isArray(source.blocks)
  ) {
    return null;
  }
  if (typeof blockId !== "string" || blockId.length === 0) return null;
  const index = source.blocks.findIndex(
    (block) => block && block.id === blockId && FORKABLE.has(block.role),
  );
  if (index < 0) return null;
  const id = sessionId ?? takeId(ids);
  if (!persistableId(id)) return null;
  const blocks = copyBlocks(source.blocks, index, ids);
  if (!blocks) return null;
  const modelSettings = plainStringRecord(source.modelSettings);
  const fork: Session = {
    id,
    harness: source.harness,
    model: source.model,
    modelSettings,
    runtimeMode: source.runtimeMode,
    title: forkTitle(source.title),
    cwd: source.cwd,
    blocks,
  };
  if (typeof source.branch === "string" && source.branch) fork.branch = source.branch;
  if (typeof source.worktreeCwd === "string" && source.worktreeCwd) {
    fork.worktreeCwd = source.worktreeCwd;
  }
  if (source.firstMate) fork.firstMate = true;
  if (typeof source.providerAccountId === "string" && persistableId(source.providerAccountId)) {
    fork.providerAccountId = source.providerAccountId;
  }
  if (source.linkedWorkItem) {
    try {
      fork.linkedWorkItem = structuredClone(source.linkedWorkItem);
    } catch {
      // A linked item that cannot be copied is left off. The messages still fork.
    }
  }
  return fork;
}

/** Ask to fork the latest real message. False when there is nothing to fork. */
export function forkFocusedChat(session: Session | undefined): boolean {
  const blockId = session ? lastForkableBlockId(session.blocks) : null;
  if (!session || !blockId) return false;
  askThreadFork(session.id, blockId);
  return true;
}

/** The latest user or assistant message, or null when the chat has none. */
export function lastForkableBlockId(blocks: readonly Block[] | undefined): string | null {
  if (!Array.isArray(blocks)) return null;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (
      block &&
      !block.internal &&
      FORKABLE.has(block.role) &&
      typeof block.id === "string" &&
      block.id
    ) {
      return block.id;
    }
  }
  return null;
}

/** True when `blockId` is still a user or assistant message on this chat. */
export function forkStillValid(session: Session | undefined, blockId: string): boolean {
  if (!session || !Array.isArray(session.blocks)) return false;
  return session.blocks.some(
    (block) => block && block.id === blockId && FORKABLE.has(block.role),
  );
}

/**
 * Append `fork` unless that id is already in the list. Does not mutate the
 * input, and does not replace an existing row.
 */
export function insertFork(sessions: readonly Session[], fork: Session): Session[] {
  if (sessions.some((session) => session.id === fork.id)) return sessions as Session[];
  return [...sessions, fork];
}

/** One in-flight confirm. A cancel or a newer attempt makes the old ticket stale. */
export type ForkAttemptGate = {
  start: () => number;
  current: (ticket: number) => boolean;
  cancel: () => void;
};

export function forkAttemptGate(): ForkAttemptGate {
  let ticket = 0;
  return {
    start: () => {
      ticket += 1;
      return ticket;
    },
    current: (value) => value === ticket,
    cancel: () => {
      ticket += 1;
    },
  };
}

/** Checked for "ask" and "always". Anything else, including a bad value, is off. */
export function forkWorktreeDefault(setting: unknown): boolean {
  return setting === "always" || setting === "ask";
}

export type ForkWorktreePort = {
  createWorktree: (
    cwd: string,
    branch: string,
    base: string,
    existing: boolean,
  ) => Promise<Worktree>;
};

export type ForkChatOptions = {
  useNewWorktree: boolean;
  /** Read the chat again after the worktree exists, so a late edit is kept. */
  readSource?: () => Session | undefined;
};

const WORKTREE_FAILED = "The new worktree could not be created.";

/** The refusal text, or a plain line when the failure said nothing. */
export function forkWorktreeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return WORKTREE_FAILED;
}

function withForkWorktree(fork: Session, tree: Worktree): Session {
  if (typeof tree.path !== "string" || tree.path.length === 0) {
    throw new Error(WORKTREE_FAILED);
  }
  const next: Session = {
    ...fork,
    worktreeCwd: tree.path,
    branch: typeof tree.branch === "string" && tree.branch ? tree.branch : undefined,
  };
  delete next.workspaceMode;
  delete next.worktreeBase;
  delete next.worktreeRemoved;
  return next;
}

/**
 * Copy the chat. When a new worktree is requested, creation goes through the
 * port and a refusal is left to the caller. This never removes a worktree.
 */
export async function forkChat(
  source: Session,
  blockId: string,
  options: ForkChatOptions,
  port: ForkWorktreePort,
  ids: ForkIds = defaultIds(),
): Promise<Session | null> {
  if (!forkStillValid(source, blockId)) return null;
  if (!options.useNewWorktree) return forkSessionAtMessage(source, blockId, ids);
  const sessionId = takeId(ids);
  if (!sessionId) return null;
  const tree = await port.createWorktree(
    source.cwd,
    temporaryWorktreeBranchName(sessionId),
    "HEAD",
    false,
  );
  const live = options.readSource ? options.readSource() : source;
  if (!forkStillValid(live, blockId)) return null;
  const fork = forkSessionAtMessage(live!, blockId, ids, sessionId);
  if (!fork) return null;
  return withForkWorktree(fork, tree);
}
