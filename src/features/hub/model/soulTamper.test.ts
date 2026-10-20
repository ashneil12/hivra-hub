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
import { noteSessionRuns, resetSessionRuns, runsAt } from "../../monos/model/sessionRuns";
import { recordSavedSoul, savedSoul } from "../../monos/model/soulSaved";
import { findBotChange, redoBotChange, setBotFiles, undoBotChange, undoneLine } from "./botChanges";
import { changedSoulNote, checkSoul, keptAshLine, putBackLine, type TamperFiles } from "./soulTamper";

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

beforeEach(() => {
  localStorage.clear();
  resetSessionRuns();
});

describe("a soul changed outside the app", () => {
  it("while a worker was running: the saved soul is put back, the change kept beside it, and Keep that change restores it", async () => {
    const { f, files, hash } = memFiles();
    setBotFiles(f);
    await f.write("hivra-lead", "SOUL.md", SAVED);
    noteSessionRuns([{ id: "worker-1", busy: true, cwd: "/Users/ash/Projects/hivra" }], 1_000);
    files.set("hivra-lead/SOUL.md", { text: OUTSIDE, at: 2_000 });
    noteSessionRuns([{ id: "worker-1", busy: false }], 3_000);

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
    noteSessionRuns([{ id: "worker-1", busy: true }], 1_000);
    noteSessionRuns([{ id: "worker-1", busy: false }], 2_000);
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
    noteSessionRuns([{ id: "worker-py", busy: true }]);
    pyWrite(soul, OUTSIDE);
    noteSessionRuns([{ id: "worker-py", busy: false }]);
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
});
