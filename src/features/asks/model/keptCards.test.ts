import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSession } from "../../sessions/data/sessionStore";
import type { Block } from "../../sessions/model/session";
import { besideBlock } from "./besideChat";
import { keptBesideMessage, keptCards, keptCatchUp, keptRollup } from "./keptCards";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.mocked(invoke).mockReset());

const catchUp = {
  since: 1_000,
  at: 2_000,
  finished: [{ id: "job-1", title: "Example: light the arena", project: "EXO", ok: true, chat: "exo-lead" }],
  finishedMore: 2,
  decided: [{ key: "font", question: "Example: keep Inter?", answer: "Keep Inter", why: "Matches the app." }],
  decidedMore: 0,
  needs: [{ key: "question:p:boss", sentence: "Example: which take?", who: "EXO lead" }],
  needsMore: 1,
  running: 4,
};
const rollup = { items: [{ key: "question:p:boss", sentence: "Example: which take?", where: "EXO", yours: false }], more: 3 };

describe("the one chat's cards kept by the chat store", () => {
  it("keeps each card whole", () => {
    expect(keptCatchUp(catchUp)).toEqual(catchUp);
    expect(keptRollup(rollup)).toEqual(rollup);
    const beside = besideBlock({ chatId: "exo-lead", to: "EXO lead", text: "Example: checkpoint first", at: 5 });
    expect(keptBesideMessage(beside.besideMessage)).toEqual(beside.besideMessage);
  });

  it("drops what isn't a card and the rows that don't read", () => {
    expect(keptCatchUp({ ...catchUp, at: "now" })).toBeUndefined();
    expect(keptCatchUp(null)).toBeUndefined();
    expect(keptCatchUp({ ...catchUp, finished: [{ id: "x" }, ...catchUp.finished], running: -3 })).toEqual({ ...catchUp, running: 0 });
    expect(keptRollup({ items: [{ key: "k" }], more: 1 })).toBeUndefined();
    expect(keptRollup({ items: "nope" })).toBeUndefined();
    expect(keptBesideMessage({ chatId: "a", to: "", text: "x", at: 1 })).toBeUndefined();
  });

  it("only on the app's own system blocks", () => {
    expect(keptCards({ role: "assistant", catchUp } as Block)).toEqual({});
    expect(keptCards({ role: "system", catchUp, needsRollup: rollup } as Block)).toEqual({ catchUp, needsRollup: rollup });
  });

  it("come back as cards when the chat loads again", async () => {
    const beside = besideBlock({ chatId: "exo-lead", to: "EXO lead", text: "Example: checkpoint first", at: 5 });
    vi.mocked(invoke).mockResolvedValue({
      id: "chief",
      cwd: "/tmp/a",
      harness: "claude",
      model: "claude:sonnet-5",
      modelSettings: {},
      runtimeMode: "default",
      title: "Chief of Staff",
      blocks: [
        { id: "u1", role: "user", text: "Example: hi" },
        { id: "catch-up-2000", role: "system", text: "Example: caught up", catchUp },
        beside,
        { id: "needs-rollup-9", role: "system", text: "Needs you now:\n- Example: which take?", needsRollup: rollup },
      ],
    });
    const blocks = (await readSession("chief"))?.blocks ?? [];
    expect(blocks.find((block) => block.id === "catch-up-2000")?.catchUp).toEqual(catchUp);
    expect(blocks.find((block) => block.id === beside.id)?.besideMessage).toEqual(beside.besideMessage);
    expect(blocks.find((block) => block.id === "needs-rollup-9")?.needsRollup).toEqual(rollup);
  });
});
