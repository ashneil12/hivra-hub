// PR #214 hard review, round 1: red repros on this Mac's side, against the real session store (only the Tauri boundary is
// an in-memory backend, with the Rust guard's rules as in teleportRound3.realStore.test.ts) and the real host store over
// the JSON wire. Each case states the RIGHT outcome.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../../features/sessions/model/session";

type Row = Record<string, unknown> & { id: string; blocks: Array<Record<string, unknown>> };

const backend = vi.hoisted(() => new Map<string, Row>());

const fakeGuard = vi.hoisted(() => {
  const idsWith = (blocks: Array<Record<string, unknown>>, notice: string) =>
    blocks.filter((b) => b.notice === notice).map((b) => String(b.id));
  const away = (blocks: Array<Record<string, unknown>>): string | null => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].notice === "teleported-back") return null;
      if (blocks[i].notice === "teleported") return String(blocks[i].id);
    }
    return null;
  };
  return (prev: Array<Record<string, unknown>> | undefined, next: Array<Record<string, unknown>>, teleport?: { op: string; moveId: string }) => {
    if (!prev) return;
    const storedFrozen = idsWith(prev, "teleport-frozen");
    const nextFrozen = idsWith(next, "teleport-frozen");
    if (!teleport) {
      if (storedFrozen.some((id) => !nextFrozen.includes(id))) throw new Error("teleport-refused: a save would drop a freeze");
      if (away(prev) !== away(next)) throw new Error("teleport-refused: a save would change whether the chat is away");
      return;
    }
    if (teleport.op === "freeze" && (storedFrozen.length > 0 || away(prev) !== null)) {
      throw new Error("teleport-conflict: another move or a resume already holds this chat");
    }
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "session_upsert") {
      const session = args.session as Row & { teleport?: { op: string; moveId: string } };
      const prev = backend.get(session.id);
      // Ordinary saves keep the stored move notes (session_store.rs prepare_teleport_blocks). A step is stored as sent.
      if (prev && !session.teleport) {
        const away = (() => {
          for (let i = prev.blocks.length - 1; i >= 0; i--) {
            const notice = prev.blocks[i]?.notice;
            if (notice === "teleported-back") return false;
            if (notice === "teleported") return true;
          }
          return false;
        })();
        if (away) {
          // The release already took the transcript, the provider session and the queue. A pre-move copy cannot put them back.
          session.blocks = [...prev.blocks];
          session.providerSessionId = prev.providerSessionId;
          session.queuedMessages = prev.queuedMessages;
        } else {
          const owned = new Set(["teleport-frozen", "teleport-freeze-asked", "teleport-incoming", "teleport-release-owed", "teleport-aborted", "teleported", "teleported-back"]);
          const body = session.blocks.filter((block) => !owned.has(String(block.notice ?? "")));
          const notes = prev.blocks.filter((block) => owned.has(String(block.notice ?? "")));
          session.blocks = [...body, ...notes];
        }
      }
      fakeGuard(prev?.blocks, session.blocks, session.teleport);
      const { teleport: _teleport, ...stored } = session;
      backend.set(String(session.id), JSON.parse(JSON.stringify(stored)));
      return { id: session.id };
    }
    if (command === "session_get") {
      const row = backend.get(String(args.sessionId));
      if (!row) return null;
      const copy = JSON.parse(JSON.stringify(row)) as Row;
      // As Rust session_get does (tool_detail::omit_large_details): a tool detail over 512 bytes is left in storage.
      for (const block of copy.blocks) {
        const tool = block.tool as Record<string, unknown> | undefined;
        if (tool && typeof tool.detail === "string" && tool.detail.length > 512) {
          delete tool.detail;
          tool.detailOmitted = true;
        }
      }
      return copy;
    }
    if (command === "session_list_by_project" || command === "session_list_folderless" || command === "session_list_linked") {
      return [...backend.values()].map((row) => ({ ...row }));
    }
    return null;
  }),
}));

import { forgetMovedRowsForTests, getSession, upsertSession } from "../../../features/sessions/data/sessionStore";
import { movedChatPrompt } from "../../../features/sessions/model/handoff";
import { sessionStoreChatPort } from "./teleportStorePort";
import { localMoveEndpoint } from "../model/teleportLocal";
import { sshMoveEndpoint, type HostCall } from "../model/teleportSsh";
import { HostTeleportStore } from "../../../../host/teleport/store";
import { teleportRpc } from "../../../../host/teleport/rpc";
import { approvePlan, moveChat, planMove, type MoveEndpoint } from "../model/teleport";
import { approveAndMove, planFromSession, recoverSavedMoves, YOUNG_MOVE_MS } from "../model/teleportMove";
import { teleportStateOf } from "../model/teleportState";
import { unlockChat } from "../model/teleportLock";

class TestMouseEvent {
  readonly type: string;
  isTrusted = false;
  constructor(type: string) {
    this.type = type;
  }
}
(globalThis as unknown as { MouseEvent: unknown }).MouseEvent = TestMouseEvent;
const click = () => Object.assign(new TestMouseEvent("click"), { isTrusted: true }) as never;

const CHAT = "review-mac-chat";
const HOST = "host-a";
const CWD = "/projects/review";

function preMove(extra: Partial<Session> = {}): Session {
  return {
    id: CHAT,
    harness: "claude",
    model: "test-model-1",
    modelSettings: { effort: "high" },
    runtimeMode: "default",
    title: "Review chat",
    cwd: CWD,
    busy: false,
    blocks: [
      { id: "u1", role: "user", text: "Remember the codeword teal." },
      { id: "a1", role: "assistant", text: "Noted: the codeword is teal." },
    ],
    providerSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    queuedMessages: [],
    ...extra,
  } as unknown as Session;
}

async function move(from: MoveEndpoint, to: MoveEndpoint, moveId: string) {
  const record = await from.read(CHAT);
  const planned = await planMove(record!.live!, from.id, to.id);
  if (!planned.ok) throw new Error(`plan refused: ${planned.refusal.reason}`);
  return moveChat({ chatId: CHAT, from, to, approval: approvePlan(planned.plan, click()), moveId, at: "2026-11-11T09:00:00.000Z" });
}

describe("PR 214 review: this Mac's side", () => {
  let dir: string;
  let host: HostTeleportStore;
  const wireAs =
    (device: string, hook?: (method: string) => "before-throw" | undefined): HostCall =>
    async (method, params) => {
      if (hook?.(method) === "before-throw") throw new Error("The host request did not complete. Retry to confirm its result.");
      return JSON.parse(JSON.stringify((await teleportRpc(host, method, JSON.parse(JSON.stringify(params)), device)) ?? null));
    };
  const local = () => localMoveEndpoint({ machineId: "this-mac", port: sessionStoreChatPort(), labelFor: () => "Studio box" });

  beforeEach(() => {
    backend.clear();
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    dir = mkdtempSync(path.join(tmpdir(), "review214-mac-"));
    host = new HostTeleportStore({ dir, selfId: HOST, providers: ["claude", "codex"], leaseRoot: path.join(dir, "leases") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a chat moved back still sends the chat so far with its first turn after the app reads the stored row", async () => {
    await upsertSession(preMove());
    const remote = sshMoveEndpoint(HOST, wireAs("dev-1"));
    expect((await move(local(), remote, "m1")).status).toBe("moved");
    expect((await move(remote, local(), "m2")).status).toBe("moved");
    // The panel's refreshRow (and every restart) hands App the stored row; App's first send wraps the text with it.
    const row = (await getSession(CHAT))!;
    expect(teleportStateOf(row).moved).toBe(false);
    expect(row.providerSessionId).toBeFalsy();
    const prompt = movedChatPrompt(row, "What codeword did I ask you to remember?");
    // Today moveBriefOwed is never saved (persistableMeta / SessionRecord drop it), so the fresh conversation gets only this text.
    expect(prompt).toContain("Remember the codeword teal.");
  });

  it("a move back whose host release failed is finished by recovery, so the host does not keep a second live copy", async () => {
    await upsertSession(preMove());
    expect((await move(local(), sshMoveEndpoint(HOST, wireAs("dev-1")), "m1")).status).toBe("moved");
    let failRelease = true;
    const flaky = sshMoveEndpoint(
      HOST,
      wireAs("dev-1", (m) => {
        if (m === "teleport.release" && failRelease) {
          failRelease = false;
          return "before-throw";
        }
        return undefined;
      }),
    );
    const result = await move(flaky, local(), "m2");
    expect(result.status).toBe("partial");
    // The Mac opened its copy; the host still holds its live copy, frozen for m2.
    expect(teleportStateOf((await getSession(CHAT))!).moved).toBe(false);
    // Launch recovery (and its retries) over the saved store, long after the move.
    const healthy = sshMoveEndpoint(HOST, wireAs("dev-1"));
    await recoverSavedMoves({
      chatIds: [CHAT],
      port: sessionStoreChatPort(),
      local: local(),
      remoteFor: () => healthy,
      now: Date.now() + YOUNG_MOVE_MS + 1,
    });
    // Today nothing on the Mac remembers the unreleased host copy (activate drops the incoming notice), so recovery never
    // asks the host to release, and the host keeps a live copy the desktop's remote view still runs.
    expect((await host.read(CHAT, "dev-1"))?.live ?? null).toBeNull();
  });

  it("a Codex chat (its reasoning effort under reasoningEffort, as the live catalog names it) can move", async () => {
    await upsertSession(
      preMove({ harness: "codex", model: "gpt-test", modelSettings: { reasoningEffort: "high" } } as Partial<Session>),
    );
    const result = await move(local(), sshMoveEndpoint(HOST, wireAs("dev-1")), "m1");
    // Today the move reads only modelSettings.effort and sends "", which the host RPC rejects ("Invalid effort"): the move
    // fails at resume-check for every Codex chat (and any chat whose model has no effort setting).
    expect(result.status).toBe("moved");
  });
  it("a chat that ran a tool in this window moves: the panel's plan (App's copy) matches what the move reads", async () => {
    // App holds the chat as this window ran it: the tool's full output is in memory. The saved row has it too, but
    // session_get leaves any output over 512 bytes in storage, so the move's read differs from App's copy.
    const inApp = preMove({
      blocks: [
        { id: "u1", role: "user", text: "List the folder." },
        { id: "t1", role: "tool", text: "Ran ls", tool: { kind: "shell", title: "ls", status: "completed", detail: "file\n".repeat(200) } },
        { id: "a1", role: "assistant", text: "Here it is." },
      ],
    } as Partial<Session>);
    await upsertSession(inApp);
    const mac = local();
    const remote = sshMoveEndpoint(HOST, wireAs("dev-1"));
    // The panel: Start plans from App's session, Approve moves with the same session (TeleportMovePanel start/approve).
    const planned = await planFromSession(inApp, mac.id, remote.id);
    if (!planned.ok) throw new Error(planned.refusal.reason);
    const { result } = await approveAndMove({
      session: inApp,
      plan: planned.plan,
      gesture: click(),
      from: mac,
      to: remote,
      moveId: "m1",
      at: "2026-11-11T09:00:00.000Z",
    });
    // Today: refused "approval-stale" on every attempt, because the plan hashes App's copy and the move hashes the read.
    expect(result.status).toBe("moved");
  });
});
