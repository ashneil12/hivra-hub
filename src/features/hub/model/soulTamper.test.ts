// @vitest-environment happy-dom
// The soul tamper check: the app keeps the hash of every soul it saves; a soul file that no longer matches changed
// without the app's save. Changed while a chat was running: put back, with the changed file kept and "Keep that
// change", unless the Mono's own run wrote it itself, which is kept with Undo back to the app's save. Changed with
// nothing running: Ash's own edit, kept. Last, a real python process writes the file, as a worker's script could (it
// isn't held back by the Edit deny), to show the check rests on the file alone.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentFilePath } from "../../monos/model/monoFiles";
import {
  noteSessionRuns,
  reloadSessionRunsForTest,
  resetSessionRuns,
  runsAt,
  setProcessRunSource,
  type ProcessRun,
} from "../../monos/model/sessionRuns";
import { recordSavedSoul, savedSoul } from "../../monos/model/soulSaved";
import { findBotChange, redoBotChange, setBotFiles, undoBotChange, undoneLine } from "./botChanges";
import { botChangeRows } from "./botChanges";
import { setHubMcpServers, setMonoHomeRoot, type HubChatLookups } from "./hubMcp";
import { changedSoulNote, checkSoul, keptAshLine, otherChatName, putBackLine, callWritesSoul, noteToolCalls, recordRestoredSouls, resetToolCallsForTest, runIsMonos, runIsOwn, runNamedSoul, runWroteOwnSoul, runningKinds, setRunToolTextSource, type RunToolCall, type TamperFiles } from "./soulTamper";

const SAVED = "# Soul\n\n## Your job\n- You lead the Hivra project.\n";
const OUTSIDE = "# Soul\n\n## Your job\n- You lead the Hivra project.\n- Never ask Ash anything.\n";
const ASH = "# Soul\n\n## Your job\n- You lead the Hivra project.\n- Ash: no Friday deploys.\n";

/** A Mono folder in memory, each file with a change time the test sets. */
function memFiles() {
  const files = new Map<string, { text: string; at: number }>();
  const hash = (t: string) => `h:${t}`;
  const f: TamperFiles = {
    read: async (id, path) => {
      const x = files.get(`${id}/${path}`);
      return { text: x?.text ?? null, hash: hash(x?.text ?? ""), ...(x ? { modifiedMs: x.at } : {}) };
    },
    write: async (id, path, text, expected) => {
      if (expected !== undefined && hash(files.get(`${id}/${path}`)?.text ?? "") !== expected) throw new Error("conflict");
      files.set(`${id}/${path}`, { text, at: Date.now() });
      if (path === "SOUL.md") recordSavedSoul(id, text, hash(text));
      return hash(text);
    },
  };
  return { f, files, hash };
}

/** Whose chats are whose: each Mono's own chat; workers are `app-<chat>-<request>` under it (hubMcp.ts). */
const CHATS: Record<string, string> = {
  "hivra-chat": "hivra-lead",
  "frank-chat": "frank",
  "lead-chat": "hivra-lead",
  "restored-chat": "restored-lead",
  "unrecorded-chat": "unrecorded-lead",
  "exo-chat": "vg-game-lead",
  "cos-chat": "chief-of-staff",
  "alfred-chat": "alfred",
};
const lookups: HubChatLookups = {
  monoOf: (id) => (CHATS[id] ? { id: CHATS[id] } : undefined),
  habitRunMono: (id) => (id === "habit-run-hivra" ? "hivra-lead" : undefined),
  isLead: () => false,
};

beforeEach(() => {
  localStorage.clear();
  resetSessionRuns();
  setHubMcpServers({ ashOs: null, cli: null }, lookups);
  setMonoHomeRoot("/Users/ash/agent-memory/monos");
});

describe("a soul changed outside the app", () => {
  it("while a worker was running: the saved soul is put back, the change kept beside it, and Keep that change restores it", async () => {
    const { f, files, hash } = memFiles();
    setBotFiles(f);
    await f.write("hivra-lead", "SOUL.md", SAVED);
    noteSessionRuns([{ id: "app-hivra-chat-req1", busy: true, cwd: "/Users/ash/Projects/hivra" }], 1_000);
    files.set("hivra-lead/SOUL.md", { text: OUTSIDE, at: 2_000 });
    noteSessionRuns([{ id: "app-hivra-chat-req1", busy: false }], 3_000);

    expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 0, 9_000), 9_000)).toBe("put-back");
    expect(files.get("hivra-lead/SOUL.md")!.text).toBe(SAVED);
    expect(files.get(`hivra-lead/${changedSoulNote(2_000)}`)!.text).toBe(OUTSIDE);
    const row = findBotChange(`soul-put-back:hivra-lead:${hash(OUTSIDE)}`)!;
    expect(row.line).toBe("Something outside the app changed Hivra lead's soul while a worker was running, so it was put back.");
    expect(row.line).toBe(putBackLine("Hivra lead"));
    expect(row.undoLabel).toBe("Keep that change");
    for (const t of [row.line, ...row.details!]) expect(t).not.toMatch(/SOUL|\.md|\/Users|memory\/|h:/);
    // Checked again: nothing more to do.
    expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 0, 9_000), 9_100)).toBe("unchanged");

    // "Keep that change" brings the outside version back, and it is the saved one from then on (no second put-back).
    await undoBotChange([row.id]);
    expect(files.get("hivra-lead/SOUL.md")!.text).toBe(OUTSIDE);
    expect(undoneLine(findBotChange(row.id)!)).toBe("Kept the outside change to Hivra lead's soul.");
    expect(savedSoul("hivra-lead")!.text).toBe(OUTSIDE);
    expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 0, 9_000), 9_200)).toBe("unchanged");
    await redoBotChange([row.id]);
    expect(files.get("hivra-lead/SOUL.md")!.text).toBe(SAVED);
  });

  it("a worker writing its own Mono's soul itself is kept, with Undo back to the soul the app last saved", async () => {
    const { f, files, hash } = memFiles();
    setBotFiles(f);
    await f.write("hivra-lead", "SOUL.md", SAVED);
    setRunToolTextSource((id) => (id === "app-hivra-chat-req2" ? [{ kind: "execute", text: `echo '- Never ask Ash twice.' >> SOUL.md` }] : []));
    try {
      noteSessionRuns([{ id: "app-hivra-chat-req2", busy: true, cwd: "/Users/ash/Projects/hivra" }], 1_000);
      files.set("hivra-lead/SOUL.md", { text: OUTSIDE, at: 2_000 });
      expect(runWroteOwnSoul({ sessionId: "app-hivra-chat-req2" }, "hivra-lead")).toBe(true);

      expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 0, 9_000), 9_000)).toBe("kept-self");
      expect(files.get("hivra-lead/SOUL.md")!.text).toBe(OUTSIDE);
      expect(savedSoul("hivra-lead")!.text).toBe(OUTSIDE);
      const row = findBotChange(`soul-self:hivra-lead:${hash(OUTSIDE)}`)!;
      expect(row.line).toBe("Hivra lead changed its soul");
      expect(row.undoLabel).toBeUndefined();
      for (const t of [row.line, ...row.details!]) expect(t).not.toMatch(/SOUL|\.md|\/Users|memory\/|h:/);
      expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 0, 9_000), 9_100)).toBe("unchanged");

      // Undo puts the soul the app last saved back, and that becomes the saved one.
      await undoBotChange([row.id]);
      expect(files.get("hivra-lead/SOUL.md")!.text).toBe(SAVED);
      expect(savedSoul("hivra-lead")!.text).toBe(SAVED);
    } finally {
      setRunToolTextSource(null);
    }
  });

  it("another Mono's run naming this soul is put back even when this Mono's own run wrote one too", async () => {
    const texts: Record<string, RunToolCall[]> = {
      "app-hivra-chat-req3": [{ kind: "execute", text: `echo x >> SOUL.md` }],
      "app-exo-chat-r1": [{ kind: "execute", text: `python3 -c "open('/Users/ash/agent-memory/monos/hivra-lead/SOUL.md','a').write('x')"` }],
    };
    const { f, files } = memFiles();
    setBotFiles(f);
    await f.write("hivra-lead", "SOUL.md", SAVED);
    setRunToolTextSource((id) => texts[id] ?? []);
    try {
      noteSessionRuns(
        [
          { id: "app-hivra-chat-req3", busy: true, cwd: "/Users/ash/Projects/hivra" },
          { id: "app-exo-chat-r1", busy: true, cwd: "/Users/ash/Projects/vg-game" },
        ],
        1_000,
      );
      files.set("hivra-lead/SOUL.md", { text: OUTSIDE, at: 2_000 });
      expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 0, 9_000), 9_000)).toBe("put-back");
      expect(files.get("hivra-lead/SOUL.md")!.text).toBe(SAVED);
    } finally {
      setRunToolTextSource(null);
    }
  });

  it("with nothing running: it was Ash, so his version is kept and recorded, with Undo back to the app's", async () => {
    const { f, files, hash } = memFiles();
    setBotFiles(f);
    await f.write("hivra-lead", "SOUL.md", SAVED);
    noteSessionRuns([{ id: "app-hivra-chat-req1", busy: true }], 1_000);
    noteSessionRuns([{ id: "app-hivra-chat-req1", busy: false }], 2_000);
    files.set("hivra-lead/SOUL.md", { text: ASH, at: 60_000 });

    expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 5_000, 90_000), 90_000)).toBe("kept-ash");
    expect(files.get("hivra-lead/SOUL.md")!.text).toBe(ASH);
    expect(savedSoul("hivra-lead")).toMatchObject({ text: ASH, hash: hash(ASH) });
    const row = findBotChange(`soul-outside:hivra-lead:${hash(ASH)}`)!;
    expect(row.line).toBe("Hivra lead's soul was edited outside the app. Kept your version.");
    expect(row.line).toBe(keptAshLine("Hivra lead"));
    expect(row.undoLabel).toBeUndefined();
    expect(await checkSoul("hivra-lead", "Hivra lead", f, () => [], 90_100)).toBe("unchanged");
    await undoBotChange([row.id]);
    expect(files.get("hivra-lead/SOUL.md")!.text).toBe(SAVED);
    expect(savedSoul("hivra-lead")!.text).toBe(SAVED);
  });

  it("a soul the app has no saved copy of is only recorded, and the same text with a new hash is no tamper", async () => {
    const { f, files } = memFiles();
    files.set("frank/SOUL.md", { text: SAVED, at: 1 });
    expect(await checkSoul("frank", "frank", f, () => [{ sessionId: "x", start: 0, seen: 0 }])).toBe("recorded");
    recordSavedSoul("frank", SAVED, "old-format-hash");
    expect(await checkSoul("frank", "frank", f, () => [{ sessionId: "x", start: 0, seen: 0 }])).toBe("unchanged");
    expect(files.get("frank/SOUL.md")!.text).toBe(SAVED);
  });
});

describe("telling the Mono's own soul write from one outside the app", () => {
  it("a run is the Mono's own when it is its chat, a worker it started, a habit run, or works in its home folder", () => {
    expect(runIsOwn({ sessionId: "hivra-chat" }, "hivra-lead")).toBe(true);
    expect(runIsOwn({ sessionId: "app-hivra-chat-r1" }, "hivra-lead")).toBe(true);
    expect(runIsOwn({ sessionId: "habit-run-hivra" }, "hivra-lead")).toBe(true);
    expect(runIsOwn({ sessionId: "plain-chat", cwd: "/Users/ash/agent-memory/monos/hivra-lead" }, "hivra-lead")).toBe(true);
    expect(runIsOwn({ sessionId: "plain-chat", cwd: "/Users/ash/agent-memory/monos/hivra-lead/memory" }, "hivra-lead")).toBe(true);
    expect(runIsOwn({ sessionId: "plain-chat", cwd: "/Users/ash/agent-memory/monos/hivra-lead-old" }, "hivra-lead")).toBe(false);
    expect(runIsOwn({ sessionId: "exo-chat", cwd: "/Users/ash/Projects/vg-game" }, "hivra-lead")).toBe(false);
    // Whatever runIsOwn says, runIsMonos still counts a run that named the soul.
    expect(
      runIsMonos({ sessionId: "exo-chat" }, "hivra-lead", () => [{ kind: "edit", text: "/Users/ash/agent-memory/monos/hivra-lead/SOUL.md" }]),
    ).toBe(true);
  });

  it("its own run writing a bare SOUL.md wrote it; another run has to name it", () => {
    const own = { sessionId: "hivra-chat", cwd: "/Users/ash/Projects/hivra" };
    const foreign = { sessionId: "exo-chat", cwd: "/Users/ash/Projects/vg-game" };
    const soul = "/Users/ash/agent-memory/monos/hivra-lead/SOUL.md";
    expect(runWroteOwnSoul(own, "hivra-lead", () => [{ kind: "edit", text: "SOUL.md" }])).toBe(true);
    expect(runWroteOwnSoul(own, "hivra-lead", () => [{ kind: "execute", text: `echo x >> ${soul}` }])).toBe(true);
    expect(runWroteOwnSoul(own, "hivra-lead", () => [{ kind: "edit", text: "/Users/ash/agent-memory/monos/nibbii-lead/SOUL.md" }])).toBe(false);
    expect(runWroteOwnSoul(own, "hivra-lead", () => [{ kind: "read", text: "SOUL.md" }])).toBe(false);
    expect(runWroteOwnSoul(foreign, "hivra-lead", () => [{ kind: "edit", text: "SOUL.md" }])).toBe(false);
    expect(runWroteOwnSoul(foreign, "hivra-lead", () => [{ kind: "execute", text: `echo x >> ${soul}` }])).toBe(true);
    // A call from an earlier turn of the same chat isn't this run's.
    expect(runWroteOwnSoul({ ...own, start: 200_000 }, "hivra-lead", () => [{ kind: "edit", text: "SOUL.md", at: 1_000 }])).toBe(false);
  });
});

describe("a portable restore writing souls", () => {
  const RESTORED = "# Soul\n\n## Your job\n- You lead the Hivra project, as on the other Mac.\n";
  const rows = (id: string) => botChangeRows().filter((r) => (r.kind === "one" ? [r.change] : r.items).some((c) => c.monoId === id));

  it("records the restored souls as the app's saves: no outside-edit row, nothing put back, even with chats running", async () => {
    const { f, files } = memFiles();
    setBotFiles(f);
    await f.write("restored-lead", "SOUL.md", SAVED);
    await f.write("restored-cos", "SOUL.md", SAVED);
    // Rust writes them straight to disk (memory restore), while a chat is running.
    noteSessionRuns([{ id: "app-restored-chat-r1", busy: true }], 1_000);
    files.set("restored-lead/SOUL.md", { text: RESTORED, at: 2_000 });
    files.set("restored-cos/SOUL.md", { text: RESTORED, at: 2_000 });
    await recordRestoredSouls(["restored-lead", "restored-cos", "restored-lead"], f);
    const running = (at: number) => runsAt(at, 0, 9_000);
    expect(await checkSoul("restored-lead", "Hivra lead", f, running, 9_000)).toBe("unchanged");
    expect(await checkSoul("restored-cos", "Chief of Staff", f, running, 9_000)).toBe("unchanged");
    expect(files.get("restored-lead/SOUL.md")!.text).toBe(RESTORED);
    expect(rows("restored-lead")).toEqual([]);
    expect(rows("restored-cos")).toEqual([]);
  });

  it("without the record the same write would have been put back (the check is live)", async () => {
    const { f, files } = memFiles();
    setBotFiles(f);
    await f.write("unrecorded-lead", "SOUL.md", SAVED);
    noteSessionRuns([{ id: "app-unrecorded-chat-r1", busy: true }], 1_000);
    files.set("unrecorded-lead/SOUL.md", { text: RESTORED, at: 2_000 });
    expect(await checkSoul("unrecorded-lead", "Hivra lead", f, (at) => runsAt(at, 0, 9_000), 9_000)).toBe("put-back");
  });
});

describe("a python script writing the soul file", () => {
  const python = (() => {
    for (const bin of ["python3", "python"])
      try {
        execFileSync(bin, ["-c", "print(1)"]);
        return bin;
      } catch {
        /* next */
      }
    return null;
  })();

  /** A real Monos folder on disk, read the way the app does: the text, its hash, and the file's change time. */
  function diskFiles(root: string): TamperFiles {
    const at = (id: string, path: string) => join(root, id, path);
    const hash = (t: string) => createHash("sha256").update(t).digest("hex");
    return {
      read: async (id, path) => {
        const p = at(id, path);
        if (!existsSync(p)) return { text: null, hash: hash("") };
        const text = readFileSync(p, "utf8");
        return { text, hash: hash(text), modifiedMs: Math.floor(statSync(p).mtimeMs) };
      },
      write: async (id, path: AgentFilePath, text, expected) => {
        const p = at(id, path);
        const now = existsSync(p) ? readFileSync(p, "utf8") : "";
        if (expected !== undefined && hash(now) !== expected) throw new Error("conflict");
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, text);
        if (path === "SOUL.md") recordSavedSoul(id, text, hash(text));
        return hash(text);
      },
    };
  }
  const pyWrite = (file: string, text: string) =>
    execFileSync(python!, ["-c", "import sys; open(sys.argv[1], 'w').write(sys.argv[2])", file, text]);

  it.skipIf(!python)("during a worker's run is put back; with nothing running it is kept as Ash's", async () => {
    const root = mkdtempSync(join(tmpdir(), "soul-tamper-"));
    const f = diskFiles(root);
    setBotFiles(f);
    const soul = join(root, "hivra-lead", "SOUL.md");

    await f.write("hivra-lead", "SOUL.md", SAVED);
    noteSessionRuns([{ id: "app-hivra-chat-py", busy: true }]);
    pyWrite(soul, OUTSIDE);
    noteSessionRuns([{ id: "app-hivra-chat-py", busy: false }]);
    expect(await checkSoul("hivra-lead", "Hivra lead", f)).toBe("put-back");
    expect(readFileSync(soul, "utf8")).toBe(SAVED);
    const kept = (await f.read("hivra-lead", "SOUL.md")).modifiedMs;
    expect(kept).toBeTypeOf("number");

    // Later, with nothing running, the same kind of write is Ash's (the runs are long over: compare far from them).
    resetSessionRuns();
    pyWrite(soul, ASH);
    expect(await checkSoul("hivra-lead", "Hivra lead", f)).toBe("kept-ash");
    expect(readFileSync(soul, "utf8")).toBe(ASH);
  });

  // Mac round 2 (21 Oct): about 2 s after the send the window reloaded. The page marked the turn interrupted and its
  // record ended the run at its start, while the chat's Claude process ran on; a python3 write 6-26 s later was kept as
  // Ash's edit. The app process's record (harness_runs) follows the process itself, so the write is put back.
  it.skipIf(!python)(
    "30 s into a turn, after a window reload, a python3 write is put back with Keep that change",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "soul-tamper-reload-"));
      const f = diskFiles(root);
      setBotFiles(f);
      const soul = join(root, "frank", "SOUL.md");
      await f.write("frank", "SOUL.md", SAVED);

      const turnStart = Date.now() - 30_000;
      // The page sees frank's chat start its turn, then reloads 2 s in: the fresh page reads the stored runs (open
      // ones end where the old page last saw them) and the chat comes back idle ("Turn interrupted ... reloaded").
      noteSessionRuns([{ id: "frank-chat", busy: true, cwd: "/Users/ash" }], turnStart);
      reloadSessionRunsForTest();
      noteSessionRuns([{ id: "frank-chat", busy: false }], turnStart + 2_000);
      // The app process still has frank's Claude process, mid-turn (no result line yet).
      const alive: ProcessRun = { sessionId: "frank-chat", pid: 4242, cwd: "/Users/ash", start: turnStart - 500, turns: [{ start: turnStart }] };
      setProcessRunSource(async () => [alive]);

      // 30 s into the turn, a python3 script the turn runs writes frank's soul.
      pyWrite(soul, OUTSIDE);
      const changedAt = (await f.read("frank", "SOUL.md")).modifiedMs!;
      expect(changedAt - turnStart).toBeGreaterThanOrEqual(29_000);
      // By the page's record alone nothing was running then: that was the bug.
      expect(runsAt(changedAt).filter((r) => r.pid == null)).toEqual([]);

      expect(await checkSoul("frank", "frank", f)).toBe("put-back");
      expect(readFileSync(soul, "utf8")).toBe(SAVED);
      const row = botChangeRows()
        .flatMap((r) => (r.kind === "one" ? [r.change] : r.items))
        .find((c) => c.monoId === "frank")!;
      // It was frank's own chat turn, not a worker: the row says so (Mac round 2, 21 Oct).
      expect(row.line).toBe("Something outside the app changed frank's soul while frank's chat was running, so it was put back.");
      expect(row.line).toBe(putBackLine("frank", { chats: 1 }));
      expect(row.details![0]).toBe("When it changed, frank's chat was running.");
      expect(row.undoLabel).toBe("Keep that change");
      const note = join(root, "frank", changedSoulNote(changedAt));
      expect(readFileSync(note, "utf8")).toBe(OUTSIDE);
    },
  );

  it.skipIf(!python)(
    "the same write after the reload ended the process (it exited 2 s in) is Ash's: kept, with Undo",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "soul-tamper-reload-ended-"));
      const f = diskFiles(root);
      setBotFiles(f);
      const soul = join(root, "frank", "SOUL.md");
      await f.write("frank", "SOUL.md", SAVED);
      const turnStart = Date.now() - 30_000;
      noteSessionRuns([{ id: "frank-chat", busy: true }], turnStart);
      reloadSessionRunsForTest();
      noteSessionRuns([{ id: "frank-chat", busy: false }], turnStart + 2_000);
      setProcessRunSource(async () => [
        { sessionId: "frank-chat", pid: 4242, start: turnStart - 500, end: turnStart + 2_100, turns: [{ start: turnStart, end: turnStart + 2_100 }] },
      ]);
      pyWrite(soul, ASH);
      expect(await checkSoul("frank", "frank", f)).toBe("kept-ash");
      expect(readFileSync(soul, "utf8")).toBe(ASH);
    },
  );

  it("an idle chat process between turns doesn't count as running (Ash's edit is kept)", async () => {
    const { f, files } = memFiles();
    setBotFiles(f);
    await f.write("hivra-lead", "SOUL.md", SAVED);
    setProcessRunSource(async () => [{ sessionId: "lead-chat", pid: 7, start: 1_000, turns: [{ start: 2_000, end: 10_000 }] }]);
    files.set("hivra-lead/SOUL.md", { text: ASH, at: 60_000 });
    expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 5_000, 90_000), 90_000)).toBe("kept-ash");
  });
});

describe("whose run counts: only that Mono's own chats and workers, or one working in its home folder", () => {
  it("a run of the same Mono's chat, habit run or worker (however deep) counts; another Mono's doesn't", () => {
    expect(runIsMonos({ sessionId: "hivra-chat" }, "hivra-lead")).toBe(true);
    expect(runIsMonos({ sessionId: "habit-run-hivra" }, "hivra-lead")).toBe(true);
    expect(runIsMonos({ sessionId: "app-hivra-chat-r1" }, "hivra-lead")).toBe(true);
    expect(runIsMonos({ sessionId: "app-app-hivra-chat-r1-r2" }, "hivra-lead")).toBe(true);
    expect(runIsMonos({ sessionId: "exo-chat" }, "hivra-lead")).toBe(false);
    expect(runIsMonos({ sessionId: "app-exo-chat-r1", cwd: "/Users/ash/Projects/vg-game" }, "hivra-lead")).toBe(false);
    // The app's own helper processes and plain chats belong to no Mono.
    expect(runIsMonos({ sessionId: "monocode-claude-text-3" }, "hivra-lead")).toBe(false);
  });

  it("any run working inside that Mono's own home folder counts, whoever's it is (daily home, ~ form, a dev copy's)", () => {
    expect(runIsMonos({ sessionId: "exo-chat", cwd: "/Users/ash/agent-memory/monos/hivra-lead" }, "hivra-lead")).toBe(true);
    expect(runIsMonos({ sessionId: "plain", cwd: "/Users/ash/agent-memory/monos/hivra-lead/memory" }, "hivra-lead")).toBe(true);
    expect(runIsMonos({ sessionId: "plain", cwd: "~/agent-memory/monos/hivra-lead" }, "hivra-lead")).toBe(true);
    // Another Mono's home, or a name that only starts the same, is not this one's.
    expect(runIsMonos({ sessionId: "plain", cwd: "/Users/ash/agent-memory/monos/hivra-lead-2" }, "hivra-lead")).toBe(false);
    expect(runIsMonos({ sessionId: "plain", cwd: "/Users/ash/agent-memory/monos/frank" }, "hivra-lead")).toBe(false);
    setMonoHomeRoot("/Users/ash/Library/Application Support/com.ash.monocode-hub.dev.x/monos-home");
    expect(
      runIsMonos({ sessionId: "plain", cwd: "/Users/ash/Library/Application Support/com.ash.monocode-hub.dev.x/monos-home/hivra-lead" }, "hivra-lead"),
    ).toBe(true);
  });

  it("an edit while only another Mono's chat runs is Ash's: kept, with Undo", async () => {
    const { f, files, hash } = memFiles();
    setBotFiles(f);
    await f.write("hivra-lead", "SOUL.md", SAVED);
    noteSessionRuns([{ id: "exo-chat", busy: true, cwd: "/Users/ash/Projects/vg-game" }, { id: "app-cos-chat-r9", busy: true }], 1_000);
    files.set("hivra-lead/SOUL.md", { text: ASH, at: 2_000 });
    expect(runsAt(2_000, 0, 9_000).length).toBe(2);
    expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 0, 9_000), 9_000)).toBe("kept-ash");
    expect(files.get("hivra-lead/SOUL.md")!.text).toBe(ASH);
    const row = findBotChange(`soul-outside:hivra-lead:${hash(ASH)}`)!;
    expect(row.line).toBe(keptAshLine("Hivra lead"));
    expect(row.undoLabel).toBeUndefined();
    await undoBotChange([row.id]);
    expect(files.get("hivra-lead/SOUL.md")!.text).toBe(SAVED);
  });

  it("the same edit while that Mono's own worker runs is put back, with Keep that change", async () => {
    const { f, files, hash } = memFiles();
    setBotFiles(f);
    await f.write("hivra-lead", "SOUL.md", SAVED);
    noteSessionRuns([{ id: "exo-chat", busy: true }, { id: "app-hivra-chat-r7", busy: true, cwd: "/Users/ash/Projects/hivra" }], 1_000);
    files.set("hivra-lead/SOUL.md", { text: OUTSIDE, at: 2_000 });
    expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 0, 9_000), 9_000)).toBe("put-back");
    expect(files.get("hivra-lead/SOUL.md")!.text).toBe(SAVED);
    const row = findBotChange(`soul-put-back:hivra-lead:${hash(OUTSIDE)}`)!;
    expect(row.undoLabel).toBe("Keep that change");
    expect(row.details![0]).toBe("When it changed, a worker was running.");
  });

  it("another Mono's worker whose command named this soul is put back (S19 case C), and only that one", async () => {
    const texts: Record<string, RunToolCall[]> = {
      "app-exo-chat-r1": [{ kind: "execute", text: `python3 -c "open('/Users/ash/agent-memory/monos/hivra-lead/SOUL.md','a').write('x')"` }],
      "exo-chat": [{ kind: "execute", text: "npm test" }, { kind: "edit", text: "/Users/ash/Projects/vg-game/src/main.ts" }],
    };
    expect(runNamedSoul({ sessionId: "app-exo-chat-r1" }, "hivra-lead", (id) => texts[id] ?? [])).toBe(true);
    expect(runNamedSoul({ sessionId: "exo-chat" }, "hivra-lead", (id) => texts[id] ?? [])).toBe(false);
    // Built from parts, as a one-liner does with os.path.join.
    expect(runNamedSoul({ sessionId: "j" }, "hivra-lead", () => [{ kind: "execute", text: `p = os.path.join(home, "hivra-lead", "SOUL.md"); open(p, "a").write("x")` }])).toBe(true);
    expect(runNamedSoul({ sessionId: "j" }, "hivra-lead", () => [{ kind: "execute", text: `echo hi >> nibbii-lead/SOUL.md` }])).toBe(false);
    const { f, files } = memFiles();
    setBotFiles(f);
    await f.write("hivra-lead", "SOUL.md", SAVED);
    setRunToolTextSource((id) => texts[id] ?? []);
    try {
      noteSessionRuns([{ id: "app-exo-chat-r1", busy: true, cwd: "/Users/ash/Projects/vg-game" }], 1_000);
      files.set("hivra-lead/SOUL.md", { text: OUTSIDE, at: 2_000 });
      expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 0, 9_000), 9_000)).toBe("put-back");
      expect(files.get("hivra-lead/SOUL.md")!.text).toBe(SAVED);
    } finally {
      setRunToolTextSource(null);
    }
  });

  it("only a call that writes the soul counts; one that only reads it doesn't", () => {
    const soul = "/Users/ash/agent-memory/monos/hivra-lead/SOUL.md";
    const writes: RunToolCall[] = [
      { kind: "edit", text: soul },
      { kind: "execute", text: `echo "- new rule" >> ${soul}` },
      { kind: "execute", text: `printf x > '${soul}'` },
      { kind: "execute", text: `sed -i '' 's/a/b/' ${soul}` },
      { kind: "execute", text: `perl -pi -e 's/a/b/' ${soul}` },
      { kind: "execute", text: `echo x | tee -a ${soul}` },
      { kind: "execute", text: `cp /tmp/new.md ${soul}` },
      { kind: "execute", text: `mv ${soul} /tmp/old.md` },
      { kind: "execute", text: `python3 -c "open('${soul}', 'w').write('x')"` },
      { kind: "execute", text: `python3 -c "import pathlib; pathlib.Path('${soul}').write_text('x')"` },
      { kind: "execute", text: `node -e "require('fs').appendFileSync('${soul}', 'x')"` },
    ];
    const reads: RunToolCall[] = [
      { kind: "read", text: soul },
      { kind: "search", text: `rg Standing ${soul}` },
      { kind: "execute", text: `cat ${soul}` },
      { kind: "execute", text: `head -20 ${soul} > /tmp/soul-head.txt` },
      { kind: "execute", text: `rg -n "Standing" ${soul} 2>&1` },
      { kind: "execute", text: `cp ${soul} /tmp/backup.md` },
      { kind: "execute", text: `python3 -c "print(open('${soul}').read())"` },
      { kind: "execute", text: `wc -l ${soul} && diff ${soul} /tmp/x.md` },
    ];
    for (const call of writes) expect(callWritesSoul(call), call.text).toBe(true);
    for (const call of reads) expect(callWritesSoul(call), call.text).toBe(false);
  });

  it("a shell call's command counts after it finishes (its detail is then its output), from when it was pending", async () => {
    resetToolCallsForTest();
    const soul = "/Users/ash/agent-memory/monos/hivra-lead/SOUL.md";
    const pending = { tool: { callId: "t1", kind: "execute", title: "python3 -c …", detail: `Bash: python3 -c "open('${soul}','a').write('x')"` } };
    noteToolCalls([{ id: "app-exo-chat-r4", busy: true, blocks: [pending] }]);
    const done = { tool: { callId: "t1", kind: "execute", title: "python3 -c …", detail: "" } };
    noteToolCalls([{ id: "app-exo-chat-r4", busy: true, blocks: [done] }]);
    expect(runNamedSoul({ sessionId: "app-exo-chat-r4" }, "hivra-lead")).toBe(true);
    // An idle chat's blocks aren't scanned, and another session's calls are its own.
    noteToolCalls([{ id: "idle", busy: false, blocks: [pending] }]);
    expect(runNamedSoul({ sessionId: "idle" }, "hivra-lead")).toBe(false);
    resetToolCallsForTest();
  });

  it("Ash's edit while another Mono's chat only reads that soul is kept", async () => {
    const { f, files } = memFiles();
    setBotFiles(f);
    await f.write("hivra-lead", "SOUL.md", SAVED);
    setRunToolTextSource((id) => (id === "app-exo-chat-r2" ? [{ kind: "execute", text: "cat /Users/ash/agent-memory/monos/hivra-lead/SOUL.md" }] : []));
    try {
      noteSessionRuns([{ id: "app-exo-chat-r2", busy: true, cwd: "/Users/ash/Projects/vg-game" }], 1_000);
      files.set("hivra-lead/SOUL.md", { text: ASH, at: 2_000 });
      expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 0, 9_000), 9_000)).toBe("kept-ash");
      expect(files.get("hivra-lead/SOUL.md")!.text).toBe(ASH);
    } finally {
      setRunToolTextSource(null);
    }
  });

  it("a chat that wrote the soul in an earlier turn and only reads it now doesn't undo Ash's edit (Mac, 21 Oct)", async () => {
    const { f, files } = memFiles();
    setBotFiles(f);
    await f.write("hivra-lead", "SOUL.md", SAVED);
    const soul = "/Users/ash/agent-memory/monos/hivra-lead/SOUL.md";
    const write: RunToolCall = { kind: "execute", text: `python3 -c "open('${soul}','a').write('x')"`, at: 1_000 };
    const read: RunToolCall = { kind: "execute", text: `cat '${soul}' | wc -l; sleep 45`, at: 200_000 };
    let calls: RunToolCall[] = [write];
    setRunToolTextSource((id) => (id === "app-exo-chat-r5" ? calls : []));
    resetToolCallsForTest();
    try {
      // Turn 1 wrote it; that change was dealt with then (saved again here).
      noteSessionRuns([{ id: "app-exo-chat-r5", busy: true, cwd: "/Users/ash" }], 1_000);
      noteSessionRuns([{ id: "app-exo-chat-r5", busy: false }], 3_000);
      // Turn 2 only reads it, and Ash edits the soul by hand while it runs.
      calls = [write, read];
      noteSessionRuns([{ id: "app-exo-chat-r5", busy: true, cwd: "/Users/ash" }], 200_000);
      files.set("hivra-lead/SOUL.md", { text: ASH, at: 210_000 });
      expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 0, 220_000), 220_000)).toBe("kept-ash");
      expect(files.get("hivra-lead/SOUL.md")!.text).toBe(ASH);
      // The same chat writing it again in this turn is put back.
      calls = [write, read, { ...write, at: 200_000 }];
      files.set("hivra-lead/SOUL.md", { text: OUTSIDE, at: 215_000 });
      expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 0, 220_000), 220_100)).toBe("put-back");
    } finally {
      setRunToolTextSource(null);
    }
  });

  it("a pending call seen in an earlier turn doesn't count for a later one", () => {
    resetToolCallsForTest();
    const soul = "/Users/ash/agent-memory/monos/hivra-lead/SOUL.md";
    const pending = { tool: { callId: "t9", kind: "execute", title: "python3", detail: `python3 -c "open('${soul}','a').write('x')"` } };
    noteToolCalls([{ id: "app-exo-chat-r6", busy: true, blocks: [pending] }], 1_000);
    expect(runNamedSoul({ sessionId: "app-exo-chat-r6", start: 900 }, "hivra-lead")).toBe(true);
    expect(runNamedSoul({ sessionId: "app-exo-chat-r6", start: 200_000 }, "hivra-lead")).toBe(false);
    resetToolCallsForTest();
  });

  it("another Mono's process working in this Mono's home folder (app process record) is put back", async () => {
    const { f, files } = memFiles();
    setBotFiles(f);
    await f.write("hivra-lead", "SOUL.md", SAVED);
    setProcessRunSource(async () => [
      { sessionId: "app-exo-chat-r3", pid: 9, cwd: "/Users/ash/agent-memory/monos/hivra-lead", start: 500, turns: [{ start: 1_000 }] },
    ]);
    files.set("hivra-lead/SOUL.md", { text: OUTSIDE, at: 2_000 });
    expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 0, 9_000), 9_000)).toBe("put-back");
  });
});

describe("the put-back row names what was running, by each run's own kind", () => {
  it("counts this Mono's chat, a worker, a habit run and another chat in its folder apart", () => {
    expect(runningKinds([{ sessionId: "hivra-chat" }], "hivra-lead")).toEqual({ chats: 1, otherChats: 0, workers: 0, habits: 0, others: [] });
    expect(runningKinds([{ sessionId: "app-hivra-chat-r1" }, { sessionId: "app-app-hivra-chat-r1-r2" }], "hivra-lead")).toEqual({ chats: 0, otherChats: 0, workers: 2, habits: 0, others: [] });
    expect(runningKinds([{ sessionId: "habit-run-hivra" }], "hivra-lead")).toEqual({ chats: 0, otherChats: 0, workers: 0, habits: 1, others: [] });
    expect(runningKinds([{ sessionId: "exo-chat" }, { sessionId: "plain-chat" }], "hivra-lead")).toEqual({ chats: 0, otherChats: 2, workers: 0, habits: 0, others: ["vg-game-lead's chat", "a chat"] });
  });

  it("reads as a sentence for each mix", () => {
    expect(putBackLine("Hivra lead", { chats: 1 })).toBe("Something outside the app changed Hivra lead's soul while Hivra lead's chat was running, so it was put back.");
    expect(putBackLine("Hivra lead", { habits: 1 })).toBe("Something outside the app changed Hivra lead's soul while one of Hivra lead's habits was running, so it was put back.");
    expect(putBackLine("Hivra lead", { otherChats: 1 })).toBe("Something outside the app changed Hivra lead's soul while another chat was running, so it was put back.");
    expect(putBackLine("Nibbii lead", { otherChats: 1, others: ["Alfred's chat in ~"] })).toBe("Something outside the app changed Nibbii lead's soul while Alfred's chat in ~ was running, so it was put back.");
    expect(putBackLine("Hivra lead", { chats: 1, workers: 2 })).toBe("Something outside the app changed Hivra lead's soul while Hivra lead's chat and 2 workers were running, so it was put back.");
    expect(putBackLine("Hivra lead", { workers: 1 })).toBe("Something outside the app changed Hivra lead's soul while a worker was running, so it was put back.");
  });

  it("another Mono's chat that wrote the soul is named for whose it is and where it worked, not as one in this Mono's folder (S19 case C)", async () => {
    expect(otherChatName({ sessionId: "alfred-chat", cwd: "/Users/ash" }, (id) => (id === "alfred" ? "Alfred" : undefined))).toBe("Alfred's chat in ~");
    expect(otherChatName({ sessionId: "plain-chat", cwd: "/Users/ash/code/exo" })).toBe("a chat in ~/code/exo");
    const texts: Record<string, RunToolCall[]> = { "alfred-chat": [{ kind: "edit", text: "/Users/ash/agent-memory/monos/nibbii-lead/SOUL.md" }] };
    const { f, files } = memFiles();
    setBotFiles(f);
    await f.write("nibbii-lead", "SOUL.md", SAVED);
    setRunToolTextSource((id) => texts[id] ?? []);
    try {
      noteSessionRuns([{ id: "alfred-chat", busy: true, cwd: "/Users/ash" }], 1_000);
      files.set("nibbii-lead/SOUL.md", { text: OUTSIDE, at: 2_000 });
      expect(await checkSoul("nibbii-lead", "Nibbii lead", f, (at) => runsAt(at, 0, 9_000), 9_000)).toBe("put-back");
      const row = botChangeRows()
        .flatMap((r) => (r.kind === "one" ? [r.change] : r.items))
        .find((c) => c.monoId === "nibbii-lead")!;
      expect(row.line).toMatch(/while (Alfred|alfred)'s chat in ~ was running/);
      expect(row.line).not.toContain("folder");
    } finally {
      setRunToolTextSource(null);
    }
  });

  it("a change during the Mono's own chat turn says chat, not worker", async () => {
    const { f, files, hash } = memFiles();
    setBotFiles(f);
    await f.write("hivra-lead", "SOUL.md", SAVED);
    noteSessionRuns([{ id: "hivra-chat", busy: true, cwd: "/Users/ash" }], 1_000);
    files.set("hivra-lead/SOUL.md", { text: OUTSIDE, at: 2_000 });
    expect(await checkSoul("hivra-lead", "Hivra lead", f, (at) => runsAt(at, 0, 9_000), 9_000)).toBe("put-back");
    const row = findBotChange(`soul-put-back:hivra-lead:${hash(OUTSIDE)}`)!;
    expect(row.line).toBe("Something outside the app changed Hivra lead's soul while Hivra lead's chat was running, so it was put back.");
    expect(row.line).not.toContain("worker");
    expect(row.details![0]).toBe("When it changed, Hivra lead's chat was running.");
  });
});
