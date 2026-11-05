import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import type { TerminalSession } from "../../../../plugins/hivra-mirror/src/book.ts";
import { mergeTerminalSessions, sessionsFromWire, terminalStateLabel, terminalStatusText } from "./list";

function row(id: string, cwd: string): SessionSummary {
  return {
    id,
    cwd,
    harness: "claude",
    model: "claude",
    runtimeMode: "supervised",
    title: id,
    createdAt: 1,
    updatedAt: 1,
  };
}

function terminal(id: string, folder: string): TerminalSession {
  return { id, title: "Notes", folder, state: "running", blocks: [], updatedAt: 5 };
}

describe("the chat list", () => {
  it("adds a terminal session for this folder only, once, with its mark", () => {
    const rows = [row("chat-1", "/work/notes")];
    const terminals = [
      terminal("s", "/work/notes"),
      terminal("other", "/work/other"),
      terminal("s", "/work/notes"),
    ];
    const merged = mergeTerminalSessions(rows, [terminals[0]!, terminals[1]!], "/work/notes");
    expect(merged.map((item) => item.id)).toEqual(["terminal:s", "chat-1"]);
    expect(merged[0]?.terminal).toEqual({ state: "running", folder: "/work/notes" });
    expect(terminalStatusText(merged[0]!.terminal!)).toBe("Running · /work/notes");
    const again = mergeTerminalSessions(merged, [terminals[2]!], "/work/notes");
    expect(again).toHaveLength(2);
    expect(mergeTerminalSessions(rows, [terminal("s", "/work/notes")], "")).toEqual(rows);
    expect(mergeTerminalSessions(rows, [terminal("space", "/work/my notes")], "/work/my notes")[0]?.cwd).toBe(
      "/work/my notes",
    );
    expect(mergeTerminalSessions(rows, [terminal("uni", "/work/nöte")], "/work/nöte")).toHaveLength(2);
    expect(mergeTerminalSessions([], [terminal("win", "C:\\work\\notes")], "C:/work/notes")[0]?.id).toBe("terminal:win");
  });

  it("uses a plain label for a state it does not know", () => {
    expect(terminalStateLabel("waiting")).toBe("Waiting");
    expect(terminalStateLabel("nope")).toBe("Running");
  });

  it("drops a list it cannot trust, and keeps a sound session once", () => {
    expect(sessionsFromWire(null)).toEqual([]);
    expect(sessionsFromWire({ id: "s" })).toEqual([]);
    const sessions = sessionsFromWire([
      { id: "s", title: "Notes", folder: "/work/nöte", state: "waiting", blocks: [{ id: "b", role: "user", text: "hi" }] },
      { id: "s", title: "Again", folder: "/work/nöte", state: "running" },
      { id: "bad", state: "nope", blocks: [{ id: "", role: "nope", text: "x" }, { role: "user", text: "  " }] },
      "nope",
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ id: "s", state: "waiting", blocks: [{ id: "b", text: "hi" }] });
    expect(sessions[1]).toMatchObject({ id: "bad", state: "running", blocks: [] });
  });
});
