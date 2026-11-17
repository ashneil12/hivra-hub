// "You asked" as a board of notes per project: which project an ask is for, which Needs you item it waits on, and the
// stacks in the order they show. Example data only.
import { describe, expect, it } from "vitest";
import { askAnswered, askBoard, askNeed, askProject, boardNotes, IDEAS, stackCount, UNSORTED, type BoardContext, type BoardNeed } from "./askBoard";
import type { AskedRow } from "./askedView";

const T0 = 1_800_000_000_000;

const PROJECTS = [
  { id: "exo", name: "EXO", mates: ["EXO lead"] },
  { id: "hivra", name: "Hivra", mates: ["Hivra lead"] },
  { id: "safetube", name: "SafeTube", mates: ["SafeTube lead"] },
];

let seq = 0;
const row = (patch: Partial<AskedRow>): AskedRow => {
  seq += 1;
  return {
    id: `ask-${seq}`,
    chatId: "chief-chat",
    blockId: "blk-1",
    title: "Example: something small",
    words: "Example: something small",
    at: T0 + seq,
    status: "heard",
    kind: "do",
    open: true,
    word: "Open",
    red: false,
    mateId: "chief",
    ...patch,
  };
};

const context = (patch: Partial<BoardContext> = {}): BoardContext => ({ projects: PROJECTS, ...patch });

describe("which project an ask is for", () => {
  it("is where he put it himself, before anything the app works out", () => {
    const ask = row({ project: "safetube", jobs: ["job-1"], title: "Example: fix the EXO menu", words: "Example: fix the EXO menu" });
    expect(askProject(ask, context({ jobs: [{ id: "job-1", project: "exo" }], mateProject: () => "hivra", chatProject: () => "hivra" }))).toBe("safetube");
  });

  it("is the project of the newest job that took it on", () => {
    const ask = row({ jobs: ["job-old", "job-new"] });
    const jobs = [
      { id: "job-old", project: "exo" },
      { id: "job-new", project: "hivra" },
    ];
    expect(askProject(ask, context({ jobs, mateProject: () => "safetube" }))).toBe("hivra");
  });

  it("is the first mate's one project, then the project the chat's folder is in", () => {
    expect(askProject(row({ mateId: "exo-lead" }), context({ mateProject: (id) => (id === "exo-lead" ? "exo" : undefined), chatProject: () => "hivra" }))).toBe("exo");
    expect(askProject(row({ chatId: "hivra-chat" }), context({ chatProject: (id) => (id === "hivra-chat" ? "hivra" : undefined) }))).toBe("hivra");
  });

  it("is the one project its words name, by the project's name or a first mate's", () => {
    expect(askProject(row({ words: "Example: add a pause button to SafeTube" }), context())).toBe("safetube");
    expect(askProject(row({ words: "Example: tell the Hivra lead the page is slow" }), context())).toBe("hivra");
  });

  it("is none when its words name two projects, or none", () => {
    expect(askProject(row({ words: "Example: use the EXO colours on the Hivra page" }), context())).toBeUndefined();
    expect(askProject(row({ words: "Example: the pricing thing from the call" }), context())).toBeUndefined();
  });

  it("never names a project the app does not have", () => {
    const ask = row({ project: "gone", jobs: ["job-1"] });
    expect(askProject(ask, context({ jobs: [{ id: "job-1", project: "also-gone" }], mateProject: () => "old", chatProject: () => "older" }))).toBeUndefined();
  });
});

describe("what an open ask waits on", () => {
  const question: BoardNeed = { key: "question:exo:music", kind: "question", projectId: "exo", sentence: "Which take for the boss music?" };

  it("is its own Needs you row once it has gone quiet", () => {
    const ask = row({});
    const own: BoardNeed = { key: `ask:${ask.id}`, kind: "ask", sentence: "Still open since Saturday." };
    expect(askNeed(ask, context({ needs: [question, own] }))).toBe(own);
  });

  it("is a job of its that stopped, by the job's id or its chat", () => {
    const ask = row({ jobs: ["job-7"] });
    const byKey: BoardNeed = { key: "stopped:job:job-7", kind: "stopped", sentence: "Example: out of credits" };
    const byApp: BoardNeed = { key: "stopped:x", kind: "stopped", sentence: "Example: out of credits", open: { where: "app", id: "app:job-7" } };
    const byChat: BoardNeed = { key: "stopped:y", kind: "stopped", sentence: "Example: out of credits", open: { where: "chat", id: "worker-chat" } };
    expect(askNeed(ask, context({ needs: [byKey] }))).toBe(byKey);
    expect(askNeed(ask, context({ needs: [byApp] }))).toBe(byApp);
    expect(askNeed(ask, context({ needs: [byChat], jobs: [{ id: "job-7", childSession: "worker-chat" }] }))).toBe(byChat);
    expect(askNeed(ask, context({ needs: [{ ...byKey, kind: "question" }] }))).toBeUndefined();
  });

  it("is the question its first mate says it waits on, read loosely", () => {
    const ask = row({ status: "waiting", note: "Which take for the boss music" });
    expect(askNeed(ask, context({ needs: [question] }), "exo")).toBe(question);
    expect(askNeed({ ...ask, note: "  which take for the BOSS music?  " }, context({ needs: [question] }), "exo")).toBe(question);
  });

  it("is not another project's question, a short sentence, or anything once the ask is not waiting", () => {
    const ask = row({ status: "waiting", note: "Which take for the boss music?" });
    expect(askNeed(ask, context({ needs: [question] }), "hivra")).toBeUndefined();
    expect(askNeed({ ...ask, note: "Which?" }, context({ needs: [{ ...question, sentence: "Which?" }] }), "exo")).toBeUndefined();
    expect(askNeed({ ...ask, status: "started" }, context({ needs: [question] }), "exo")).toBeUndefined();
    expect(askNeed({ ...ask, open: false }, context({ needs: [question] }), "exo")).toBeUndefined();
  });
});

describe("the notes", () => {
  it("are red when they wait on a Needs you item, and sit under that item's project when nothing else places them", () => {
    const ask = row({ words: "Example: make sure the page works on a small phone" });
    const own: BoardNeed = { key: `ask:${ask.id}`, kind: "ask", projectId: "hivra", sentence: "Still open since Saturday." };
    const [note] = boardNotes([ask], context({ needs: [own] }));
    expect(note.projectId).toBe("hivra");
    expect(note.needKey).toBe(own.key);
    expect(note.red).toBe(true);
  });

  it("keep what the list said of them when they wait on nothing", () => {
    const ask = row({ words: "Example: the pricing thing from the call" });
    const [note] = boardNotes([ask], context());
    expect(note).toEqual(ask);
  });
});

describe("the board", () => {
  const rows = (): AskedRow[] => [
    row({ id: "newest", words: "Example: make the EXO menu music loop" }),
    row({ id: "loose", words: "Example: the pricing thing from the call" }),
    row({ id: "idea", kind: "idea", words: "Example: maybe a referral reward one day" }),
    row({ id: "waiting", words: "Example: the boss music in EXO is too quiet", status: "waiting", note: "Which take for the boss music?", red: true }),
    row({ id: "tube", words: "Example: draft the SafeTube launch email" }),
    row({ id: "closed", words: "Example: redraw the Hivra icons", status: "done", open: false, word: "Done" }),
  ];
  const needs: BoardNeed[] = [{ key: "question:exo:music", kind: "question", projectId: "exo", sentence: "Which take for the boss music?" }];

  it("stacks open notes per project in the app's order, with what no project claims on top and ideas last", () => {
    const board = askBoard(rows(), context({ needs }));
    expect(board.byProject).toBe(true);
    expect(board.stacks.map((stack) => [stack.id, stack.kind, stack.name, stack.notes.map((note) => note.id)])).toEqual([
      [UNSORTED, "unsorted", "Not sorted yet", ["loose"]],
      ["exo", "project", "EXO", ["waiting", "newest"]],
      ["safetube", "project", "SafeTube", ["tube"]],
      [IDEAS, "ideas", "Ideas, for later", ["idea"]],
    ]);
    expect(board.open).toBe(5);
    expect(board.needs).toBe(1);
    expect(board.stacks.find((stack) => stack.id === "exo")?.needs).toBe(1);
  });

  it("keeps finished asks apart, each still under its project", () => {
    const board = askBoard(rows(), context({ needs }));
    expect(board.finished.map((note) => [note.id, note.projectId])).toEqual([["closed", "hivra"]]);
    expect(board.stacks.some((stack) => stack.id === "hivra")).toBe(false);
  });

  it("is the one plain list it always was with fewer than two projects", () => {
    const board = askBoard(rows(), context({ projects: [PROJECTS[0]], needs }));
    expect(board.byProject).toBe(false);
    expect(board.stacks).toHaveLength(1);
    expect(board.stacks[0].name).toBe("");
    expect(board.stacks[0].notes.map((note) => note.id)).toEqual(["waiting", "newest", "loose", "idea", "tube"]);
    expect(askBoard([], context({ projects: [] })).stacks).toEqual([]);
  });

  it("counts a stack in plain words", () => {
    const board = askBoard(rows(), context({ needs }));
    expect(board.stacks.map(stackCount)).toEqual(["1 ask", "2 asks", "1 ask", "1 idea"]);
  });
});

describe("answering the question a note waits on", () => {
  const answer = { key: "question:exo:music", words: "Take A", who: "EXO lead" };

  it("opens the ask again with his answer on it", () => {
    expect(askAnswered(row({ status: "waiting" }), answer)).toEqual({ status: "heard", note: "Answered: Take A. EXO lead has it." });
  });

  it("leaves an ask that was not waiting, a closed one, and one whose own row was answered", () => {
    expect(askAnswered(row({ status: "started" }), answer)).toBeUndefined();
    expect(askAnswered(row({ status: "waiting", open: false }), answer)).toBeUndefined();
    const quiet = row({ status: "waiting" });
    expect(askAnswered(quiet, { ...answer, key: `ask:${quiet.id}` })).toBeUndefined();
    expect(askAnswered(row({ status: "waiting" }), { ...answer, words: "  " })).toBeUndefined();
  });
});
