// The host's side of a chat move (WP-177): the store for incoming copies, live copies and the owner of each chat.
//
// It is a separate store from the host's session database, so a move cannot change session rows. One JSON record
// per chat, written atomically. A chat's receive holds the WP-60 session lease until the move activates or
// discards it, so a reconnect race cannot start the chat twice. Only allow-listed fields are written, so a secret
// on the sending side cannot reach this disk through a move.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CanResume,
  type ChatRecord,
  type ChatSnapshot,
  type MovePayload,
  type Provider,
  type ReceiveReply,
  type TransferChat,
} from "../../src/features/connections/model/teleport";
import { acquireSessionLease, type SessionLease } from "../firstmate/lease";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

interface StoredChat {
  owner: string;
  live: TransferChat | null;
  incoming: { moveId: string; payload: TransferChat; from: string } | null;
  activatedBy: string | null;
  frozenBy: string | null;
}

export interface HostTeleportOptions {
  dir: string;
  selfId: string;
  providers: readonly string[];
}

function pick(chat: TransferChat): TransferChat {
  return {
    chatId: chat.chatId,
    provider: chat.provider,
    providerSessionId: chat.providerSessionId,
    model: chat.model,
    effort: chat.effort,
    title: chat.title,
    transcript: chat.transcript,
    queued: [...chat.queued],
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class HostTeleportStore {
  private readonly chatsDir: string;
  private readonly locksDir: string;
  private readonly leases = new Map<string, SessionLease>();

  constructor(private readonly options: HostTeleportOptions) {
    this.chatsDir = join(options.dir, "chats");
    this.locksDir = join(options.dir, "locks");
  }

  // Folders appear on the first write, so an idle host does not show an empty teleport folder in its file browser.
  private ensureDirs(): void {
    mkdirSync(this.chatsDir, { recursive: true });
    mkdirSync(this.locksDir, { recursive: true });
  }

  private assertId(chatId: string): void {
    if (!SAFE_ID.test(chatId)) throw new Error(`Invalid chat id ${JSON.stringify(chatId)}`);
  }

  private load(chatId: string): StoredChat | null {
    this.assertId(chatId);
    try {
      return JSON.parse(readFileSync(join(this.chatsDir, `${chatId}.json`), "utf8")) as StoredChat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private save(chatId: string, stored: StoredChat): void {
    this.ensureDirs();
    const file = join(this.chatsDir, `${chatId}.json`);
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, JSON.stringify(stored, null, 2), { mode: 0o600 });
    renameSync(temp, file);
  }

  async read(chatId: string): Promise<ChatRecord | null> {
    const stored = this.load(chatId);
    if (!stored) return null;
    const live: ChatSnapshot | null = stored.live
      ? { ...stored.live, queued: [...stored.live.queued], turnRunning: false, approvalPending: false }
      : null;
    return { owner: stored.owner, live };
  }

  async freeze(chatId: string, moveId: string): Promise<boolean> {
    const stored = this.load(chatId);
    if (!stored?.live) return false;
    if (stored.frozenBy) return false;
    this.save(chatId, { ...stored, frozenBy: moveId });
    return true;
  }

  async thaw(chatId: string, moveId: string): Promise<void> {
    const stored = this.load(chatId);
    if (stored?.frozenBy === moveId) this.save(chatId, { ...stored, frozenBy: null });
  }

  async canResume(provider: Provider, model: string, effort: string): Promise<CanResume> {
    if (!this.options.providers.includes(provider)) {
      return { ok: false, reason: `this host does not run ${provider}` };
    }
    if (!model || !effort) return { ok: false, reason: "the chat has no model or effort to resume with" };
    return { ok: true };
  }

  async receive(chatId: string, moveId: string, payload: MovePayload): Promise<ReceiveReply> {
    this.assertId(chatId);
    this.ensureDirs();
    const lease = acquireSessionLease(chatId, this.locksDir);
    if (!lease) return { ok: false, reason: "held" };
    this.leases.set(chatId, lease);
    const chat = pick(payload.chat);
    const stored = this.load(chatId);
    this.save(chatId, {
      owner: payload.manifest.from,
      live: stored?.live ?? null,
      incoming: { moveId, payload: chat, from: payload.manifest.from },
      activatedBy: null,
      frozenBy: stored?.frozenBy ?? null,
    });
    return { ok: true, transcriptSha256: sha256(chat.transcript) };
  }

  async discard(chatId: string, moveId: string): Promise<void> {
    const stored = this.load(chatId);
    if (!stored?.incoming || stored.incoming.moveId !== moveId) return;
    this.save(chatId, { ...stored, incoming: null, owner: stored.incoming.from });
    this.releaseLease(chatId);
  }

  async activate(chatId: string, moveId: string): Promise<void> {
    const stored = this.load(chatId);
    if (!stored) throw new Error("No copy of this chat is stored here");
    if (stored.activatedBy === moveId && stored.owner === this.options.selfId) return;
    if (!stored.incoming || stored.incoming.moveId !== moveId) {
      throw new Error("The incoming copy for this move is gone");
    }
    this.save(chatId, {
      owner: this.options.selfId,
      live: stored.incoming.payload,
      incoming: null,
      activatedBy: moveId,
      frozenBy: null,
    });
    this.releaseLease(chatId);
  }

  async release(chatId: string, moveId: string, to: string): Promise<void> {
    const stored = this.load(chatId);
    if (!stored || stored.frozenBy !== moveId) throw new Error("This move did not freeze the chat");
    this.save(chatId, { ...stored, owner: to, live: null, frozenBy: null, activatedBy: null });
  }

  private releaseLease(chatId: string): void {
    this.leases.get(chatId)?.release();
    this.leases.delete(chatId);
  }
}
