import { expect, it } from "vitest";
import { QUIET_MARKER } from "../../monos/model/monoHabits";
import { repoWatchHabit, setRepoWatchEnabled, withRepoWatchHabit } from "./habit";
import type { RepoPin } from "./pins";
import { runRepoWatchHabit } from "./run";
import {
  activityLine,
  changesMarkdown,
  compareRef,
  emptyFetch,
  interpretFetch,
  projectLabel,
  type FetchBodies,
} from "./watch";

const planted = `ghp_${"a".repeat(36)}`;

function pin(over: Partial<RepoPin> = {}): RepoPin {
  return {
    url: "https://github.com/acme/web",
    licence: "MIT",
    pinSha: "abc1234",
    notes: "",
    ...over,
  };
}

function same(): FetchBodies {
  return emptyFetch({
    repoBody: JSON.stringify({ default_branch: "main" }),
    compareStatus: 200,
    compareBody: JSON.stringify({ ahead_by: 0, commits: [] }),
    releaseMissing: true,
    releaseStatus: 404,
  });
}

it("adds a Monday morning habit and does not replace one that was edited", () => {
  const now = Date.parse("2026-11-02T10:00:00");
  const habit = repoWatchHabit(now);
  expect(habit.id).toBe("repo-watch");
  expect(habit.schedule).toMatchObject({ scheduleKind: "weekly", time: "09:00", dayOfWeek: 1 });
  expect(habit.enabled).toBe(true);
  expect(habit.instructions).toContain(QUIET_MARKER);
  expect(habit.instructions.toLowerCase()).toContain("token");
  expect(habit.nextRunAt).toBeGreaterThan(now);

  const edited = { ...habit, enabled: false, instructions: "Edited. Do not replace." };
  expect(withRepoWatchHabit([edited], now)).toEqual([edited]);
  expect(setRepoWatchEnabled([edited], true, now)).toEqual([{ ...edited, enabled: true }]);
  expect(setRepoWatchEnabled([edited], false, now)).toEqual([edited]);
  expect(setRepoWatchEnabled([], false, now)).toEqual([]);
  const added = setRepoWatchEnabled([], true, now);
  expect(added).toHaveLength(1);
  expect(added[0]?.id).toBe("repo-watch");
});

it("treats a timeout as unchecked and a missing release as no release", () => {
  expect(interpretFetch(pin(), emptyFetch({ timedOut: true })).detail).toBe("Could not check this time.");
  expect(interpretFetch(pin(), emptyFetch({ unreachable: true })).status).toBe("unchecked");
  const quiet = interpretFetch(pin(), same());
  expect(quiet.status).toBe("unchanged");
  expect(quiet.detail).toContain("No release.");
  expect(quiet.detail).not.toContain("Could not check");
});

it("uses HEAD when the default branch is not a safe ref", () => {
  expect(compareRef("release/1.2")).toBe("release/1.2");
  expect(compareRef("feature/../main")).toBe("HEAD");
  expect(compareRef("my branch")).toBe("HEAD");
  expect(compareRef("a?b")).toBe("HEAD");
  const report = interpretFetch(
    pin(),
    emptyFetch({
      repoBody: JSON.stringify({ default_branch: "feature/../main" }),
      compareStatus: 200,
      compareBody: JSON.stringify({
        ahead_by: 1,
        commits: [{ sha: "abcdef1", commit: { message: "Open the door" } }],
      }),
      releaseMissing: true,
    }),
  );
  expect(report.status).toBe("changed");
  expect(report.detail).toContain("on HEAD");
  expect(report.commits).toEqual(["abcdef1 Open the door"]);
});

it("caps commit lines and strips a token and a home path", () => {
  const commits = Array.from({ length: 10 }, (_, index) => ({
    sha: `abc123${index}`,
    commit: { message: index === 0 ? `see ${planted} at /Users/example/notes` : `Change ${index}` },
  }));
  const report = interpretFetch(
    pin(),
    emptyFetch({
      repoBody: JSON.stringify({ default_branch: "main" }),
      compareStatus: 200,
      compareBody: JSON.stringify({ ahead_by: 10, commits }),
      releaseStatus: 200,
      releaseBody: JSON.stringify({ tag_name: "v2" }),
    }),
  );
  expect(report.commits).toHaveLength(8);
  expect(report.commits.join(" ")).not.toContain(planted);
  expect(report.commits.join(" ")).not.toContain("/Users/example");
  expect(report.commits[0]).toContain("[secret removed]");
  expect(report.commits[0]).toContain("a local path");
  expect(report.release).toBe("v2");
  const markdown = changesMarkdown("/Users/example/work/web", [report]);
  expect(markdown).toContain("Project: web");
  expect(markdown).not.toContain("/Users/example");
  expect(markdown).not.toContain(planted);
  expect(projectLabel("C:\\Users\\example\\work\\web")).toBe("web");
});

it("writes a quiet summary when nothing changed and skips the write when stopped", async () => {
  let written = "";
  const notes: string[] = [];
  const quiet = await runRepoWatchHabit({
    projectRoot: "/work/web",
    monoId: "mono-1",
    monoName: "Ada",
    actorId: "mono-1",
    load: async () => ({ revision: 1, enqueueDrafts: false, pins: [pin()] }),
    fetchPin: async () => same(),
    write: async (markdown) => {
      written = markdown;
    },
    note: async (summary, project) => {
      notes.push(`${project}:${summary}`);
    },
  });
  expect(quiet.outcome).toBe("quiet");
  expect(quiet.reply).toBe(QUIET_MARKER);
  expect(written).toContain("No changes since abc1234");
  expect(written).not.toContain("No repositories are pinned.");
  expect(notes[0]?.startsWith("web:")).toBe(true);
  expect(notes[0]).not.toContain("/work/web");

  let calls = 0;
  const signal = { aborted: false };
  const stopped = await runRepoWatchHabit({
    projectRoot: "/work/web",
    monoId: "mono-1",
    monoName: "Ada",
    actorId: "mono-1",
    signal,
    load: async () => ({ revision: 1, enqueueDrafts: false, pins: [pin()] }),
    fetchPin: async () => {
      signal.aborted = true;
      return same();
    },
    write: async () => {
      calls += 1;
    },
  });
  expect(stopped.cancelled).toBe(true);
  expect(calls).toBe(0);
});

it("does not call the fetch for a bad address, and a timeout is still written", async () => {
  const seen: string[] = [];
  let markdown = "";
  const run = await runRepoWatchHabit({
    projectRoot: "/work/web",
    monoId: "mono-1",
    monoName: "Ada",
    actorId: "mono-1",
    load: async () => ({
      revision: 1,
      enqueueDrafts: false,
      pins: [pin({ url: "https://github.com/acme/../secret", pinSha: "abc1234" }), pin()],
    }),
    fetchPin: async (item) => {
      seen.push(item.url);
      throw new Error("timed out talking to github");
    },
    write: async (text) => {
      markdown = text;
    },
    note: async () => {
      throw new Error("activity down");
    },
  });
  expect(seen).toEqual(["https://github.com/acme/web"]);
  expect(run.outcome).toBe("posted");
  expect(run.reply).toContain("could not be checked");
  expect(markdown).toContain("Could not check this time.");
  expect(run.error).toBeUndefined();
});

it("keeps a short activity line and a failed write is not final wording", async () => {
  expect(activityLine(`# Repo watch\n\n${"word ".repeat(200)}`)).toHaveLength(500);
  const failed = await runRepoWatchHabit({
    projectRoot: "/work/web",
    monoId: "mono-1",
    monoName: "Ada",
    actorId: "",
    load: async () => ({ revision: 0, enqueueDrafts: false, pins: [] }),
    write: async () => {
      throw new Error("timed out");
    },
    note: async () => {
      throw new Error("should not be called");
    },
  });
  expect(failed.outcome).toBe("failed");
  expect(failed.error).toBe("Could not write the summary this time.");
  expect(failed.error).not.toContain("/work");
});
