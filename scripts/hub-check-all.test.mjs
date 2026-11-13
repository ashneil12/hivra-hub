// Tests for scripts/hub-check-all.mjs (SC-2): a pass is recorded only when npm run check passed, the built app for this
// exact commit launched and stayed up, and hub:verify-live has a recorded pass for it. Every step is a stub here
// (main(deps)); nothing builds, launches or runs the real checks.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { findVerifyLivePass, main } from "./hub-check-all.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const BUNDLE_REL = "target/release/bundle/macos/MonoCode Hub.app";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const goodStamp = (sha = SHA) => ({ sha, branch: "sc/2", dirty: false, builtAt: "2026-11-13T09:00:00Z" });

const passVerdict = (sha = SHA, more = {}) => ({
  run: "20261113-100000-ab12",
  verdict: "PASS",
  scope: "wiring",
  failGate: false,
  startedAt: "2026-11-13T09:50:00.000Z",
  finishedAt: "2026-11-13T10:00:00.000Z",
  build: { branch: "sc/2", sha, dirty: false },
  cleanup: { ran: true, ok: true },
  ...more,
});

function writeVerdict(repo, run, doc) {
  const dir = path.join(repo, "evidence", run);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "verdict.json"), typeof doc === "string" ? doc : JSON.stringify(doc));
}

/** A repo folder with an evidence folder, and every dependency of main() stubbed. `state` is what the stubs read. */
function setup({ state = {}, deps = {}, verdicts = [] } = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub check-all tëst-")));
  roots.push(repo);
  for (const [run, doc] of verdicts) writeVerdict(repo, run, doc);
  const s = { head: SHA, dirty: "", stamp: goodStamp(), doctor: 0, check: 0, build: 0, verifyLive: 0, launch: { ok: true, upSeconds: 30, pid: 4321, home: "/tmp/x", logTail: "" }, ...state };
  const calls = [];
  const lines = [];
  let launched = null;
  let clock = Date.parse("2026-11-13T10:30:00.000Z");
  const api = {
    repo,
    head: () => s.head,
    dirty: () => s.dirty,
    doctor: () => (calls.push("doctor"), s.doctor),
    runCheck: () => {
      calls.push("check");
      if (s.headAfterCheck) s.head = s.headAfterCheck;
      return s.check;
    },
    runBuild: () => {
      calls.push("build");
      if ("stampAfterBuild" in s) s.stamp = s.stampAfterBuild;
      return s.build;
    },
    runVerifyLive: () => {
      calls.push("verify-live");
      if (s.verdictAfterVerifyLive) writeVerdict(repo, "run-from-verify-live", s.verdictAfterVerifyLive);
      if (s.headAfterVerifyLive) s.head = s.headAfterVerifyLive;
      return s.verifyLive;
    },
    inspectBundle: () => (s.stamp ? { ok: true, stamp: s.stamp, errors: [] } : { ok: false, stamp: null, errors: ["no bundle at the build path"] }),
    launch: async (options) => {
      calls.push("launch");
      launched = options;
      if (s.dirtyAfterLaunch) s.dirty = s.dirtyAfterLaunch;
      return s.launch;
    },
    now: () => new Date((clock += 1000)),
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
    ...deps,
  };
  const recordFile = path.join(repo, "target/hub-checks", `${SHA}.json`);
  return {
    repo,
    state: s,
    calls,
    lines,
    recordFile,
    launched: () => launched,
    run: () => main(api),
    record: () => (fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, "utf8")) : null),
    out: () => lines.join("\n"),
  };
}

test("all three pass: the record carries the launch and the verify-live pass next to the old fields", async () => {
  const t = setup({ verdicts: [["20261113-100000-ab12", passVerdict()]] });
  assert.equal(await t.run(), 0, t.out());
  const record = t.record();
  assert.equal(record.sha, SHA);
  assert.equal(record.ok, true);
  assert.equal(record.command, "npm run check");
  for (const field of ["startedAt", "finishedAt"]) assert.ok(!Number.isNaN(Date.parse(record[field])), field);
  assert.equal(typeof record.durationMs, "number");
  assert.equal(typeof record.node, "string");
  assert.equal(record.launch.ok, true);
  assert.equal(record.launch.upSeconds, 30);
  assert.ok(!Number.isNaN(Date.parse(record.launch.at)));
  assert.equal(record.verifyLive.ok, true);
  assert.equal(record.verifyLive.verdict, "evidence/20261113-100000-ab12/verdict.json", "a relative path, with forward slashes");
  assert.equal(record.verifyLive.at, "2026-11-13T10:00:00.000Z", "when verify-live ran, not when this run finished");
  // The pass was already recorded for HEAD and the bundle is HEAD's: neither the build nor verify-live runs again.
  assert.deepEqual(t.calls, ["doctor", "check", "launch"]);
  assert.deepEqual(t.launched(), { bundle: path.join(t.repo, BUNDLE_REL), expectSha: SHA });
});

test("a launch that fails records nothing and stops before verify-live", async () => {
  const t = setup({
    state: { launch: { ok: false, reason: "the app died after 3 s (exit code 3)", logTail: "thread 'main' panicked at dictation helper" } },
    verdicts: [["run", passVerdict()]],
  });
  assert.equal(await t.run(), 1);
  assert.equal(t.record(), null, "nothing recorded");
  assert.deepEqual(t.calls, ["doctor", "check", "launch"]);
  assert.match(t.out(), /died after 3 s/);
  assert.match(t.out(), /panicked at dictation helper/, "the log tail is shown");
  assert.match(t.out(), /nothing recorded/);
});

test("no verify-live pass for HEAD: it runs verify-live and records the pass it left", async () => {
  const t = setup({ state: { verdictAfterVerifyLive: passVerdict(SHA, { run: "later", finishedAt: "2026-11-13T10:20:00.000Z" }) } });
  assert.equal(await t.run(), 0, t.out());
  assert.deepEqual(t.calls, ["doctor", "check", "launch", "verify-live"]);
  assert.equal(t.record().verifyLive.verdict, "evidence/run-from-verify-live/verdict.json");
  assert.equal(t.record().verifyLive.ok, true);
});

test("a verify-live verdict for another commit does not count", async () => {
  const t = setup({ verdicts: [["old-run", passVerdict(OTHER)]] });
  assert.equal(await t.run(), 1);
  assert.ok(t.calls.includes("verify-live"), "it ran verify-live because nothing counted");
  assert.equal(t.record(), null);
  assert.match(t.out(), /verify-live/);
  assert.match(t.out(), /aaaaaaa/, "it names the commit with no pass");
});

test("verify-live ran and passed for another commit while it ran: still no record", async () => {
  const t = setup({ state: { verdictAfterVerifyLive: passVerdict(OTHER, { run: "other" }) } });
  assert.equal(await t.run(), 1);
  assert.equal(t.record(), null);
});

test("a failing verify-live run records nothing and says so", async () => {
  const t = setup({ state: { verifyLive: 1 } });
  assert.equal(await t.run(), 1);
  assert.equal(t.record(), null);
  assert.match(t.out(), /hub:verify-live failed \(exit 1\)/);
});

test("no bundle for HEAD: it builds first, re-reads the stamp, then launches", async () => {
  const t = setup({ state: { stamp: null, stampAfterBuild: goodStamp() }, verdicts: [["run", passVerdict()]] });
  assert.equal(await t.run(), 0, t.out());
  assert.deepEqual(t.calls, ["doctor", "check", "build", "launch"]);
});

test("a bundle from another commit is rebuilt, and one that is dirty is rebuilt too", async () => {
  for (const stamp of [goodStamp(OTHER), { ...goodStamp(), dirty: true }]) {
    const t = setup({ state: { stamp, stampAfterBuild: goodStamp() }, verdicts: [["run", passVerdict()]] });
    assert.equal(await t.run(), 0, t.out());
    assert.deepEqual(t.calls, ["doctor", "check", "build", "launch"]);
  }
});

test("a build that still isn't HEAD's, or that fails, records nothing and never launches", async () => {
  const wrong = setup({ state: { stamp: null, stampAfterBuild: goodStamp(OTHER) }, verdicts: [["run", passVerdict()]] });
  assert.equal(await wrong.run(), 1);
  assert.equal(wrong.record(), null);
  assert.ok(!wrong.calls.includes("launch"));
  assert.match(wrong.out(), /bbbbbbb/);
  assert.match(wrong.out(), /aaaaaaa/);

  const failed = setup({ state: { stamp: null, build: 75 }, verdicts: [["run", passVerdict()]] });
  assert.equal(await failed.run(), 75, "the build's own exit code");
  assert.equal(failed.record(), null);
  assert.match(failed.out(), /hub:build failed \(exit 75\)/);
  assert.ok(!failed.calls.includes("launch"));
});

test("a failing npm run check stops everything", async () => {
  const t = setup({ state: { check: 2 }, verdicts: [["run", passVerdict()]] });
  assert.equal(await t.run(), 2);
  assert.deepEqual(t.calls, ["doctor", "check"]);
  assert.equal(t.record(), null);
});

test("a dirty checkout, or a broken install, records nothing", async () => {
  const dirty = setup({ state: { dirty: " M scripts/x.mjs" } });
  assert.equal(await dirty.run(), 1);
  assert.deepEqual(dirty.calls, []);
  assert.match(dirty.out(), /uncommitted changes/);

  const hygiene = setup({ state: { doctor: 5 } });
  assert.equal(await hygiene.run(), 5);
  assert.deepEqual(hygiene.calls, ["doctor"]);
  assert.match(hygiene.out(), /hygiene/);
  assert.equal(hygiene.record(), null);
});

test("the checkout changing while the checks ran records nothing, whichever step it moved during", async () => {
  // During npm run check: it stops there, before any build or launch.
  const early = setup({ state: { headAfterCheck: OTHER }, verdicts: [["run", passVerdict()]] });
  assert.equal(await early.run(), 1);
  assert.equal(early.record(), null);
  assert.match(early.out(), /checkout changed/);
  assert.deepEqual(early.calls, ["doctor", "check"]);

  // During verify-live, the last step: the pass it left is for a commit that is no longer HEAD.
  const late = setup({ state: { headAfterVerifyLive: OTHER, verdictAfterVerifyLive: passVerdict() } });
  assert.equal(await late.run(), 1);
  assert.equal(late.record(), null);
  assert.match(late.out(), /checkout changed/);

  // Uncommitted edits made while the app was being launched.
  const edited = setup({ verdicts: [["run", passVerdict()]] });
  edited.state.dirtyAfterLaunch = " M src/app/App.tsx";
  assert.equal(await edited.run(), 1);
  assert.equal(edited.record(), null);
  assert.match(edited.out(), /checkout changed/);
});

// ---- which verify-live verdicts count ---------------------------------------------------------------------------------

test("only a full, clean pass for exactly HEAD counts as a verify-live pass", () => {
  const cases = [
    ["a FAIL verdict", passVerdict(SHA, { verdict: "FAIL" })],
    ["a negative control that missed (a PASS from --fail-gate)", passVerdict(SHA, { failGate: true, negativeControl: "missed" })],
    ["a negative control by its run name", passVerdict(SHA, { run: "20261113-100000-ab12-fail-gate" })],
    ["a partial run (--only)", passVerdict(SHA, { only: ["mono_own_team"] })],
    ["a build with uncommitted changes", passVerdict(SHA, { build: { branch: "b", sha: SHA, dirty: true } })],
    ["a run whose own cleanup failed", passVerdict(SHA, { cleanup: { ran: true, ok: false, leftovers: { sessions: ["s1"] } } })],
    ["another commit", passVerdict(OTHER)],
    ["no build block", { ...passVerdict(), build: undefined }],
    ["a pass with no finish time", passVerdict(SHA, { finishedAt: "yesterday-ish" })],
    ["not an object", "[]"],
    ["not JSON", "{ this is not json"],
    ["a number", "42"],
  ];
  for (const [what, doc] of cases) {
    const t = setup({ verdicts: [["run", doc]] });
    assert.equal(findVerifyLivePass(t.repo, SHA), null, what);
  }
});

test("a clean pass counts, even beside runs that don't, and the newest one wins", () => {
  const t = setup({
    verdicts: [
      ["older", passVerdict(SHA, { finishedAt: "2026-11-13T08:00:00.000Z" })],
      ["newest", passVerdict(SHA, { finishedAt: "2026-11-13T11:00:00.000Z" })],
      ["failed-after", passVerdict(SHA, { verdict: "FAIL", finishedAt: "2026-11-13T12:00:00.000Z" })],
      ["other", passVerdict(OTHER, { finishedAt: "2026-11-13T13:00:00.000Z" })],
      ["broken", "{"],
    ],
  });
  const found = findVerifyLivePass(t.repo, SHA);
  assert.deepEqual(found, { verdict: "evidence/newest/verdict.json", at: "2026-11-13T11:00:00.000Z" });
});

test("a missing evidence folder, an empty one and a folder with no verdict are no pass", () => {
  const none = setup();
  assert.equal(findVerifyLivePass(none.repo, SHA), null);
  fs.mkdirSync(path.join(none.repo, "evidence", "empty-run"), { recursive: true });
  fs.writeFileSync(path.join(none.repo, "evidence", "stray-file.txt"), "x");
  assert.equal(findVerifyLivePass(none.repo, SHA), null);
});

test("a verdict that is a link is never read", { skip: process.platform === "win32" }, () => {
  const t = setup();
  const outside = path.join(t.repo, "outside-verdict.json");
  fs.writeFileSync(outside, JSON.stringify(passVerdict()));
  fs.mkdirSync(path.join(t.repo, "evidence", "linked"), { recursive: true });
  fs.symlinkSync(outside, path.join(t.repo, "evidence", "linked", "verdict.json"));
  assert.equal(findVerifyLivePass(t.repo, SHA), null);
});
