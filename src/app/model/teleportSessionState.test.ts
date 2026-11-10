import { describe, expect, it } from "vitest";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Session } from "../../features/sessions/model/session";
import { applyTeleportRow } from "./teleportSessionState";

function session(id: string, title: string): Session {
  return { id, title, blocks: [], harness: "claude", model: "m", modelSettings: {}, runtimeMode: "default", cwd: "/p" } as unknown as Session;
}

describe("WP-177 HIGH A: App's session list takes the stored row after a move", () => {
  it("replaces the chat in place with the stored row, keeping the others", () => {
    let latest: Session[] = [session("a", "A"), session("b", "old B")];
    const ref = { current: latest } as RefObject<Session[]>;
    const setSessions = ((update: SetStateAction<Session[]>) => {
      latest = typeof update === "function" ? (update as (s: Session[]) => Session[])(latest) : update;
    }) as Dispatch<SetStateAction<Session[]>>;
    applyTeleportRow(ref, setSessions, session("b", "stored B (moved)"));
    expect(ref.current.map((s) => [s.id, s.title])).toEqual([
      ["a", "A"],
      ["b", "stored B (moved)"],
    ]);
    expect(latest.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("a row for a chat App does not hold is not added as a new tab", () => {
    const ref = { current: [session("a", "A")] } as RefObject<Session[]>;
    const setSessions = (() => undefined) as Dispatch<SetStateAction<Session[]>>;
    applyTeleportRow(ref, setSessions, session("zzz", "elsewhere"));
    expect(ref.current.map((s) => s.id)).toEqual(["a"]);
  });
});
