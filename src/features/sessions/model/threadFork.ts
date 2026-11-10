// WP-123: a new chat with a copy of the history up to one message. The original
// is never written. Ids are new, so the two chats do not share a mutable row.
import { boundaryFromDisk, UNREADABLE_BOUNDARY } from "../../memory/model/privateChat";
import {
  temporaryWorktreeBranchName,
  type Worktree,
} from "../../source-control/model/worktrees";
import { buildDeterministicHandoff } from "./handoff";
import { isPersistableId } from "./persistableId";
import { askThreadFork } from "./threadForkAsk";
import type {
  Attachment,
  Block,
  BtwMessage,
  BtwThread,
  HarnessId,
  Session,
} from "./session";

/** The session store's id check, for a value of unknown type. A path or a space must not be saved. */
function persistableId(value: unknown): value is string {
  return typeof value === "string" && isPersistableId(value);
}

export type ForkIds = {
  next: () => string;
};

/** What the app's own image commands return for a copied file. */
export type ForkImageAsset = {
  path: string;
  mimeType: string;
  size: number;
};

/**
 * A generated image's file belongs to the chat that made it and goes with that chat when it is deleted. A fork
 * therefore gets a file of its own instead of sharing the path. This covers the chat's own messages only: a side
 * thread's (btw) messages keep the path they point at, so an image inside one stays shared with the original chat.
 */
export type ForkImagePort = {
  /** A copy of the file, or null when the original is no longer on disk. Any other failure throws. */
  copyImage: (path: string, name: string) => Promise<ForkImageAsset | null>;
  removeImages: (paths: string[]) => Promise<void>;
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
      const copied = copyBlocks(message.blocks, message.blocks.length - 1, ids, null);
      if (!copied) return null;
      copy.blocks = copied.blocks;
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

/**
 * `images` is set for the chat's own messages: each generated image in them must have a copy of its file, or
 * nothing is returned. A null copy means the original's file is gone: that block is kept without its picture. A side
 * thread's messages pass null and keep what they point at.
 */
function copyBlocks(
  blocks: readonly Block[],
  end: number,
  ids: ForkIds,
  images: ReadonlyMap<string, ForkImageAsset | null> | null,
): { blocks: Block[]; blockIds: Map<string, string> } | null {
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
    delete block.forkPoint;
    if (block.approval && !block.approval.decided) delete block.approval;
    // An empty path means the picture's file is not on this Mac (an imported chat): there is nothing to copy.
    if (images && block.role === "image" && typeof block.image?.path === "string" && block.image.path) {
      const file = images.get(block.image.path);
      if (file === undefined) return null;
      if (file === null) {
        delete block.image;
      } else {
        block.image = {
          ...block.image,
          path: file.path,
          mimeType: file.mimeType,
          size: file.size,
        };
      }
    }
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
  return { blocks: cloned, blockIds };
}

/**
 * Where the fork's private boundary falls. A chat switched off from private keeps what came before the switch
 * unread: the same message in the copy, or the copy's last message when the switch came after the fork point. A
 * boundary that matches nothing keeps the copy unread.
 */
function forkBoundary(
  source: Session,
  index: number,
  blockIds: ReadonlyMap<string, string>,
  lastId: string,
): string | undefined {
  const boundary = boundaryFromDisk(source.privateBoundaryId);
  if (!boundary) return undefined;
  const at = source.blocks.findIndex((block) => block?.id === boundary);
  if (at < 0) return UNREADABLE_BOUNDARY;
  if (at > index) return lastId;
  return blockIds.get(boundary) ?? UNREADABLE_BOUNDARY;
}

/**
 * A new chat whose blocks are a copy of `source` through `blockId`, inclusive.
 * Returns null when that message is not a user or assistant message, or when a
 * generated image in the copy has no file of its own in `images` (by the
 * original's path; `forkChat` makes those copies, or null for a file that is
 * gone, which leaves the block without its picture). Does not mutate `source`.
 */
export function forkSessionAtMessage(
  source: Session,
  blockId: string,
  ids: ForkIds = defaultIds(),
  sessionId?: string,
  images: ReadonlyMap<string, ForkImageAsset | null> = new Map(),
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
  const copied = copyBlocks(source.blocks, index, ids, images);
  if (!copied) return null;
  const { blocks, blockIds } = copied;
  // The new provider conversation has never seen these messages: its first send carries a recap through this one.
  const last = blocks[blocks.length - 1];
  last.forkPoint = true;
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
  if (source.worktreeRemoved) fork.worktreeRemoved = true;
  // WP-111: a fork of a private chat is private, and what was private before a switch stays unread.
  if (source.private === true) fork.private = true;
  const boundary = forkBoundary(source, index, blockIds, last.id);
  if (boundary) fork.privateBoundaryId = boundary;
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

/** What a fork's first send carries: the chat copied into it, as a handoff recap does. */
export type ForkBrief = {
  from: HarnessId;
  to: HarnessId;
  /** Tells the send to word the recap as a fork's (`wrapForkPrompt`), not as a handoff's. */
  fork: true;
  text: string;
  /** Messages typed in the fork after the copy and before a turn was taken (a first send that failed). */
  earlier: string[];
};

/**
 * The recap a forked chat still owes its provider, or null when none is owed. It is built from the copied messages
 * (the same recap a handoff sends), so the agent that answers in the fork knows what was said before it.
 */
export function pendingForkBrief(session: Session): ForkBrief | null {
  if (!session || !Array.isArray(session.blocks)) return null;
  let at = -1;
  for (let index = session.blocks.length - 1; index >= 0; index -= 1) {
    if (session.blocks[index]?.forkPoint) {
      at = index;
      break;
    }
  }
  if (at < 0) return null;
  const text = buildDeterministicHandoff({
    ...session,
    blocks: session.blocks.slice(0, at + 1),
  });
  if (!text.trim()) return null;
  const earlier = session.blocks
    .slice(at + 1)
    .filter((block) => block.role === "user")
    .map((block) => (block.ciContext || block.text).trim())
    .filter(Boolean);
  return { from: session.harness, to: session.harness, fork: true, text, earlier };
}

/** A turn was taken: the fork no longer owes its recap. Blocks are replaced, not edited, so the save sees it. */
export function consumeForkPoint(session: Session): Session {
  if (!session.blocks.some((block) => block.forkPoint)) return session;
  return {
    ...session,
    blocks: session.blocks.map((block) => {
      if (!block.forkPoint) return block;
      const next = { ...block };
      delete next.forkPoint;
      return next;
    }),
  };
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
    options?: { carryChanges?: boolean },
  ) => Promise<Worktree>;
  /** Takes back a worktree this fork made and did not keep: after a cancel, or when no fork came of it. */
  removeWorktree?: (cwd: string, path: string, force: boolean) => Promise<unknown>;
};

export type ForkChatOptions = {
  useNewWorktree: boolean;
  /** Read the chat again after the worktree exists, so a late edit is kept. */
  readSource?: () => Session | undefined;
  /** True once the person cancelled. The fork stops, and what it made so far is removed. */
  cancelled?: () => boolean;
  /** A line for the confirm: the fork was made, but something the person should know did not come along. */
  onNotice?: (line: string) => void;
};

export type ForkPort = ForkWorktreePort & Partial<ForkImagePort>;

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
 * The checkout the new worktree branches from: the chat's own worktree, so the fork starts where the chat is. A chat
 * with no worktree, or whose worktree was deleted, branches from the project.
 */
function worktreeOrigin(source: Session): string {
  return source.worktreeCwd && !source.worktreeRemoved ? source.worktreeCwd : source.cwd;
}

function imagesThrough(session: Session, blockId: string): { path: string; name: string }[] {
  const end = session.blocks.findIndex(
    (block) => block && block.id === blockId && FORKABLE.has(block.role),
  );
  if (end < 0) return [];
  const found = new Map<string, string>();
  for (const block of session.blocks.slice(0, end + 1)) {
    const image = block?.role === "image" ? block.image : undefined;
    if (typeof image?.path === "string" && image.path && !found.has(image.path)) {
      found.set(image.path, typeof image.name === "string" ? image.name : "image.png");
    }
  }
  return [...found].map(([path, name]) => ({ path, name }));
}

/** The refusal for an image that could not be copied. The underlying error names a file, so it is not shown. */
const IMAGE_FAILED = "An image in this chat could not be copied. Try again.";

/** The image files made for one fork, kept until the fork is built so a failure can remove them again. */
function imageCopies(port: Partial<ForkImagePort>, cancelled: () => boolean) {
  const copies = new Map<string, ForkImageAsset | null>();
  const removed = new Set<string>();
  return {
    copies,
    /**
     * Copy each generated image up to the message that has no copy yet. An original that is gone is recorded as
     * null; any other failure stops the fork. A cancel stops copying.
     */
    async copyThrough(session: Session, blockId: string): Promise<void> {
      for (const { path, name } of imagesThrough(session, blockId)) {
        if (copies.has(path)) continue;
        if (cancelled()) return;
        if (!port.copyImage) throw new Error(IMAGE_FAILED);
        try {
          copies.set(path, await port.copyImage(path, name));
        } catch {
          throw new Error(IMAGE_FAILED);
        }
      }
    },
    /** Remove the copies that the finished chat does not use. Best effort: the fork's own result stands. */
    async discard(used: ReadonlySet<string>): Promise<void> {
      const unused = [...copies.values()]
        .flatMap((file) => (file ? [file.path] : []))
        .filter((path) => !used.has(path) && !removed.has(path));
      if (unused.length === 0 || !port.removeImages) return;
      for (const path of unused) removed.add(path);
      try {
        await port.removeImages(unused);
      } catch {
        // A file left behind is cleaned with the app's other generated images.
      }
    },
  };
}

function imagePaths(session: Session | null): Set<string> {
  const paths = new Set<string>();
  for (const block of session?.blocks ?? []) {
    if (block.role === "image" && typeof block.image?.path === "string") paths.add(block.image.path);
  }
  return paths;
}

/**
 * Copy the chat. When a new worktree is requested, creation goes through the port and a refusal is left to the
 * caller. The worktree starts from the chat's own checkout and carries its uncommitted changes; if they could not be
 * copied the fork is still made and `onNotice` hears it. Generated images are copied first, so an image that cannot
 * be copied stops the fork before a worktree exists. Whatever this made (image copies, the worktree) is removed again
 * when no fork comes of it: a refusal, a message that is gone, or a cancel (`cancelled`).
 */
export async function forkChat(
  source: Session,
  blockId: string,
  options: ForkChatOptions,
  port: ForkPort,
  ids: ForkIds = defaultIds(),
): Promise<Session | null> {
  if (!forkStillValid(source, blockId)) return null;
  const cancelled = () => options.cancelled?.() === true;
  const images = imageCopies(port, cancelled);
  const root = worktreeOrigin(source);
  // Held in an object: the build below assigns it, which control-flow analysis does not follow for a `let`.
  const made: { tree: Worktree | null } = { tree: null };

  const undo = async () => {
    await images.discard(new Set());
    const path = made.tree?.path;
    if (typeof path !== "string" || !path || !port.removeWorktree) return;
    try {
      await port.removeWorktree(root, path, true);
    } catch {
      // The worktree stays; Settings > Worktrees lists it for clean-up.
    }
  };

  const build = async (): Promise<Session | null> => {
    await images.copyThrough(source, blockId);
    if (cancelled()) return null;
    if (!options.useNewWorktree) {
      return forkSessionAtMessage(source, blockId, ids, undefined, images.copies);
    }
    const sessionId = takeId(ids);
    if (!sessionId) return null;
    const tree = await port.createWorktree(
      root,
      temporaryWorktreeBranchName(sessionId),
      "HEAD",
      false,
      { carryChanges: true },
    );
    made.tree = tree;
    if (cancelled()) return null;
    const live = options.readSource ? options.readSource() : source;
    if (!forkStillValid(live, blockId)) return null;
    await images.copyThrough(live!, blockId);
    if (cancelled()) return null;
    const fork = forkSessionAtMessage(live!, blockId, ids, sessionId, images.copies);
    return fork ? withForkWorktree(fork, tree) : null;
  };

  let fork: Session | null;
  try {
    fork = await build();
  } catch (error) {
    await undo();
    throw error;
  }
  // Copies a late edit left unused go first; everything else is checked after, so the last look at a cancel comes
  // right before the result is handed back.
  if (fork) await images.discard(imagePaths(fork));
  if (!fork || cancelled()) {
    await undo();
    return null;
  }
  if (made.tree?.changesNotice) options.onNotice?.(made.tree.changesNotice);
  return fork;
}
