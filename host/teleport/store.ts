// The host's side of a chat move (WP-177): the store for incoming copies, live copies and the owner of each chat.
//
// It is a separate store from the host's session database, so a move cannot change session rows. One JSON record per
// chat, written atomically. The rules that keep a chat on one machine:
//   - a receive is refused for a chat that is live or frozen here, or held by another move; it is addressed to this
//     machine and names this chat;
//   - a receive does not change the owner: the owner changes only when the copy is activated;
//   - activate throws when there is no copy for the move;
//   - a receive holds the WP-60 session lease (under the first-mate lease root) for as long as the copy is incoming,
//     and the copy expires after leaseMs, so a move that died does not hold the chat forever;
//   - only allow-listed chat fields are written, so a secret on the sending side cannot reach this disk through a move.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CanResume,
  type ChatRecord,
  type ChatSnapshot,
  type Holds,
  type MovePayload,
  type Provider,
  type ReceiveReply,
  type TransferChat,
} from "../../src/features/connections/model/teleport";
import { acquireSessionLease, type SessionLease } from "../firstmate/lease";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;

interface Incoming {
  moveId: string;
  payload: TransferChat;
  from: string;
  expiresAt: number;
  /** The paired device that sent the copy: the only one that may activate or discard it. */
  device: string;
}

interface StoredChat {
  owner: string | null;
  /** The paired device that owns the live copy: the only one that may read, freeze or release it. */
  device: string | null;
  live: TransferChat | null;
  incoming: Incoming | null;
  activatedBy: string | null;
  frozenBy: string | null;
  frozenDevice: string | null;
  frozenTo: string | null;
}

export interface HostTeleportOptions {
  /** The teleport folder for this host (chat records live under it). */
  dir: string;
  /** This host's machine id: the address a move must carry to be accepted here. */
  selfId: string;
  providers: readonly string[];
  /** The WP-60 lease root (the first-mate lease folder). Chat leases are taken there, not beside the chats. */
  leaseRoot: string;
  now?: () => number;
  leaseMs?: number;
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
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly leases = new Map<string, SessionLease>();

  constructor(private readonly options: HostTeleportOptions) {
    this.chatsDir = join(options.dir, "chats");
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  }

  // Folders appear on the first write, so an idle host does not show an empty teleport folder in its file browser.
  private ensureDirs(): void {
    mkdirSync(this.chatsDir, { recursive: true });
    mkdirSync(this.options.leaseRoot, { recursive: true });
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

  private releaseLease(chatId: string): void {
    this.leases.get(chatId)?.release();
    this.leases.delete(chatId);
  }

  /** Only the owning device sees the chat. Any other paired device sees nothing (not even that the chat exists). */
  async read(chatId: string, device: string): Promise<ChatRecord | null> {
    const stored = this.load(chatId);
    if (!stored || (stored.device !== null && stored.device !== device)) return null;
    const live: ChatSnapshot | null = stored.live
      ? { ...stored.live, queued: [...stored.live.queued], turnRunning: false, approvalPending: false }
      : null;
    return { owner: stored.owner ?? "", live };
  }

  async holds(chatId: string, moveId: string, device: string): Promise<Holds> {
    const stored = this.load(chatId);
    if (!stored) return "none";
    // M2: a device that did not start this copy is refused with an error, not told there is nothing here.
    if (stored.incoming?.moveId === moveId && stored.incoming.device !== device) {
      throw new Error("This copy belongs to another device");
    }
    if (stored.live && stored.device !== null && stored.device !== device) {
      throw new Error("This chat belongs to another device");
    }
    if (stored.activatedBy === moveId && stored.owner === this.options.selfId) return "live";
    if (stored.incoming?.moveId === moveId) return "incoming";
    return "none";
  }

  async freeze(chatId: string, moveId: string, device: string, peer: string): Promise<boolean> {
    const stored = this.load(chatId);
    if (!stored?.live || stored.frozenBy || stored.device !== device) return false;
    this.save(chatId, { ...stored, frozenBy: moveId, frozenDevice: device, frozenTo: peer });
    return true;
  }

  async thaw(chatId: string, moveId: string, device: string): Promise<void> {
    const stored = this.load(chatId);
    if (stored?.frozenBy === moveId && stored.frozenDevice === device) {
      this.save(chatId, { ...stored, frozenBy: null, frozenDevice: null, frozenTo: null });
    }
  }

  async canResume(provider: Provider, model: string, effort: string): Promise<CanResume> {
    if (!this.options.providers.includes(provider)) {
      return { ok: false, reason: `this host does not run ${provider}` };
    }
    if (!model || !effort) return { ok: false, reason: "the chat has no model or effort to resume with" };
    return { ok: true };
  }

  async receive(chatId: string, moveId: string, payload: MovePayload, device: string): Promise<ReceiveReply> {
    this.assertId(chatId);
    if (payload.manifest?.format !== "hivra-teleport-v1") throw new Error("Invalid move payload");
    if (payload.manifest.to !== this.options.selfId) throw new Error("This move is addressed to another machine");
    if (payload.manifest.chatId !== chatId || payload.chat.chatId !== chatId) {
      throw new Error("The move names another chat than the one being received");
    }
    const stored = this.load(chatId);
    const chat = pick(payload.chat);
    if (stored?.incoming?.moveId === moveId) {
      // A repeat reports the stored copy's hash, never the hash of a payload that arrived this time.
      return { ok: true, transcriptSha256: sha256(stored.incoming.payload.transcript) };
    }
    if (stored?.live || stored?.frozenBy) return { ok: false, reason: "held" };
    let previous = stored?.incoming ?? null;
    if (previous && previous.expiresAt > this.now()) return { ok: false, reason: "held" };
    if (previous) this.releaseLease(chatId); // an expired copy gives way

    this.ensureDirs();
    const lease = acquireSessionLease(chatId, this.options.leaseRoot);
    if (!lease) return { ok: false, reason: "held" };
    this.leases.set(chatId, lease);
    this.save(chatId, {
      owner: stored?.owner ?? null,
      device: stored?.device ?? null,
      live: null,
      incoming: { moveId, payload: chat, from: payload.manifest.from, expiresAt: this.now() + this.leaseMs, device },
      activatedBy: null,
      frozenBy: null,
      frozenDevice: null,
      frozenTo: null,
    });
    return { ok: true, transcriptSha256: sha256(chat.transcript) };
  }

  async discard(chatId: string, moveId: string, device: string): Promise<void> {
    const stored = this.load(chatId);
    if (!stored?.incoming || stored.incoming.moveId !== moveId || stored.incoming.device !== device) return;
    this.save(chatId, { ...stored, incoming: null });
    this.releaseLease(chatId);
  }

  async activate(chatId: string, moveId: string, device: string): Promise<void> {
    const stored = this.load(chatId);
    if (stored?.activatedBy === moveId && stored.owner === this.options.selfId) return;
    if (!stored?.incoming || stored.incoming.moveId !== moveId) {
      throw new Error("No copy of this chat is stored here to open for this move");
    }
    if (stored.incoming.device !== device) throw new Error("This move was started by another device");
    if (stored.incoming.expiresAt <= this.now()) throw new Error("The copy's lease expired before it was opened");
    this.save(chatId, {
      owner: this.options.selfId,
      device,
      live: stored.incoming.payload,
      incoming: null,
      activatedBy: moveId,
      frozenBy: null,
      frozenDevice: null,
      frozenTo: null,
    });
    this.releaseLease(chatId);
  }

  async release(chatId: string, moveId: string, to: string, device: string): Promise<void> {
    const stored = this.load(chatId);
    if (!stored || stored.frozenBy !== moveId) throw new Error("This move did not freeze the chat");
    if (stored.frozenDevice !== device) throw new Error("This move was started by another device");
    if (stored.frozenTo !== to) throw new Error("The release names a destination other than the one the move froze for");
    this.save(chatId, { ...stored, owner: to, device: null, live: null, frozenBy: null, frozenDevice: null, frozenTo: null, activatedBy: null });
  }
}
