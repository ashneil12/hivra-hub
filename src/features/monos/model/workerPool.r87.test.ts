// @vitest-environment happy-dom
// r87 step 2, Ash 30 Oct 06:59: "prevent parallel jobs from overlapping on the same files at start (hold the second
// job, or fold it into the first), so clashes are prevented, not just settled". c02 r86 run 3: the shared-type job and
// the last-week job both changed packages/ui/src/App.tsx at once.
import { beforeEach, describe, expect, it } from "vitest";
import type { Delegation } from "./delegations";
import {
  admitWorker,
  declareFiles,
  filesNamed,
  forgetFiles,
  nextWorkers,
  queuedLine,
  resetWorkerPool,
  sameFiles,
  type ProviderRoom,
  type QueuedWorker,
} from "./workerPool";

const room = (): ProviderRoom => ({ room: true });
const row = (child: string, title: string, state: Delegation["state"] = "running") =>
  ({ childSession: child, project: "tally", state, follow: null, title }) as Pick<
    Delegation,
    "project" | "state" | "childSession" | "follow" | "title"
  >;
const job = (id: string, files?: string[]): QueuedWorker => ({
  id,
  ownerSession: "lead",
  requestId: id,
  project: "tally",
  projectName: "Tally",
  title: `Job ${id}`,
  heavy: false,
  harness: "claude",
  queuedAt: 0,
  input: { brief: id },
  ...(files ? { files } : {}),
});

beforeEach(() => {
  resetWorkerPool();
  forgetFiles();
});

describe("two jobs on the same files (r87)", () => {
  it("holds a job whose files a running job in the project changes, and says which", () => {
    declareFiles("app-ui", ["packages/ui/src/App.tsx"]);
    const admission = admitWorker(job("app-week", ["packages/ui/src/App.tsx"]), {
      rows: [row("app-ui", "UI uses shared tally type")],
      room,
    });
    expect(admission.start).toBe(false);
    if (!admission.start) {
      expect(admission.reason).toBe("files");
      expect(admission.line).toContain('"UI uses shared tally type"');
      expect(admission.line).toContain("packages/ui/src/App.tsx");
    }
  });

  it("a folder counts as the files in it, and a leading ./ doesn't matter", () => {
    expect(sameFiles("./packages/ui/", "packages/ui/src/App.tsx")).toBe(true);
    expect(sameFiles("packages/ui", "packages/api/src/server.ts")).toBe(false);
    expect(sameFiles("README.md", "README.md")).toBe(true);
  });

  it("starts at once when the files differ, the other job is done, or another project's", () => {
    declareFiles("app-api", ["packages/api/src/server.ts"]);
    const rows = [row("app-api", "GET /health")];
    expect(admitWorker(job("app-docs", ["README.md"]), { rows, room }).start).toBe(true);
    expect(admitWorker(job("app-api2", ["packages/api/src/server.ts"]), { rows: [row("app-api", "x", "done")], room }).start).toBe(true);
    expect(admitWorker({ ...job("app-o", ["packages/api/src/server.ts"]), project: "other" }, { rows, room }).start).toBe(true);
    // Nothing known about the new job's files: as before, it starts.
    expect(admitWorker(job("app-n"), { rows, room }).start).toBe(true);
  });

  it("the held job starts by itself once the job it waited on has landed", () => {
    declareFiles("app-ui", ["packages/ui/src/App.tsx"]);
    const waiting = job("app-week", ["packages/ui/src/App.tsx"]);
    const ctx = (state: Delegation["state"]) => ({ rows: [row("app-ui", "UI type", state)], room, queue: [waiting] });
    expect(nextWorkers(ctx("running"))).toEqual([]);
    expect(queuedLine(waiting, ctx("running"))).toContain("to land");
    expect(nextWorkers(ctx("done")).map((q) => q.id)).toEqual(["app-week"]);
  });

  it("of two waiting jobs on one file, only the first starts", () => {
    const a = job("app-a", ["packages/ui/src/App.tsx"]);
    const b = job("app-b", ["packages/ui/src/App.tsx"]);
    const c = job("app-c", ["README.md"]);
    expect(nextWorkers({ rows: [], room, queue: [a, b, c] }).map((q) => q.id)).toEqual(["app-a", "app-c"]);
  });

  it("finds the files a brief names, not the ones it says to leave alone", () => {
    const brief =
      "Show last week's total in packages/ui/src/App.tsx next to this week. Do not touch README.md. " +
      "See https://example.com/x.html for the style; version 1.2.3.\n<worker_rules> - Never edit TODO.md</worker_rules>";
    expect(filesNamed(brief)).toEqual(["packages/ui/src/App.tsx"]);
    expect(filesNamed("UI only. Delete the local tally type copy.")).toEqual([]);
  });
});
