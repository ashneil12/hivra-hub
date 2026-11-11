import { describe, expect, it } from "vitest";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Session } from "../../features/sessions/model/session";
import { registerSessionPersistFlush } from "../../features/sessions/model/sessionPersistFlush";
import { acceptStoredTeleportRow, applyTeleportRow } from "./teleportSessionState";

function session(id: string, title: string): Session {
  return { id, title, blocks: [], harness: "claude", model: "m", modelSettings: {}, runtimeMode: "default", cwd: "/p" } as unknown as Session;
}

function moved(id: string, title: string): Session {
  const row = session(id, title);
  row.blocks = [{ id: "teleported@host-a@1", role: "system", text: `Moved to ${title}`, notice: "teleported" } as never];
  return row;
}

describe("WP-177 HIGH A: App's session list takes the stored row after a move", () => {
  it("replaces the chat in place with the stored row, keeping the others", () => {
    let latest: Session[] = [session("a", "A"), session("b", "old B")];
    const ref = { current: latest } as RefObject<Session[]>;
    const setSessions = ((update: SetStateAction<Session[]>) => {
      latest = typeof update === "function" ? (update as (s: Session[]) => Session[])(latest) : update;
    }) as Dispatch<SetStateAction<Session[]>>;
    applyTeleportRow(ref, setSessions, moved("b", "stored B (moved)"));
    expect(ref.current.map((s) => [s.id, s.title])).toEqual([
      ["a", "A"],
      ["b", "stored B (moved)"],
    ]);
    expect(latest.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("a stored row with the same move notes does not replace the window's copy", () => {
    const current = session("b", "live title");
    const stored = session("b", "stale title from the last save");
    const ref = { current: [current] } as RefObject<Session[]>;
    const setSessions = (() => undefined) as Dispatch<SetStateAction<Session[]>>;
    applyTeleportRow(ref, setSessions, stored);
    expect(ref.current[0].title).toBe("live title");
  });

  it("a busy chat keeps its reply and takes only the stored move notes", () => {
    const current = session("b", "live");
    current.busy = true;
    current.blocks = [
      { id: "u1", role: "user", text: "hi" },
      { id: "teleport-release-owed-m2", role: "system", text: "{}", notice: "teleport-release-owed" },
      { id: "a2", role: "assistant", text: "half ", streaming: true },
    ] as never;
    const stored = session("b", "stale");
    stored.blocks = [
      { id: "u1", role: "user", text: "older" },
      { id: "teleported-back-m2", role: "system", text: "Moved back to this Mac", notice: "teleported-back" },
    ] as never;
    const ref = { current: [current] } as RefObject<Session[]>;
    const setSessions = (() => undefined) as Dispatch<SetStateAction<Session[]>>;
    applyTeleportRow(ref, setSessions, stored);
    expect(ref.current[0].busy).toBe(true);
    expect(ref.current[0].blocks.map((block) => block.id)).toEqual(["u1", "a2", "teleported-back-m2"]);
    expect(ref.current[0].blocks.find((block) => block.id === "a2")?.text).toBe("half ");
  });

  it("replaces a stored move note where it already sits, and only appends a new one", () => {
    const current = session("b", "live");
    current.busy = true;
    current.blocks = [
      { id: "u1", role: "user", text: "hi" },
      { id: "teleport-frozen-m1", role: "system", text: "old freeze", notice: "teleport-frozen" },
      { id: "a2", role: "assistant", text: "half " },
    ] as never;
    const stored = session("b", "stale");
    stored.blocks = [
      { id: "u1", role: "user", text: "older" },
      { id: "teleport-frozen-m1", role: "system", text: "new freeze", notice: "teleport-frozen" },
      { id: "teleport-incoming-m2", role: "system", text: "copy", notice: "teleport-incoming" },
    ] as never;
    const ref = { current: [current] } as RefObject<Session[]>;
    const setSessions = (() => undefined) as Dispatch<SetStateAction<Session[]>>;
    applyTeleportRow(ref, setSessions, stored);
    expect(ref.current[0].blocks.map((block) => block.id)).toEqual([
      "u1",
      "teleport-frozen-m1",
      "a2",
      "teleport-incoming-m2",
    ]);
    expect(ref.current[0].blocks.find((block) => block.id === "teleport-frozen-m1")?.text).toBe("new freeze");
    expect(ref.current[0].blocks.find((block) => block.id === "a2")?.text).toBe("half ");
  });

  it("flushes the pending save before it reads, so an idle chat keeps the reply", async () => {
    const current = session("b", "live");
    current.blocks = [{ id: "a9", role: "assistant", text: "the last reply" }] as never;
    const stored = session("b", "stored");
    stored.blocks = [
      { id: "u1", role: "user", text: "older" },
      { id: "teleported-back-m2", role: "system", text: "Moved back", notice: "teleported-back" },
    ] as never;
    let readRow = stored;
    const unregister = registerSessionPersistFlush(async (id) => {
      if (id !== "b") return;
      readRow = { ...stored, blocks: [...current.blocks, ...stored.blocks] };
    });
    const ref = { current: [current] } as RefObject<Session[]>;
    const setSessions = (() => undefined) as Dispatch<SetStateAction<Session[]>>;
    try {
      await acceptStoredTeleportRow(ref, setSessions, "b", async () => readRow);
      expect(ref.current[0].blocks.some((block) => block.id === "a9")).toBe(true);
    } finally {
      unregister();
    }
  });

  it("a row for a chat App does not hold is not added as a new tab", () => {
    const ref = { current: [session("a", "A")] } as RefObject<Session[]>;
    const setSessions = (() => undefined) as Dispatch<SetStateAction<Session[]>>;
    applyTeleportRow(ref, setSessions, session("zzz", "elsewhere"));
    expect(ref.current.map((s) => s.id)).toEqual(["a"]);
  });
});
