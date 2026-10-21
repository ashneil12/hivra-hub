// @vitest-environment happy-dom
// The soul tamper check: the app keeps the hash of every soul it saves; a soul file that no longer matches was changed
// outside the app. Changed while a chat was running: put back, with the changed file kept and "Keep that change".
// Changed with nothing running: Ash's own edit, kept. Last, a real python process writes the file, as a worker's script
// could (it isn't held back by the Edit deny), to show the check rests on the file alone.
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
import { changedSoulNote, checkSoul, keptAshLine, putBackLine, recordRestoredSouls, runIsMonos, type TamperFiles } from "./soulTamper";

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
      expect(row.line).toBe(putBackLine("frank"));
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
    expect(row.details![0]).toBe("One of Hivra lead's chats or workers was running when it changed.");
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
