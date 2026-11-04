import { describe, expect, it } from "vitest";
import {
  ADD_FILTERS,
  DEFAULT_SOURCES,
  EMPTY_LISTING,
  MAX_SOURCES,
  SOURCES_KEY,
  addSource,
  addsText,
  commitSources,
  indexSourceText,
  installOutcome,
  installSourceText,
  licenceText,
  listPlugins,
  loadSources,
  offersInstall,
  readDiscoverPayload,
  removeSource,
  retryableFailure,
  settleListing,
  sourceDraft,
  startListing,
  statusText,
  visiblePlugins,
  type Entry,
  type IndexResult,
  type IndexSource,
  type SourceStore,
} from "./discover";

const COMMIT = "6ea74587e384e1a8035c09ae33a46fe3f881eb9b";

function entry(patch: Partial<Entry> = {}): Entry {
  return {
    name: "pstack",
    title: "pstack",
    description: "Skills for rigor.",
    keywords: ["rigor"],
    platforms: [],
    adds: [{ kind: "skills", count: 2, names: ["architect", "tdd"] }],
    leftOut: [],
    permissions: ["Reads the repository"],
    status: "available",
    format: "hivra",
    license: "MIT",
    author: "Lauren Tan",
    version: "0.15.36",
    source: { kind: "git", url: "https://github.com/cursor/plugins", commit: COMMIT, path: "pstack" },
    ...patch,
  };
}

function results(entries: Entry[], extra: Partial<IndexResult> = {}): IndexResult[] {
  return [{ source: { kind: "bundled" }, index: { title: "Hivra plugins", format: "hivra", entries, skipped: [] }, ...extra }];
}

function memory(initial?: string): SourceStore & { raw: () => string | null } {
  let value = initial ?? null;
  return {
    getItem: (key) => (key === SOURCES_KEY ? value : null),
    setItem: (key, next) => {
      if (key === SOURCES_KEY) value = next;
    },
    raw: () => value,
  };
}

describe("index sources (WP-32)", () => {
  it("starts from Hivra's own index when nothing is stored", () => {
    expect(loadSources(null)).toEqual({ revision: 0, sources: DEFAULT_SOURCES, dropped: 0 });
    expect(loadSources("")).toEqual({ revision: 0, sources: DEFAULT_SOURCES, dropped: 0 });
    expect(loadSources("not json")).toEqual({ revision: 0, sources: DEFAULT_SOURCES, dropped: 0 });
    expect(loadSources("null")).toEqual({ revision: 0, sources: DEFAULT_SOURCES, dropped: 0 });
  });

  it("drops junk, duplicates and anything past the cap, and keeps a real revision", () => {
    const urls = Array.from({ length: MAX_SOURCES + 2 }, (_, i) => ({ kind: "url", url: `https://example.com/${i}.json` }));
    const raw = JSON.stringify({
      revision: 4,
      sources: [
        { kind: "bundled", extra: true },
        { kind: "bundled" },
        { kind: "url", url: "http://example.com/a.json" },
        { kind: "url", url: "https://user:secret@example.com/a.json" },
        { kind: "file", path: "" },
        { kind: "nope" },
        { kind: "github", repo: "cursor/plugins", ref: "main" },
        ...urls,
      ],
    });
    const loaded = loadSources(raw);
    expect(loaded.revision).toBe(4);
    expect(loaded.sources[0]).toEqual({ kind: "bundled" });
    expect(loaded.sources[1]).toEqual({ kind: "github", repo: "cursor/plugins", ref: "main" });
    expect(loaded.sources).toHaveLength(MAX_SOURCES);
    // bundled and the GitHub source take two seats; four of the URLs are past the cap.
    expect(loaded.dropped).toBe(4);
    expect(loaded.sources.some((s) => s.kind === "url" && s.url.includes("secret"))).toBe(false);
  });

  it("keeps paths with spaces, unicode and Windows separators, and a trailing CR", () => {
    const path = "C:\\Users\\A b\\索引.json";
    const loaded = loadSources(JSON.stringify({ revision: 1, sources: [{ kind: "file", path: `${path}\r\n` }] }));
    expect(loaded.sources).toEqual([{ kind: "file", path }]);
  });

  it("does not treat a parent segment in a file path as unsafe to remember", () => {
    // Discover only reads the file the person named. It never deletes it.
    const loaded = loadSources(JSON.stringify({ revision: 2, sources: [{ kind: "file", path: "~/plugins/../index.json" }] }));
    expect(loaded.sources).toEqual([{ kind: "file", path: "~/plugins/../index.json" }]);
  });

  it("falls back to the default when a record has no list, without forgetting a numeric revision", () => {
    expect(loadSources(JSON.stringify({ revision: 3, sources: "nope" }))).toEqual({
      revision: 3,
      sources: DEFAULT_SOURCES,
      dropped: 0,
    });
    expect(loadSources(JSON.stringify({ revision: -1, sources: [{ kind: "bundled" }] })).revision).toBe(0);
  });

  it("writes only on top of the revision it read", () => {
    const store = memory(JSON.stringify({ revision: 2, sources: [{ kind: "bundled" }] }));
    const other = addSource(DEFAULT_SOURCES, { kind: "url", url: "https://example.com/mine.json" });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const lost = commitSources(store, 1, other.sources);
    expect(lost.ok).toBe(false);
    if (lost.ok) return;
    expect(lost.sources).toEqual(DEFAULT_SOURCES);
    expect(lost.message).toMatch(/another window/i);
    expect(JSON.parse(store.raw()!).revision).toBe(2);

    const kept = commitSources(store, 2, other.sources);
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.revision).toBe(3);
    expect(JSON.parse(store.raw()!).sources).toEqual(other.sources);
  });

  it("a failed save leaves the stored list alone", () => {
    const store: SourceStore = {
      getItem: () => JSON.stringify({ revision: 1, sources: DEFAULT_SOURCES }),
      setItem: () => {
        throw new Error("quota");
      },
    };
    const next = addSource(DEFAULT_SOURCES, { kind: "file", path: "~/index.json" });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const saved = commitSources(store, 1, next.sources);
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.message).toMatch(/couldn't save/i);
    expect(saved.sources).toEqual(DEFAULT_SOURCES);
  });

  it("refuses a second copy, a 21st index, and addresses that aren't safe to fetch", () => {
    expect(sourceDraft("url", " http://example.com/a.json ")).toMatchObject({ ok: false });
    expect(sourceDraft("url", "https://user:pw@example.com/a.json")).toMatchObject({
      ok: false,
      message: expect.stringMatching(/password/i),
    });
    expect(sourceDraft("url", "https://example.com/a.json")).toEqual({
      ok: true,
      source: { kind: "url", url: "https://example.com/a.json" },
    });
    expect(sourceDraft("github", "https://github.com/cursor/plugins.git@main")).toEqual({
      ok: true,
      source: { kind: "github", repo: "cursor/plugins", ref: "main" },
    });
    expect(sourceDraft("github", "cursor/plugins@feature/one")).toEqual({
      ok: true,
      source: { kind: "github", repo: "cursor/plugins", ref: "feature/one" },
    });
    expect(sourceDraft("github", "cursor/plugins@main;rm")).toMatchObject({ ok: false });
    expect(sourceDraft("file", "  ~/My Plugins/索引.json\r\n")).toEqual({
      ok: true,
      source: { kind: "file", path: "~/My Plugins/索引.json" },
    });
    expect(sourceDraft("file", "")).toMatchObject({ ok: false });
    expect(sourceDraft("file", "a\nb")).toMatchObject({ ok: false });

    const again = addSource(DEFAULT_SOURCES, { kind: "bundled" });
    expect(again.ok).toBe(false);
    const full = addSource(
      Array.from({ length: MAX_SOURCES }, (_, i) => ({ kind: "url", url: `https://example.com/${i}.json` }) as IndexSource),
      { kind: "url", url: "https://example.com/extra.json" },
    );
    expect(full).toMatchObject({ ok: false, message: expect.stringMatching(/20/) });
  });

  it("never leaves the list empty", () => {
    expect(removeSource([{ kind: "url", url: "https://example.com/a.json" }], 0)).toEqual(DEFAULT_SOURCES);
    expect(removeSource([{ kind: "bundled" }, { kind: "file", path: "~/a.json" }], 0)).toEqual([
      { kind: "file", path: "~/a.json" },
    ]);
  });
});

describe("listing (WP-32)", () => {
  it("reads a command payload and will not offer install for a source that isn't pinned", () => {
    const payload = readDiscoverPayload([
      {
        source: { kind: "bundled" },
        index: {
          title: "Hivra plugins",
          format: "hivra",
          skipped: [],
          entries: [
            entry(),
            entry({
              name: "loose",
              status: "available",
              source: { kind: "git", url: "https://github.com/a/b", commit: "abc", path: "../up" },
            }),
            entry({ name: "mystery", status: "ship-it" as Entry["status"] }),
            { name: "", title: "nope" },
          ],
        },
      },
      { source: { kind: "url", url: "https://example.com/down.json" }, error: "The index didn't answer. Nothing was listed." },
    ]);
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    const plugins = listPlugins(payload.results);
    expect(plugins.map((p) => p.entry.name)).toEqual(["pstack", "loose", "mystery"]);
    expect(offersInstall(plugins[0].entry)).toBe(true);
    expect(offersInstall(plugins[1].entry)).toBe(false);
    expect(plugins[1].entry.status).not.toBe("available");
    expect(plugins[2].entry.status).toBe("not-compatible");
    expect(offersInstall(plugins[2].entry)).toBe(false);
    expect(payload.results[1].index).toBeUndefined();
    expect(retryableFailure(payload.results[1].error!)).toBe(true);
    expect(plugins.every((p) => p.entry.status !== "not-compatible" || p.entry.name === "mystery")).toBe(true);
  });

  it("treats a missing or broken payload as a failed read, not as incompatible plugins", () => {
    for (const raw of [undefined, null, { plugins: [] }, "nope"]) {
      const outcome = readDiscoverPayload(raw);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.message).toMatch(/nothing was listed/i);
      expect(retryableFailure(outcome.message)).toBe(true);
    }
  });

  it("ignores a late result and keeps the previous list when a refresh fails", () => {
    const good = results([entry()]);
    let listing = settleListing(startListing(EMPTY_LISTING), 1, { ok: true, results: good });
    listing = startListing(listing);
    const generation = listing.generation;
    listing = startListing(listing);
    const late = settleListing(listing, generation, { ok: true, results: results([entry({ name: "stale", title: "Stale" })]) });
    expect(late.phase).toBe("loading");
    expect(listPlugins(late.results).map((p) => p.entry.name)).toEqual(["pstack"]);

    const failed = settleListing(late, late.generation, {
      ok: false,
      message: "The index didn't answer. Nothing was listed.",
    });
    expect(failed.phase).toBe("error");
    expect(failed.error).toMatch(/didn't answer/);
    expect(retryableFailure(failed.error!)).toBe(true);
    expect(listPlugins(failed.results).map((p) => p.entry.name)).toEqual(["pstack"]);
    expect(failed.results[0].index?.entries[0].status).toBe("available");
  });

  it("a format problem is a failed index, still not a final incompatible mark", () => {
    const outcome = readDiscoverPayload([
      { source: { kind: "file", path: "~/bad.json" }, error: "This index isn't valid JSON (eof). Nothing was listed." },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(listPlugins(outcome.results)).toEqual([]);
    expect(retryableFailure(outcome.results[0].error!)).toBe(false);
    expect(outcome.results[0].error).toMatch(/isn't valid JSON/);
  });
});

describe("search, filter and the detail (WP-32)", () => {
  const plugins = listPlugins(
    results([
      entry(),
      entry({
        name: "browser",
        title: "Browser",
        description: "A real browser for agents.",
        author: undefined,
        license: "Apache-2.0",
        keywords: ["web"],
        adds: [{ kind: "mcpServers", count: 1, names: ["browser"] }],
        permissions: ["Runs a browser on this computer"],
        source: { kind: "npm", package: "@hivra/browser", version: "1.2.3" },
      }),
      entry({
        name: "dsh-foo",
        title: "Foo",
        description: "Runs inside DeepSeek Harness.",
        author: undefined,
        status: "not-compatible",
        reason: "A DeepSeek Harness bundle.",
        adds: [],
        permissions: [],
        license: undefined,
        source: { kind: "npm", package: "@scope/dsh-foo", version: "1.0.0" },
      }),
      entry({
        name: "e2e-verify",
        title: "Verify",
        description: "Not published yet.",
        author: undefined,
        status: "planned",
        reason: "Not published yet (being built in WP-42).",
        source: undefined,
        version: undefined,
        adds: [{ kind: "skills", count: 1, names: ["create-verification-skill"] }],
        permissions: [],
      }),
    ]),
  );

  it("matches a name, a description or an author, and ignores empty space", () => {
    expect(visiblePlugins(plugins, "  ", "all").map((p) => p.entry.name)).toEqual([
      "pstack",
      "browser",
      "dsh-foo",
      "e2e-verify",
    ]);
    expect(visiblePlugins(plugins, "LAUREN", "all").map((p) => p.entry.name)).toEqual(["pstack"]);
    expect(visiblePlugins(plugins, "real browser", "all").map((p) => p.entry.name)).toEqual(["browser"]);
    expect(visiblePlugins(plugins, "no-such-plugin", "all")).toEqual([]);
  });

  it("filters by what a plugin adds", () => {
    expect(ADD_FILTERS.map((f) => f.id)).toContain("mcpServers");
    expect(visiblePlugins(plugins, "", "mcpServers").map((p) => p.entry.name)).toEqual(["browser"]);
    expect(visiblePlugins(plugins, "verify", "skills").map((p) => p.entry.name)).toEqual(["e2e-verify"]);
  });

  it("offers install only for a pinned plugin Hivra can use here", () => {
    const byName = Object.fromEntries(plugins.map((p) => [p.entry.name, p.entry]));
    expect(offersInstall(byName.pstack)).toBe(true);
    expect(offersInstall(byName.browser)).toBe(true);
    expect(offersInstall(byName["dsh-foo"])).toBe(false);
    expect(offersInstall(byName["e2e-verify"])).toBe(false);
    expect(offersInstall(entry({ status: "listed-only" }))).toBe(false);
    expect(offersInstall(entry({ status: "not-this-platform", reason: "Only for windows." }))).toBe(false);
    expect(offersInstall(entry({ source: undefined }))).toBe(false);
  });

  it("says the licence, the pinned source and what it adds in plain words", () => {
    expect(licenceText(entry())).toBe("MIT");
    expect(licenceText(entry({ license: "  " }))).toBe("The index doesn't say.");
    expect(installSourceText(entry().source!)).toBe(`https://github.com/cursor/plugins at ${COMMIT.slice(0, 7)} (pstack)`);
    expect(installSourceText({ kind: "npm", package: "@hivra/browser", version: "1.2.3" })).toBe("@hivra/browser 1.2.3");
    expect(addsText({ kind: "skills", count: 1, names: ["tdd"] })).toBe("1 skill");
    expect(addsText({ kind: "mcpServers", count: 2, names: [] })).toBe("2 MCP servers");
    expect(statusText("not-compatible")).toBe("Not compatible");
    expect(statusText("planned")).toBe("Not published yet");
    expect(indexSourceText({ kind: "github", repo: "cursor/plugins", ref: "main" })).toBe("cursor/plugins @ main");
  });
});

describe("install (WP-32)", () => {
  it("does not call a missing installer a success", () => {
    expect(installOutcome(undefined)).toEqual({
      ok: false,
      message: "Install isn't in this build yet. Nothing was installed.",
    });
    expect(installOutcome(null).ok).toBe(false);
    expect(installOutcome({ ok: false, error: "That platform isn't supported." })).toEqual({
      ok: false,
      message: "That platform isn't supported.",
    });
  });

  it("uses the words the installer returns", () => {
    expect(installOutcome({ message: "Installed pstack." })).toEqual({ ok: true, message: "Installed pstack." });
    expect(installOutcome({ ok: true })).toEqual({ ok: true, message: "Installed." });
  });
});
