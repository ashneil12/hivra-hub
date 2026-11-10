import { describe, expect, it } from "vitest";
import {
  arrangeGuide,
  buildGuidePrompt,
  commentsFromThread,
  commitStoredGuide,
  guideFilesFromDiff,
  guideFreshness,
  guideWriteSentence,
  headFromThread,
  isMechanicalFile,
  parseStored,
  readReviewGuide,
  reviewGuideKey,
  writeReviewGuide,
  type GuideFile,
  type GuideStore,
  type ReviewGuide,
} from "./reviewGuide";

const HEAD = "abc1234";
const NEXT = "bbbbbbb";

const source: GuideFile = {
  path: "src/app.ts",
  previousPath: null,
  status: "modified",
  additions: 2,
  deletions: 0,
  changedLines: [
    { line: 10, text: "const next = 1;" },
    { line: 11, text: "return next;" },
  ],
};

const lockfile: GuideFile = {
  path: "package-lock.json",
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 0,
  changedLines: [{ line: 3, text: "lock" }],
};

const renamed: GuideFile = {
  path: "src/next.ts",
  previousPath: "src/old.ts",
  status: "renamed",
  additions: 0,
  deletions: 0,
  changedLines: [],
};

const files = [source, lockfile, renamed];

function memory(): GuideStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    read: (key) => raw.get(key) ?? null,
    write: (key, value) => {
      raw.set(key, value);
    },
  };
}

function reply(stops: unknown): string {
  return `Sure.\n${JSON.stringify({ stops })}`;
}

describe("review guide shape", () => {
  it("treats renames, snapshots, and lockfiles as mechanical", () => {
    expect(isMechanicalFile("src/next.ts", "renamed")).toBe(true);
    expect(isMechanicalFile("src/__snapshots__/app.snap", "modified")).toBe(true);
    expect(isMechanicalFile("package-lock.json", "modified")).toBe(true);
    expect(isMechanicalFile("src/app.ts", "modified")).toBe(false);
    expect(isMechanicalFile("src\\app.ts", "modified")).toBe(false);
  });

  it("rejects a key that is not one repository and a number", () => {
    expect(reviewGuideKey("acme/widgets", 7)).toBe(
      "monocode.reviewGuide:acme/widgets#7",
    );
    expect(reviewGuideKey("acme/../widgets", 7)).toBeNull();
    expect(reviewGuideKey("acme\\widgets", 7)).toBeNull();
    expect(reviewGuideKey("acme/widgets name", 7)).toBeNull();
    expect(reviewGuideKey("acme/widgets", 0)).toBeNull();
    expect(reviewGuideKey("acme/widgets", 1.5)).toBeNull();
  });

  it("uses the newest dated commit and ignores a thread with no date", () => {
    expect(
      headFromThread({
        commits: [
          { oid: "aaaaaaa", committedDate: "2026-01-01T00:00:00Z" },
          { oid: NEXT, committedDate: "2026-02-01T00:00:00Z" },
          { oid: "ccccccc", committedDate: "not a date" },
        ],
      }),
    ).toBe(NEXT);
    expect(headFromThread({ commits: [{ oid: HEAD }] })).toBe("");
    expect(headFromThread(null)).toBe("");
  });

  it("leaves resolved comments, and replies under them, out", () => {
    const comments = commentsFromThread({
      comments: [
        {
          path: "src/app.ts",
          line: 4,
          body: "please check this",
          resolved: false,
          replies: [
            {
              path: "src/app.ts",
              line: 4,
              body: "still open",
              resolved: false,
            },
          ],
        },
        {
          path: "src/app.ts",
          line: 2,
          body: "already settled secret phrase",
          resolved: true,
          replies: [
            {
              path: "src/app.ts",
              line: 2,
              body: "resolved reply secret",
              resolved: false,
            },
          ],
        },
      ],
    });
    expect(comments.map((comment) => comment.body)).toEqual([
      "please check this",
      "still open",
    ]);
    const prompt = buildGuidePrompt({ head: HEAD, files, comments });
    expect(prompt).toContain("please check this");
    expect(prompt).not.toContain("already settled secret phrase");
    expect(prompt).not.toContain("resolved reply secret");
    expect(prompt).toContain(HEAD);
    expect(prompt).toContain("cover this pull request only");
  });

  it("puts mechanical files last and keeps every file", () => {
    const guide = arrangeGuide(
      HEAD,
      files,
      [
        {
          path: "package-lock.json",
          startLine: 3,
          endLine: 3,
          note: "Lockfile churn.",
          lookClosely: false,
        },
        {
          path: "src/app.ts",
          startLine: 10,
          endLine: 11,
          note: "The return value changed.",
          lookClosely: "Look closely",
        },
        {
          path: "src/app.ts",
          note: "Duplicate.",
          lookClosely: false,
        },
        {
          path: "C:\\missing.ts",
          note: "Not in the diff.",
          lookClosely: "Important",
        },
      ],
    );
    expect(guide?.stops.map((stop) => stop.path)).toEqual([
      "src/app.ts",
      "package-lock.json",
      "src/next.ts",
    ]);
    expect(guide?.stops[0]).toMatchObject({
      note: "The return value changed.",
      lookClosely: true,
      startLine: 10,
      endLine: 11,
    });
    expect(guide?.stops[2]?.note).toBe("Changed in this pull request.");
    expect(guide?.stops[2]?.lookClosely).toBe(false);
  });

  it("fills a line range from the diff when the model omits one", () => {
    const guide = arrangeGuide(HEAD, [source], [
      { path: "src/app.ts", note: "See the return.", lookClosely: false },
    ]);
    expect(guide?.stops[0]).toMatchObject({ startLine: 10, endLine: 11 });
  });

  it("rejects a reply that is not a guide", () => {
    expect(arrangeGuide(HEAD, files, "nope")).toBeNull();
    expect(arrangeGuide("", files, [])).toBeNull();
    expect(arrangeGuide(HEAD, [], [])).toBeNull();
  });

  it("reads files from the diff already loaded, including one with no patch", () => {
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -9,0 +10,2 @@",
      "+const next = 1;",
      "+return next;",
      "",
    ].join("\n");
    const loaded = guideFilesFromDiff({
      files: [
        { path: "src/app.ts", additions: 2, deletions: 0 },
        { path: "README.md", additions: 1, deletions: 0 },
      ],
      patch: patch.replace(/\n/g, "\r\n"),
    });
    expect(loaded.map((file) => file.path)).toEqual(["src/app.ts", "README.md"]);
    expect(loaded[0]?.changedLines.map((line) => line.line)).toEqual([10, 11]);
  });
});

describe("review guide store", () => {
  const key = "monocode.reviewGuide:acme/widgets#7";

  function seed(store: GuideStore, guide: ReviewGuide, revision = 1, token = "kept") {
    store.write(
      key,
      JSON.stringify({ revision, token, head: guide.head, guide }),
    );
  }

  it("drops a late write and a write for a head that moved", () => {
    const store = memory();
    const first = arrangeGuide(HEAD, files, [])!;
    expect(
      commitStoredGuide(store, key, {
        expectedRevision: 0,
        basedOnHead: HEAD,
        currentHead: HEAD,
        guide: first,
        token: "first",
      }),
    ).toEqual({ ok: true, revision: 1 });
    const late = arrangeGuide(HEAD, files, [])!;
    expect(
      commitStoredGuide(store, key, {
        expectedRevision: 0,
        basedOnHead: HEAD,
        currentHead: HEAD,
        guide: late,
        token: "late",
      }),
    ).toEqual({ ok: false, reason: "dropped" });
    expect(readReviewGuide(store, key)?.token).toBe("first");
    const moved = arrangeGuide(HEAD, files, [])!;
    expect(
      commitStoredGuide(store, key, {
        expectedRevision: 1,
        basedOnHead: HEAD,
        currentHead: NEXT,
        guide: moved,
        token: "moved",
      }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(readReviewGuide(store, key)?.head).toBe(HEAD);
  });

  it("drops the write when another one lands before the check", () => {
    const store = memory();
    const guide = arrangeGuide(HEAD, files, [])!;
    const racing: GuideStore = {
      read: (id) => store.read(id),
      write: (id, value) => {
        store.write(id, value);
        const written = JSON.parse(value) as { revision: number; head: string; guide: ReviewGuide };
        store.write(
          id,
          JSON.stringify({ ...written, token: "other" }),
        );
      },
    };
    expect(
      commitStoredGuide(racing, key, {
        expectedRevision: 0,
        basedOnHead: HEAD,
        currentHead: HEAD,
        guide,
        token: "mine",
      }).ok,
    ).toBe(false);
    expect(readReviewGuide(store, key)?.token).toBe("other");
  });

  it("ignores a corrupt record", () => {
    const store = memory();
    store.write(key, "{not json");
    expect(parseStored(store.read(key))).toBeNull();
    expect(readReviewGuide(store, key)).toBeNull();
    expect(guideFreshness(null, HEAD)).toBe("none");
  });

  it("marks a stored guide stale when the head changes, and hides it as current", () => {
    const guide = arrangeGuide(HEAD, files, [])!;
    const record = { revision: 1, token: "kept", head: HEAD, guide };
    expect(guideFreshness(record, HEAD)).toBe("current");
    expect(guideFreshness(record, NEXT)).toBe("stale");
    expect(guideFreshness(record, "")).toBe("stale");
  });

  it("keeps the previous guide when the model does not answer", async () => {
    const store = memory();
    const previous = arrangeGuide(HEAD, files, [])!;
    seed(store, previous);
    const hung = writeReviewGuide({
      store,
      key,
      head: HEAD,
      files,
      comments: [],
      ask: () => new Promise(() => {}),
      timeoutMs: 20,
      token: "late",
      queue: false,
    });
    await expect(hung).resolves.toEqual({ ok: false, reason: "failed" });
    expect(readReviewGuide(store, key)?.token).toBe("kept");

    const thrown = await writeReviewGuide({
      store,
      key,
      head: HEAD,
      files,
      comments: [],
      ask: () => Promise.reject(new Error("down")),
      timeoutMs: 1000,
      token: "thrown",
      queue: false,
    });
    expect(thrown).toEqual({ ok: false, reason: "failed" });
    expect(readReviewGuide(store, key)?.guide.stops).toEqual(previous.stops);

    const blank = await writeReviewGuide({
      store,
      key,
      head: HEAD,
      files,
      comments: [],
      ask: () => Promise.resolve("   "),
      timeoutMs: 1000,
      queue: false,
    });
    expect(blank).toEqual({ ok: false, reason: "failed" });
    expect(readReviewGuide(store, key)?.token).toBe("kept");
  });

  it("drops a result that finishes after a newer guide was stored", async () => {
    const store = memory();
    let release: (value: string) => void = () => {};
    const pending = writeReviewGuide({
      store,
      key,
      head: HEAD,
      files,
      comments: [],
      ask: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      timeoutMs: 1000,
      token: "slow",
      queue: false,
    });
    const newer = arrangeGuide(HEAD, [source], [
      { path: "src/app.ts", note: "Newer note.", lookClosely: false },
    ])!;
    expect(
      commitStoredGuide(store, key, {
        expectedRevision: 0,
        basedOnHead: HEAD,
        currentHead: HEAD,
        guide: newer,
        token: "newer",
      }).ok,
    ).toBe(true);
    release(reply([{ path: "src/app.ts", note: "Old note.", lookClosely: false }]));
    await expect(pending).resolves.toEqual({ ok: false, reason: "dropped" });
    expect(readReviewGuide(store, key)?.guide.stops[0]?.note).toBe("Newer note.");
  });

  it("drops a result when the head changes while the model is writing", async () => {
    const store = memory();
    let head = HEAD;
    let release: (value: string) => void = () => {};
    const pending = writeReviewGuide({
      store,
      key,
      head: HEAD,
      files,
      comments: [],
      ask: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      timeoutMs: 1000,
      currentHead: () => head,
      token: "slow",
      queue: false,
    });
    head = NEXT;
    release(reply([]));
    await expect(pending).resolves.toEqual({ ok: false, reason: "stale" });
    expect(readReviewGuide(store, key)).toBeNull();
  });

  it("does not call the writer when it cannot run", async () => {
    const store = memory();
    let calls = 0;
    const ask = () => {
      calls += 1;
      return Promise.resolve(reply([]));
    };
    expect(
      await writeReviewGuide({
        store,
        key,
        head: "",
        files,
        comments: [],
        ask,
        timeoutMs: 1000,
        queue: false,
      }),
    ).toEqual({ ok: false, reason: "no-head" });
    expect(
      await writeReviewGuide({
        store,
        key,
        head: HEAD,
        files: [],
        comments: [],
        ask,
        timeoutMs: 1000,
        queue: false,
      }),
    ).toEqual({ ok: false, reason: "empty" });
    expect(
      await writeReviewGuide({
        store,
        key,
        head: HEAD,
        files,
        comments: [],
        ask: null,
        timeoutMs: 1000,
        queue: false,
      }),
    ).toEqual({ ok: false, reason: "unavailable" });
    expect(
      await writeReviewGuide({
        store,
        key,
        head: HEAD,
        files,
        comments: [],
        ask,
        timeoutMs: 0,
        queue: false,
      }),
    ).toEqual({ ok: false, reason: "failed" });
    expect(calls).toBe(0);
    expect(readReviewGuide(store, key)).toBeNull();
    expect(guideWriteSentence("unavailable")).toBe(
      "The guide writer is not available.",
    );
    expect(guideWriteSentence("failed")).toBe("The guide could not be written.");
    expect(guideWriteSentence("stale")).toBe("This guide is out of date.");
  });

  it("stores a guide that covers every file when the model answers", async () => {
    const store = memory();
    const result = await writeReviewGuide({
      store,
      key,
      head: HEAD,
      files,
      comments: [],
      ask: () =>
        Promise.resolve(
          reply([
            {
              path: "src/app.ts",
              startLine: 10,
              endLine: 11,
              note: "The return value changed.",
              lookClosely: true,
            },
          ]),
        ),
      timeoutMs: 1000,
      token: "done",
      queue: false,
    });
    expect(result.ok).toBe(true);
    expect(readReviewGuide(store, key)?.guide.stops.map((stop) => stop.path)).toEqual([
      "src/app.ts",
      "package-lock.json",
      "src/next.ts",
    ]);
  });
});
