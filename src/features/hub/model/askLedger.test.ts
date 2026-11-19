// @vitest-environment happy-dom
// Ash's asks, read out of a message (B5, I6): what a message asked for, in his order. And the evidence an ask is judged
// against: the commits in the chat's folder (whoever made them) and the files they changed, read here from a real
// temporary git repository so the parsing is proven.
//
// This file used to also test the hub ledger's own rows (recordAskText, handleAsk, a restart, a repeated ask). That ledger
// is folded into the one ask ledger and no longer written, so those tests moved with it: a repeated ask on its own row,
// across a restart, is in asks/model/hubRoute.test.ts ("saying it again"); what a done ask keeps is in askedView.test.ts.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { askCovered, doneClaimOf, evidenceSince, extractAsks, type EvidenceCommit, type EvidenceSource } from "./askLedger";

beforeEach(() => localStorage.clear());

const MESSAGE =
  "ok so: the footer is cramped, the save button should say when it worked\nand we said fridays for the board review right?";

it("takes the asks out of a message in his order and leaves chatter out", () => {
  const asks = extractAsks(MESSAGE);
  expect(asks.map((ask) => ask.words)).toEqual([
    "the footer is cramped, the save button should say when it worked",
    "and we said fridays for the board review right?",
  ]);
  expect(asks[0].title).toBe("the footer is cramped, the save button should say when it worked");
  // One short ask counts as much as a line of a dump.
  expect(extractAsks("fix the save bug")).toEqual([{ title: "fix the save bug", words: "fix the save bug" }]);
  // Chatter, the app's own turns and a bare thank-you produce nothing, so nothing is written down for them.
  expect(extractAsks("thanks!")).toEqual([]);
  expect(extractAsks("ok")).toEqual([]);
  expect(extractAsks("nice, that works")).toEqual([]);
  expect(extractAsks("[MonoCode check] are you sure?")).toEqual([]);
  // Said twice in one message, it is one ask.
  expect(extractAsks("fix the save bug. Please fix the save bug.")).toHaveLength(1);
});

it("writes nothing to the old hub ledger's key: reading a message and judging evidence touch no storage", () => {
  extractAsks("fix the save bug");
  expect(localStorage.getItem("monocode:hub-ask-ledger")).toBeNull();
});

it("reads the commits inside his window from the chat's folder, whoever made them, with the files they changed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ask-ledger-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Someone", GIT_AUTHOR_EMAIL: "someone@example.com", GIT_COMMITTER_NAME: "Someone", GIT_COMMITTER_EMAIL: "someone@example.com" } });
  const commit = (file: string, text: string, subject: string, date: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
    git("add", file);
    git("commit", "-m", subject, "--date", date, "--author", "Someone <someone@example.com>");
    // --date only sets author time; the committer time is set through the environment.
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Someone");
    git("config", "user.email", "someone@example.com");
    git("config", "commit.gpgsign", "false");
    commit("old.ts", "old\n", "an old thing", "2020-01-01T00:00:00Z");
    commit("src/save.ts", "export {}\n", "say when saving worked", "2030-01-01T00:00:00Z");

    const source: EvidenceSource = {
      async commits(cwd) {
        const out = execFileSync("git", ["log", "--format=%H%x00%h%x00%at%x00%s%x1e"], { cwd, encoding: "utf8" });
        return out
          .split("\x1e")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry): EvidenceCommit => {
            const [sha, shortSha, timestamp, subject] = entry.split("\0");
            return { sha, shortSha, timestamp: Number(timestamp), subject };
          });
      },
      async commitFiles(cwd, sha) {
        return execFileSync("git", ["show", "--name-only", "--format=", sha], { cwd, encoding: "utf8" })
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
      },
      botChanges: () => [{ line: "the hub copy was installed" }],
    };
    const since = Date.parse("2029-01-01T00:00:00Z");
    const lines = await evidenceSince({ cwd: dir, since }, source);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^committed [0-9a-f]+ say when saving worked \(src\/save\.ts\)$/);
    expect(lines.join("\n")).not.toContain("an old thing");
    expect(lines[1]).toBe("bot change: the hub copy was installed");
    const ask = { title: "the save button should say when it worked", words: "the save button should say when it worked" };
    expect(askCovered(ask, lines)).toBe(true);
    expect(askCovered({ title: "the footer is cramped", words: "the footer is cramped" }, lines)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("hears a done claim in a reply, and not the sentence that denies one", () => {
  expect(doneClaimOf("Done: the footer and the save both changed.")).toBe("Done: the footer and the save both changed.");
  expect(doneClaimOf("This isn't done yet.")).toBeUndefined();
  expect(doneClaimOf("Fixed the footer, then looked at the save.")).toBe("Fixed the footer, then looked at the save.");
  expect(doneClaimOf("The next thing to fix is the panel.")).toBeUndefined();
});
