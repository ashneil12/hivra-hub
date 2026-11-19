import { expect, it } from "vitest";
import {
  DRAFT_NOTES,
  allowedLicence,
  emptyDrafts,
  parseDraftDocument,
  planDrafts,
  saveDrafts,
  type DraftIo,
} from "./drafts";
import { CHANGES_RELATIVE, type RepoPin } from "./pins";
import { runRepoWatchHabit } from "./run";
import { emptyFetch, type PinReport } from "./watch";

const planted = `ghp_${"a".repeat(36)}`;
const now = Date.parse("2026-11-09T09:00:00Z");

function pin(over: Partial<RepoPin> = {}): RepoPin {
  return {
    url: "https://github.com/acme/web",
    licence: "MIT",
    pinSha: "abc1234",
    notes: "",
    ...over,
  };
}

function report(over: Partial<PinReport> = {}): PinReport {
  return {
    url: "https://github.com/acme/web",
    label: "acme/web",
    status: "changed",
    detail: "2 commits on main since abc1234.",
    aheadBy: 2,
    commits: ["abcdef1 Open the door"],
    release: "",
    ...over,
  };
}

function memoryDrafts(initial: string | null = null): DraftIo & {
  text: () => string | null;
  reads: () => number;
  writes: () => number;
} {
  let text = initial;
  let reads = 0;
  let writes = 0;
  return {
    text: () => text,
    reads: () => reads,
    writes: () => writes,
    async read() {
      reads += 1;
      return { text };
    },
    async write(_root, body, expected) {
      writes += 1;
      const current = parseDraftDocument(text);
      if (current.revision !== expected) return false;
      const next = parseDraftDocument(body);
      if (next.revision !== expected + 1) return false;
      text = body;
      return true;
    },
  };
}

it("accepts only MIT, Apache-2.0 and MPL-2.0", () => {
  expect(allowedLicence("MIT")).toBe("MIT");
  expect(allowedLicence(" Apache-2.0 ")).toBe("Apache-2.0");
  expect(allowedLicence("Apache 2.0")).toBe("Apache-2.0");
  expect(allowedLicence("MPL-2.0")).toBe("MPL-2.0");
  expect(allowedLicence("MPL 2.0")).toBe("MPL-2.0");
  expect(allowedLicence("AGPL-3.0")).toBeNull();
  expect(allowedLicence("GPL-2.0")).toBeNull();
  expect(allowedLicence("")).toBeNull();
  expect(allowedLicence("Unknown")).toBeNull();
  expect(allowedLicence("MIT License")).toBeNull();
});

it("queues one draft for a clear win and ignores the rest", () => {
  const ahead = planDrafts([pin()], [report()], emptyDrafts(), now);
  expect(ahead.changed).toBe(true);
  expect(ahead.document.drafts).toHaveLength(1);
  const row = ahead.document.drafts[0];
  expect(row).toMatchObject({
    id: "repo-watch:acme/web:abc1234:commits",
    wp: "WP-166",
    title: "Upgrade acme/web",
    briefPath: CHANGES_RELATIVE,
    branch: "upgrade-acme-web",
    status: "queued",
    securityPark: false,
    priority: 50,
    notes: DRAFT_NOTES,
    createdAt: now,
  });
  expect(row?.branch.includes("/")).toBe(false);
  expect(row?.briefPath.startsWith(".hivra/")).toBe(true);

  const again = planDrafts([pin()], [report()], ahead.document, now);
  expect(again.document.drafts).toHaveLength(1);
  expect(again.changed).toBe(false);

  for (const licence of ["AGPL-3.0", "GPL-2.0", "", "Unknown"]) {
    const skipped = planDrafts([pin({ licence })], [report()], emptyDrafts(), now);
    expect(skipped.document.drafts).toEqual([]);
    expect(skipped.changed).toBe(false);
  }
  expect(planDrafts([pin({ pinSha: "" })], [report()], emptyDrafts(), now).document.drafts).toEqual([]);
  expect(
    planDrafts([pin()], [report({ status: "unchecked", aheadBy: 0, commits: [] })], emptyDrafts(), now).document
      .drafts,
  ).toEqual([]);
  expect(planDrafts([pin({ licence: "Apache 2.0" })], [report()], emptyDrafts(), now).document.drafts).toHaveLength(1);
  expect(planDrafts([pin({ licence: "MPL 2.0" })], [report()], emptyDrafts(), now).document.drafts).toHaveLength(1);
});

it("treats a new release tag as a win only after one has been seen", () => {
  const first = planDrafts(
    [pin()],
    [report({ status: "unchanged", aheadBy: 0, commits: [], release: "v1" })],
    emptyDrafts(),
    now,
  );
  expect(first.document.drafts).toEqual([]);
  expect(first.document.seen).toEqual([{ url: "https://github.com/acme/web", tag: "v1" }]);
  expect(first.changed).toBe(true);

  const same = planDrafts(
    [pin()],
    [report({ status: "unchanged", aheadBy: 0, commits: [], release: "v1" })],
    first.document,
    now,
  );
  expect(same.changed).toBe(false);
  expect(same.document.drafts).toEqual([]);

  const next = planDrafts(
    [pin()],
    [report({ status: "unchanged", aheadBy: 0, commits: [], release: "v2" })],
    first.document,
    now,
  );
  expect(next.document.drafts).toHaveLength(1);
  expect(next.document.drafts[0]?.id).toBe("repo-watch:acme/web:abc1234:release:v2");
  expect(next.document.seen).toEqual([{ url: "https://github.com/acme/web", tag: "v2" }]);
});

it("does not keep a token or a home path in a draft", () => {
  const tagged = planDrafts(
    [pin()],
    [report({ release: planted, detail: `see ${planted} in /Users/example/notes` })],
    emptyDrafts(),
    now,
  );
  const text = JSON.stringify(tagged.document);
  expect(text).not.toContain(planted);
  expect(text).not.toContain("/Users/example");
  expect(tagged.document.drafts[0]?.id.endsWith(":commits")).toBe(true);
});

it("keeps a broken draft file's revision and drops a bad row", () => {
  const broken = parseDraftDocument('{"revision":4,"drafts":');
  expect(broken.revision).toBe(4);
  expect(broken.drafts).toEqual([]);
  const unsafe = parseDraftDocument(
    JSON.stringify({
      revision: 2,
      drafts: [
        {
          id: "repo-watch:acme/web:abc1234:commits",
          wp: "WP-166",
          title: "Upgrade acme/web",
          briefPath: "/Users/example/notes.md",
          branch: "upgrade-acme-web",
          status: "queued",
          securityPark: false,
          priority: 50,
          notes: DRAFT_NOTES,
          createdAt: now,
        },
      ],
      seen: [],
    }),
  );
  expect(unsafe.revision).toBe(2);
  expect(unsafe.drafts).toEqual([]);
});

it("does not open the draft file when the setting is off", async () => {
  const drafts = memoryDrafts();
  let fetches = 0;
  const run = await runRepoWatchHabit({
    projectRoot: "/work/web",
    monoId: "mono-1",
    monoName: "Ada",
    actorId: "mono-1",
    load: async () => ({ revision: 1, enqueueDrafts: false, pins: [pin()] }),
    fetchPin: async () => {
      fetches += 1;
      return emptyFetch({
        repoBody: JSON.stringify({ default_branch: "main" }),
        compareStatus: 200,
        compareBody: JSON.stringify({
          ahead_by: 2,
          commits: [{ sha: "abcdef1", commit: { message: "Open the door" } }],
        }),
        releaseMissing: true,
        releaseStatus: 404,
      });
    },
    write: async () => {},
    note: async () => {},
    drafts,
  });
  expect(fetches).toBe(1);
  expect(run.outcome).toBe("posted");
  expect(drafts.reads()).toBe(0);
  expect(drafts.writes()).toBe(0);
  expect(drafts.text()).toBeNull();
});

it("writes one draft, then does not write the same win again", async () => {
  const drafts = memoryDrafts();
  const input = {
    projectRoot: "/work/web",
    monoId: "mono-1",
    monoName: "Ada",
    actorId: "mono-1",
    load: async () => ({ revision: 1, enqueueDrafts: true, pins: [pin({ licence: "Apache-2.0" })] }),
    fetchPin: async () =>
      emptyFetch({
        repoBody: JSON.stringify({ default_branch: "main" }),
        compareStatus: 200,
        compareBody: JSON.stringify({
          ahead_by: 1,
          commits: [{ sha: "abcdef1", commit: { message: "Open the door" } }],
        }),
        releaseStatus: 200,
        releaseBody: JSON.stringify({ tag_name: "v9" }),
      }),
    write: async () => {},
    note: async () => {},
    drafts,
    now: () => now,
  };
  const first = await runRepoWatchHabit(input);
  expect(first.outcome).toBe("posted");
  expect(drafts.writes()).toBe(1);
  const saved = parseDraftDocument(drafts.text());
  expect(saved.drafts).toHaveLength(1);
  expect(saved.drafts[0]?.status).toBe("queued");
  expect(saved.seen[0]?.tag).toBe("v9");
  const second = await runRepoWatchHabit(input);
  expect(second.outcome).toBe("posted");
  expect(drafts.writes()).toBe(1);
  expect(parseDraftDocument(drafts.text()).drafts).toHaveLength(1);
});

it("still finishes the check when the draft file cannot be saved", async () => {
  const run = await runRepoWatchHabit({
    projectRoot: "/work/web",
    monoId: "mono-1",
    monoName: "Ada",
    actorId: "mono-1",
    load: async () => ({ revision: 1, enqueueDrafts: true, pins: [pin()] }),
    fetchPin: async () =>
      emptyFetch({
        repoBody: JSON.stringify({ default_branch: "main" }),
        compareStatus: 200,
        compareBody: JSON.stringify({ ahead_by: 1, commits: [{ sha: "abcdef1", commit: { message: "Open" } }] }),
        releaseMissing: true,
        releaseStatus: 404,
      }),
    write: async () => {},
    drafts: {
      async read() {
        return { text: null };
      },
      async write() {
        throw new Error("timed out");
      },
    },
  });
  expect(run.outcome).toBe("posted");
  expect(run.error).toBeUndefined();
});

it("reads again when another save lands first", async () => {
  let text: string | null = null;
  let refused = false;
  const io: DraftIo = {
    async read() {
      return { text };
    },
    async write(_root, body, expected) {
      if (!refused) {
        refused = true;
        text = JSON.stringify({ revision: 1, drafts: [], seen: [] });
        return false;
      }
      if (parseDraftDocument(text).revision !== expected) return false;
      text = body;
      return true;
    },
  };
  await saveDrafts(io, "/work/web", [pin()], [report()], now);
  const saved = parseDraftDocument(text);
  expect(saved.revision).toBe(2);
  expect(saved.drafts).toHaveLength(1);
});
