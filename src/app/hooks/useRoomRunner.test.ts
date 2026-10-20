// The app's side of the rooms in a Mono's own chat: how a busy Mono's wake ends, how a report turn for work delegated
// from a room is read, and how room turns and private messages show (one quiet line each, kept on reload).
import { describe, expect, it } from "vitest";
import { newSession, type Block, type Session } from "../../features/sessions/model/session";
import { groupMonoChatTurns, groupTurns } from "../../features/sessions/model/transcriptActivity";
import { sanitizeSessionForPersist } from "../../features/sessions/data/sessionStore";
import { answerAfter, reportAnswer, wakeEnd } from "./useRoomRunner";

const chat = (patch: Partial<Session> = {}): Session => ({ ...newSession("claude", "/code/hub"), id: "mono-frank", ...patch });
const note = { kind: "room" as const, from: "Leadership team", ref: "hub:leadership", line: "Answered Projects Manager" };

describe("a wake in a busy Mono's queue", () => {
  const wake = { id: "room-1", text: "[MonoCode room] ...", attachments: [], appRequestId: "room-1", monoNote: note };
  const steered: Block = { id: "s", role: "user", text: "[MonoCode room] ...", internal: true, appRequestId: "room-1", monoNote: note, sentAt: 5 };

  it("is still out while it waits or while the work it went into runs", () => {
    expect(wakeEnd(chat({ busy: true, queuedMessages: [wake] }), "room-1")).toBeUndefined();
    expect(wakeEnd(chat({ busy: true, blocks: [steered] }), "room-1")).toBeUndefined();
  });
  it("is done once its chat is idle again, failed with the chat's error, dropped when it left the queue unsent", () => {
    expect(wakeEnd(chat({ blocks: [steered, { id: "a", role: "assistant", text: "Posted it." }] }), "room-1")).toEqual({ status: "done" });
    expect(
      wakeEnd(chat({ blocks: [steered, { id: "e", role: "system", text: "Claude usage limit reached.", notice: "error" }] }), "room-1"),
    ).toEqual({ status: "failed", error: "Claude usage limit reached." });
    expect(wakeEnd(chat({ queuedMessages: [{ ...wake, error: "Delivery is unavailable." }] }), "room-1")).toEqual({ status: "failed", error: "Delivery is unavailable." });
    expect(wakeEnd(chat(), "room-1")).toEqual({ status: "dropped" });
    expect(wakeEnd(undefined, "room-1")).toEqual({ status: "dropped" });
  });
  it("reads the answer after the hidden prompt", () => {
    expect(answerAfter(chat({ blocks: [steered, { id: "a", role: "assistant", text: "NO_REPLY" }] }), "room-1")).toEqual({ delivered: true, text: "NO_REPLY" });
    expect(answerAfter(chat(), "room-1")).toEqual({ delivered: false, text: "" });
  });
});

describe("work delegated from a room coming back", () => {
  const report: Block = {
    id: "r",
    role: "user",
    text: "[MonoCode report] ...",
    internal: true,
    appRequestId: "mono-completion-app-mono-cos-q1-g1",
    monoSessionCompletion: { sessionId: "app-mono-cos-q1", title: "Launch shortlist", status: "completed" },
    startedAt: 10,
  };
  const answer: Block = { id: "a", role: "assistant", text: "Ash, the shortlist is in: stay on Base, Clanker v4 first." };
  it("waits until the owner has answered the report turn, then hands the room its answer", () => {
    expect(reportAnswer(chat({ busy: true, blocks: [report] }), "app-mono-cos-q1")).toBeUndefined();
    expect(reportAnswer(chat({ blocks: [report, answer] }), "app-mono-cos-q1")).toEqual({ answer: answer.text, title: "Launch shortlist" });
    expect(reportAnswer(chat({ blocks: [report, answer] }), "app-mono-cos-other")).toBeUndefined();
    const question = { ...report, monoSessionCompletion: { ...report.monoSessionCompletion!, question: true as const } };
    expect(reportAnswer(chat({ blocks: [question, answer] }), "app-mono-cos-q1")).toBeUndefined();
  });
});

describe("in the Mono's own chat", () => {
  const ash: Block = { id: "u1", role: "user", text: "fix the save bug", startedAt: 1 };
  const reply: Block = { id: "a1", role: "assistant", text: "On it." };
  const roomTurn: Block = { id: "p", role: "user", text: "[MonoCode room] ...", internal: true, appRequestId: "room-2", monoNote: note, startedAt: 2 };
  const roomReply: Block = { id: "r", role: "assistant", text: "06 passes from me." };
  const message: Block = {
    id: "m",
    role: "user",
    text: "[MonoCode message from Chief of Staff] ...",
    internal: true,
    appRequestId: "app-mono-cos-q2",
    monoNote: { kind: "message", from: "Chief of Staff", ref: "chief-of-staff", line: "Can you log the Friday rule?" },
    startedAt: 4,
  };

  it("a room's turn and a private message are turns of their own; Ash's next message never folds into them", () => {
    const steer: Block = { id: "u2", role: "user", text: "and the HUD", sentAt: 3 };
    expect(groupTurns([ash, reply, roomTurn, roomReply]).map((t) => t.map((b) => b.id))).toEqual([["u1", "a1"], ["p", "r"]]);
    expect(groupMonoChatTurns([ash, reply, roomTurn, roomReply, steer, message]).map((t) => t.map((b) => b.id))).toEqual([
      ["u1", "a1"],
      ["p", "r"],
      ["u2"],
      ["m"],
    ]);
  });

  it("a wake steered into running work stays inside that work", () => {
    const steered: Block = { ...roomTurn, id: "s", startedAt: undefined, sentAt: 2 };
    const work: Block = { id: "w", role: "assistant", text: "Still fixing the save bug." };
    expect(groupTurns([ash, reply, steered, work]).map((t) => t.map((b) => b.id))).toEqual([["u1", "a1", "w"]]);
  });

  it("keeps its note on reload", () => {
    const saved = sanitizeSessionForPersist({ ...chat(), blocks: [roomTurn, roomReply, message] });
    expect(saved.blocks[0]).toMatchObject({ internal: true, monoNote: note });
    expect(saved.blocks[2]).toMatchObject({ internal: true, monoNote: { kind: "message", from: "Chief of Staff" } });
  });

  it("a room's wake left in a queue isn't kept across a restart; a private message is, and goes in by itself", () => {
    const saved = sanitizeSessionForPersist({
      ...chat(),
      queuedMessages: [
        { id: "room-3", text: "[MonoCode room] ...", attachments: [], appRequestId: "room-3", monoNote: note },
        { id: "app-mono-cos-q3", text: "[MonoCode message from Chief of Staff] ...", attachments: [], appRequestId: "app-mono-cos-q3", monoNote: message.monoNote, waitForIdle: true },
      ],
    });
    expect(saved.queuedMessages?.map((m) => m.id)).toEqual(["app-mono-cos-q3"]);
    expect(saved.queuedMessages?.[0]).toMatchObject({ waitForIdle: true, monoNote: { kind: "message" } });
  });
});
