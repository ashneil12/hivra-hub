import { afterEach, describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import { besideBlock } from "./besideChat";
import { blockProjects, chiefLens, lensLookupFrom, lensNote, lensTag, setChiefLens, textProjects, turnProjects, type LensLookup } from "./chiefLens";
import { needLink } from "./needLinks";

const key = (path: string) => path.replace(/\/+$/, "");

const lookup: LensLookup = lensLookupFrom({
  projects: [
    { id: "vg-game", name: "EXO", folder: "/work/exo" },
    { id: "hivra", name: "Hivra", folder: "/work/hivra" },
    { id: "safe tube", name: "SafeTube", folder: "/work/safetube" },
  ],
  monos: [
    { name: "Iris", projects: ["/work/exo/"] },
    { name: "Chief of Staff", captain: true, projects: ["/work/exo", "/work/hivra"] },
    { name: "Helper", everyProject: true, projects: ["/work/hivra"] },
    { name: "Hivra lead", projects: ["/work/hivra"], projectSessions: { "/work/hivra": "hivra-chat" } },
  ],
  needs: [{ key: "question:vg-game:boss-music", projectId: "vg-game" }],
  chatFolder: (chatId) => (chatId === "exo-worktree" ? "/work/exo/.worktrees/a" : undefined),
  key,
});

const ids = (set: Iterable<string>) => [...set].sort();

afterEach(() => setChiefLens(null));

describe("telling a project's turns apart in the one chat", () => {
  it("finds a project by its name or its first mate's name, as a whole word, any case", () => {
    expect(ids(textProjects("Example: how is exo's boss arena?", lookup))).toEqual(["vg-game"]);
    expect(ids(textProjects("Example: ask Iris about the arena", lookup))).toEqual(["vg-game"]);
    expect(ids(textProjects("Example: the exoskeleton and hivrahub", lookup))).toEqual([]);
    expect(ids(textProjects("Example: EXO first, then Hivra", lookup))).toEqual(["hivra", "vg-game"]);
    // The Chief of Staff and a Mono on every project don't name one project.
    expect(ids(textProjects("Example: the Chief of Staff and Helper", lookup))).toEqual([]);
  });

  it("reads a linked question or chat as its project", () => {
    expect(ids(textProjects(`Example: [Which take?](${needLink("question:vg-game:boss-music")})`, lookup))).toEqual(["vg-game"]);
    expect(ids(textProjects("Example: see hivra://local/chat/exo-worktree", lookup))).toEqual(["vg-game"]);
    expect(ids(textProjects("Example: see hivra://local/chat/hivra-chat", lookup))).toEqual(["hivra"]);
    expect(ids(textProjects(`Example: [gone](${needLink("question:x:gone")})`, lookup))).toEqual([]);
    // The app's own link address is not the project called Hivra, and neither is a web address.
    expect(ids(textProjects("Example: hivra://local/chat/nowhere and https://hivra.example/exo", lookup))).toEqual([]);
  });

  it("takes the app's cards and his narrowed message at their word", () => {
    expect(ids(blockProjects({ id: "u", role: "user", text: "Example: what's left?", lensProject: "hivra" }, lookup))).toEqual(["hivra"]);
    expect(ids(blockProjects({ id: "u", role: "user", text: "Example: what's left?", lensProject: "deleted" }, lookup))).toEqual([]);
    const rollup = { id: "r", role: "system", text: "Needs you now", needsRollup: { items: [{ key: "k", sentence: "Example?", projectId: "hivra", yours: false }, { key: "question:vg-game:boss-music", sentence: "Example?", yours: false }], more: 0 } } as Block;
    expect(ids(blockProjects(rollup, lookup))).toEqual(["hivra", "vg-game"]);
    const catchUp = { id: "c", role: "system", text: "", catchUp: { since: 0, at: 1, finished: [{ id: "j", title: "Example", ok: true, projectId: "vg-game" }], finishedMore: 0, decided: [], decidedMore: 0, needs: [], needsMore: 0, running: 0 } } as Block;
    expect(ids(blockProjects(catchUp, lookup))).toEqual(["vg-game"]);
    expect(ids(blockProjects(besideBlock({ chatId: "hivra-chat", to: "Hivra lead", text: "Example: go", at: 1 }), lookup))).toEqual(["hivra"]);
    expect(ids(blockProjects(besideBlock({ chatId: "unknown", to: "EXO lead", text: "Example: go", at: 1 }), lookup))).toEqual(["vg-game"]);
    // A tool's words are the work, not what the turn is about.
    expect(ids(blockProjects({ id: "t", role: "tool", text: "EXO" } as Block, lookup))).toEqual([]);
  });

  it("puts a turn under every project it touches, and nowhere when it touches none", () => {
    const turn: Block[] = [
      { id: "u", role: "user", text: "Example: morning" },
      { id: "a", role: "assistant", text: "Example: EXO is fine; Hivra needs a headline." },
    ];
    expect(turnProjects(turn, lookup).sort()).toEqual(["hivra", "vg-game"]);
    expect(turnProjects([{ id: "u", role: "user", text: "Example: thanks" }], lookup)).toEqual([]);
  });

  it("keeps a tag one word and tells the Chief of Staff what the message is about", () => {
    expect(lensTag("safe tube")).toBe("safe_tube");
    expect(lensNote({ name: "EXO" })).toContain("Ash is looking at only EXO in this chat");
    setChiefLens("hivra");
    expect(chiefLens()).toBe("hivra");
    setChiefLens("  ");
    expect(chiefLens()).toBeNull();
  });
});
