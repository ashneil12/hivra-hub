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
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  /** M1: the move ids this host refused for good. A late copy or activation of one of them is turned away. */
  aborted?: string[];
}

/**
 * The host's session list as the copy lands in it (H4). A copy the host activated is a real session the desktop can open
 * and use before the source releases it; a released copy is archived here, because the chat lives on the Mac again.
 */
export interface HostChatSessions {
  open(chat: TransferChat, moveId: string): void;
  close(chatId: string): void;
  /**
   * The live copy as the host runs it now: its messages and provider session id change with every turn the host runs. A
   * move back sends this, not the copy the host received, so a turn run on the host is not lost. Null when the host holds
   * no session for the chat.
   */
  current?(chatId: string): TransferChat | null;
  /** The host session's real turn and approval, so a move back can refuse a chat that is still working. */
  activity?(chatId: string): { turnRunning: boolean; approvalPending: boolean } | null;
  /** Freeze and release hold the copy so the engine refuses turns. Thaw clears it. */
  hold?(chatId: string, held: boolean): void;
  /** Whether a host session exists for this chat, and if it is still open. */
  presence?(chatId: string): "none" | "open" | "archived";
}

export interface HostTeleportOptions {
  /** The teleport folder for this host (chat records live under it). */
  dir: string;
  /** This host's machine id: the address a move must carry to be accepted here. */
  selfId: string;
  providers: readonly string[];
  /** The WP-60 lease root (the first-mate lease folder). Chat leases are taken there, not beside the chats. */
  leaseRoot: string;
  /** The host's session list. Without it a copy stays in the teleport store only (tests). */
  sessions?: HostChatSessions;
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
    ...(chat.modelSettings && Object.keys(chat.modelSettings).length > 0 ? { modelSettings: { ...chat.modelSettings } } : {}),
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
    this.finishLeftChats();
  }

  /**
   * A release that already recorded "the chat left" and then died before it archived the session leaves a
   * runnable copy. Finish that close. A chat that is still frozen or still live here is left alone.
   */
  private finishLeftChats(): void {
    const sessions = this.options.sessions;
    if (!sessions?.presence) return;
    let names: string[];
    try {
      names = readdirSync(this.chatsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const chatId = name.slice(0, -".json".length);
      if (!SAFE_ID.test(chatId)) continue;
      let stored: StoredChat | null;
      try {
        stored = this.load(chatId);
      } catch {
        continue;
      }
      if (!stored || stored.live || stored.frozenBy) continue;
      // This host still owns the copy. A record with no owner is a first move whose session was opened and then
      // the process died before that was saved: close it, the same as a chat that already left.
      if (stored.owner === this.options.selfId) continue;
      if (sessions.presence(chatId) === "open") sessions.close(chatId);
    }
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
    // A live copy runs in the host's session list, so that is what a move back carries (the copy received is only the
    // starting point). Without a session port, or when the host holds no session for it, the copy received is used.
    const running = stored.live && stored.owner === this.options.selfId ? this.options.sessions?.current?.(chatId) : null;
    const source = running ?? stored.live;
    const activity =
      stored.live && stored.owner === this.options.selfId ? (this.options.sessions?.activity?.(chatId) ?? null) : null;
    const live: ChatSnapshot | null = source
      ? {
          ...pick(source),
          queued: [...source.queued],
          turnRunning: activity?.turnRunning ?? false,
          approvalPending: activity?.approvalPending ?? false,
        }
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
    const activity = this.options.sessions?.activity?.(chatId);
    // A turn or an approval still running would finish on a copy the Mac has already read. Refuse the freeze.
    if (activity?.turnRunning || activity?.approvalPending) return false;
    this.save(chatId, { ...stored, frozenBy: moveId, frozenDevice: device, frozenTo: peer });
    this.options.sessions?.hold?.(chatId, true);
    return true;
  }

  async thaw(chatId: string, moveId: string, device: string): Promise<void> {
    const stored = this.load(chatId);
    if (stored?.frozenBy === moveId && stored.frozenDevice === device) {
      this.save(chatId, { ...stored, frozenBy: null, frozenDevice: null, frozenTo: null });
      this.options.sessions?.hold?.(chatId, false);
    }
  }

  async canResume(provider: Provider, model: string, _effort: string): Promise<CanResume> {
    if (!this.options.providers.includes(provider)) {
      return { ok: false, reason: `this host does not run ${provider}` };
    }
    // Effort may be absent: a Codex chat keeps it under another name, and some models have none.
    if (!model) return { ok: false, reason: "the chat has no model to resume with" };
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
    if (stored?.aborted?.includes(moveId)) throw new Error("This move was refused here, so its copy is turned away");
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
      aborted: stored?.aborted,
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
    // H4: the copy becomes a real session the desktop can open and use. If the session cannot be made, nothing is
    // activated, and the source's recovery refuses this move.
    this.options.sessions?.open(stored.incoming.payload, moveId);
    this.save(chatId, {
      owner: this.options.selfId,
      device,
      live: stored.incoming.payload,
      incoming: null,
      activatedBy: moveId,
      frozenBy: null,
      frozenDevice: null,
      frozenTo: null,
      aborted: stored.aborted,
    });
    this.releaseLease(chatId);
  }

  /**
   * M1: the atomic answer the source asks for when a move will not complete. A copy this move opened is "live". Otherwise
   * the move id is refused for good (a late copy or activation of it is turned away), any copy it stored is dropped, and
   * the source may thaw. A chat this host holds for another device is not touched.
   */
  async abort(chatId: string, moveId: string, device: string): Promise<"aborted" | "live"> {
    const stored = this.load(chatId);
    // A different device is refused. A live copy with no device recorded is refused too: it is not free for every caller.
    if (stored && stored.device !== null && stored.device !== device) throw new Error("This chat belongs to another device");
    if (stored?.live && stored.device !== device) throw new Error("This chat belongs to another device");
    if (stored?.incoming?.moveId === moveId && stored.incoming.device !== device) {
      throw new Error("This chat belongs to another device");
    }
    if (stored?.activatedBy === moveId && stored.owner === this.options.selfId) return "live";
    const base: StoredChat = stored ?? {
      owner: null,
      device: null,
      live: null,
      incoming: null,
      activatedBy: null,
      frozenBy: null,
      frozenDevice: null,
      frozenTo: null,
    };
    if (base.incoming?.moveId === moveId) this.releaseLease(chatId);
    const aborted = [...(base.aborted ?? []).filter((id) => id !== moveId), moveId].slice(-200);
    const ownsLive = !!(stored?.live && stored.owner === this.options.selfId);
    this.save(chatId, {
      ...base,
      incoming: base.incoming?.moveId === moveId ? null : base.incoming,
      aborted,
    });
    // Activate opens the host session before the record says the copy is live. A crash there leaves a
    // runnable session under a record that is still incoming. Abort must hold and close that session.
    // A live copy this host already owns (another move) is left as it is.
    if (!ownsLive) {
      this.options.sessions?.hold?.(chatId, true);
      this.options.sessions?.close(chatId);
    }
    return "aborted";
  }

  async release(chatId: string, moveId: string, to: string, device: string): Promise<void> {
    const stored = this.load(chatId);
    if (!stored || stored.frozenBy !== moveId) throw new Error("This move did not freeze the chat");
    if (stored.frozenDevice !== device) throw new Error("This move was started by another device");
    if (stored.frozenTo !== to) throw new Error("The release names a destination other than the one the move froze for");
    // Archive first, then record that the chat has left, then hold. A crash on the hold cannot leave a
    // runnable copy: the session is already archived, and the record already says the chat left.
    // Keep the releasing device so a later read by anyone else learns nothing, not even who holds the chat.
    this.options.sessions?.close(chatId);
    this.save(chatId, { ...stored, owner: to, device, live: null, frozenBy: null, frozenDevice: null, frozenTo: null, activatedBy: null });
    this.options.sessions?.hold?.(chatId, true);
  }
}
