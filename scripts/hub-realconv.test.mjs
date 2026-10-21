// The real-conversation runner's own tests (docs/REALCONV.md). Everything here runs on a fake provider and a fake hub,
// so it proves the runner, never the agents: the last test checks that a run like this can't come out as a pass.
// node --test scripts/hub-realconv.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SCENES_FILE, benchSpec, parseArgs, pickScenes, readCustomModel, runRealconv } from "./hub-realconv.mjs";
import { nextAshMove, scriptedProblem } from "./realconv/ash.mjs";
import { hardChecks, isAckOnly } from "./realconv/checks.mjs";
import { replyScores, verdict } from "./realconv/judge.mjs";
import { makeClient, providerSpec } from "./realconv/llm.mjs";

const book = JSON.parse(fs.readFileSync(SCENES_FILE, "utf8"));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "realconv-test-")));

// ---- providers ------------------------------------------------------------------------------------------------------

test("a key is only read from the variable Ash names, never picked up by itself", () => {
  const env = { XAI_API_KEY: "xai-not-real", DEEPSEEK_API_KEY: "ds-not-real", ANTHROPIC_API_KEY: "sk-not-real" };
  assert.throws(() => providerSpec({ provider: "xai", model: "grok-4" }, env), /name the environment variable/);
  assert.throws(() => providerSpec({ provider: "deepseek", model: "deepseek-chat" }, env), /--\*-key-env/);
  assert.throws(() => providerSpec({ provider: "xai", model: "grok-4", keyEnv: "xai-not-real" }, env), /a variable name, not a key/);
  assert.throws(() => providerSpec({ provider: "xai", model: "grok-4", keyEnv: "MISSING_KEY" }, env), /empty in this shell/);
  assert.equal(providerSpec({ provider: "xai", model: "grok-4", keyEnv: "XAI_API_KEY" }, env).baseUrl, "https://api.x.ai/v1");
  assert.equal(providerSpec({ provider: "ollama", model: "llama3.2" }, env).keyEnv, null);
  assert.equal(providerSpec({ provider: "fake" }).real, false);
  assert.equal(providerSpec({ provider: "claude" }).real, true);
  assert.throws(() => providerSpec({ provider: "gemini" }), /unknown provider/);
});

test("an OpenAI-compatible provider is called for real, and one that refuses reasoning_effort is asked again without it", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = JSON.parse(body);
      seen.push({ url: req.url, auth: req.headers.authorization, json });
      if ("reasoning_effort" in json) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unrecognized request argument supplied: reasoning_effort" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: ' {"action":"send","text":"so wat was it"} ' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const env = { MY_TEST_KEY: "test-key-123" };
    const spec = providerSpec({ provider: "custom", model: "m1", baseUrl: `http://127.0.0.1:${server.address().port}/v1/`, keyEnv: "MY_TEST_KEY", effort: "high" }, env);
    const client = makeClient(spec, { env });
    const answer = await client.complete({ system: "sys", prompt: "hi" });
    assert.equal(answer.text, '{"action":"send","text":"so wat was it"}');
    assert.equal(answer.real, true);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].url, "/v1/chat/completions");
    assert.equal(seen[0].auth, "Bearer test-key-123");
    assert.equal(seen[0].json.reasoning_effort, "high");
    assert.equal("reasoning_effort" in seen[1].json, false);
    assert.deepEqual(seen[1].json.messages.map((m) => m.role), ["system", "user"]);
  } finally {
    server.close();
  }
});

test("a provider's error never prints the key", async () => {
  const env = { K: "secret-abc" };
  const client = makeClient(providerSpec({ provider: "custom", model: "m", baseUrl: "http://x/v1", keyEnv: "K" }, env), {
    env,
    fetchImpl: async () => new Response("bad key secret-abc", { status: 401 }),
  });
  await assert.rejects(client.complete({ system: "s", prompt: "p" }), (error) => !error.message.includes("secret-abc") && /\[key\]/.test(error.message));
});

test("the claude tester runs the CLI with no tools and the dev login, without blocking", async () => {
  let call;
  const client = makeClient(providerSpec({ provider: "claude", model: "sonnet" }), {
    claudeBin: "/bin/claude-fake",
    claudeConfig: "/dev-config",
    spawnImpl: async (bin, args, opts) => {
      call = { bin, args, opts };
      return { status: 0, stdout: "hello\n" };
    },
  });
  assert.equal((await client.complete({ system: "be ash", prompt: "next?" })).text, "hello");
  assert.equal(call.bin, "/bin/claude-fake");
  assert.equal(call.args[call.args.indexOf("--tools") + 1], "");
  assert.ok(call.args.includes("--no-session-persistence"));
  assert.equal(call.opts.env.CLAUDE_CONFIG_DIR, "/dev-config");
  assert.equal(call.opts.input, "next?");
});

// ---- the tester ---------------------------------------------------------------------------------------------------

test("none of Ash's lines in the scene book are scripted, and scripted ones are caught", () => {
  for (const scene of book.scenes)
    for (const line of [scene.opening, ...(scene.followUps ?? []), scene.midChange?.text].filter(Boolean)) assert.equal(scriptedProblem(line), null, `${scene.id}: ${line}`);
  assert.match(scriptedProblem("read docs/ROUTING.md and tell me what it says"), /which file/);
  assert.match(scriptedProblem("open src/stats.ts and fix median"), /which file/);
  assert.match(scriptedProblem("reply with exactly DONE"), /what to reply/);
  assert.match(scriptedProblem('just say "ok"'), /what to say/);
  assert.match(scriptedProblem("@frank wat do u think"), /tags/);
  assert.equal(scriptedProblem("the stats test is red, can u sort it"), null);
});

test("the tester gets one more go at a scripted line, then the scene is invalid", async () => {
  const answers = ['{"action":"send","text":"read README.md first"}', '{"action":"send","text":"so wat was it"}'];
  const once = makeClient({ provider: "fake", model: "fake" }, { script: (_s, _p, n) => answers[n - 1] });
  const move = await nextAshMove(once, book.scenes.find((s) => s.id === "S5"), [{ who: "Ash", text: "hi" }], { elapsedSec: 10, ashTurns: 1, maxAshTurns: 4 }, { system: "ash" });
  assert.equal(move.action, "send");
  assert.equal(move.text, "so wat was it");
  assert.equal(move.refused.length, 1);
  const always = makeClient({ provider: "fake", model: "fake" }, { script: () => '{"action":"send","text":"reply with only yes"}' });
  assert.equal((await nextAshMove(always, book.scenes[0], [], { elapsedSec: 0, ashTurns: 1, maxAshTurns: 2 }, { system: "ash" })).action, "invalid");
});

// ---- hard checks --------------------------------------------------------------------------------------------------

test("a bare ack is an automatic fail, a reply with substance isn't", () => {
  for (const ack of ["Noted.", "noted", "Got it, on it.", "+1", "👍", "Good, noted.", "NO_REPLY", "ok", "Sounds good, thanks!"]) assert.equal(isAckOnly(ack), true, ack);
  for (const real of ["Done. The median was off by one on even lengths; fixed in stats.ts, 4/4 tests pass.", "Noted, but I disagree: public by default leaks the owner list. Keep private.", "", "Two things are stuck: zod install needs your approval."])
    assert.equal(isAckOnly(real), false, real);
});

test("hard checks: a handoff that never chats back, a stuck worker nobody can see, a leak, and missing work", () => {
  const t0 = 1_000_000;
  const out = hardChecks({
    toAsh: [
      { t: t0 + 1000, who: "tally-lead", where: "chat", text: "Handing the fix to a worker now." },
      { t: t0 + 2000, who: "chief-of-staff", where: "room", text: "Noted." },
      { t: t0 + 3000, who: "frank", where: "room", text: "The EXO palette is Vanguard orange, use that." },
    ],
    delegations: [{ id: "d1", created_at: new Date(t0 + 1500).toISOString(), updated_at: new Date(t0 + 9000).toISOString(), settled_at: new Date(t0 + 9000).toISOString(), state: "completed", owner_mono: "tally-lead", parent_id: null }],
    stuckSeen: [{ t: t0 + 5000, session: "w1", visible: false, where: [] }],
    leaks: [{ pattern: "Vanguard", who: "frank", text: "The EXO palette is Vanguard orange" }],
    git: { changed: [], diff: "" },
    tests: { command: "npm test", code: 1, tail: "1 failing" },
    expect: { filesChanged: true, projectTests: "npm test", delegation: true },
  });
  const fails = out.autoFails.map((f) => f.check);
  assert.ok(fails.includes("ack-only"), fails);
  assert.ok(fails.includes("handoff-no-report-back"), fails);
  assert.ok(fails.includes("stuck-invisible"), fails);
  assert.ok(fails.includes("project-leak"), fails);
  assert.ok(out.misses.some((m) => /project to change/.test(m)), out.misses);
  assert.ok(out.misses.some((m) => /npm test/.test(m)), out.misses);
});

test("hard checks: when Ash writes to the whole room, each seat replies at most once", () => {
  const t0 = 1_000_000;
  const room = (who, text, dt) => ({ t: t0 + dt, who, where: "room", text });
  const once = hardChecks({ toAsh: [room("chief-of-staff", "Morning. Board's green.", 1000), room("frank", "Morning. Nothing flagged overnight.", 2000)], delegations: [], stuckSeen: [], expect: { eachSeatOnce: true } });
  assert.deepEqual(once.misses, []);
  const twice = hardChecks({ toAsh: [room("chief-of-staff", "Morning.", 1000), room("frank", "Morning.", 2000), room("frank", "Also, the checker is red.", 3000)], delegations: [], stuckSeen: [], expect: { eachSeatOnce: true } });
  assert.deepEqual(twice.misses, ["a seat replied more than once to one message from Ash: frank"]);
});

test("hard checks: a clean scene has no automatic fail and no miss", () => {
  const t0 = 1_000_000;
  const out = hardChecks({
    toAsh: [
      { t: t0 + 1000, who: "tally-lead", where: "chat", text: "Handing the median fix to a worker, back in a few minutes." },
      { t: t0 + 20000, who: "tally-lead", where: "chat", text: "Fixed. The median sorted strings, so 10 came before 9. stats.ts now sorts numbers; npm test is 4/4 green." },
    ],
    delegations: [{ id: "d1", created_at: new Date(t0 + 1500).toISOString(), updated_at: new Date(t0 + 15000).toISOString(), settled_at: new Date(t0 + 15000).toISOString(), state: "completed", owner_mono: "tally-lead", parent_id: null }],
    stuckSeen: [{ t: t0 + 5000, session: "w1", visible: true, where: ["Needs you: approve npm install"] }],
    git: { changed: ["src/stats.ts"], diff: "+ sort((a, b) => a - b)" },
    tests: { command: "npm test", code: 0, tail: "4 passing" },
    expect: { filesChanged: true, projectTests: "npm test", delegation: true },
  });
  assert.deepEqual(out.autoFails, []);
  assert.deepEqual(out.misses, []);
});

// ---- verdicts -----------------------------------------------------------------------------------------------------

const perfect = { grade: "PASS", realConversation: true, replies: [{ answers: 2, adds: 2, disagrees: null, honest: 2, voice: 2 }], sceneChecks: [{ check: "pass line", pass: true }], autoFails: [] };
const real = { agents: true, tester: true, judge: true };

test("verdicts follow Alfred's rules", () => {
  assert.equal(verdict({ hard: { autoFails: [], misses: [] }, judged: perfect, provenance: real }).verdict, "PASS");
  assert.equal(verdict({ hard: { autoFails: [{ check: "ack-only" }], misses: [] }, judged: perfect, provenance: real }).verdict, "FAIL");
  assert.equal(verdict({ hard: { autoFails: [], misses: ["filesChanged"] }, judged: perfect, provenance: real }).verdict, "PARTIAL");
  assert.equal(verdict({ hard: { autoFails: [], misses: ["a", "b"] }, judged: perfect, provenance: real }).verdict, "FAIL");
  const low = { ...perfect, replies: [{ answers: 1, adds: 1, honest: 1, voice: 1 }] };
  assert.equal(replyScores(low.replies).average, 1);
  assert.equal(verdict({ hard: { autoFails: [], misses: [] }, judged: low, provenance: real }).verdict, "PARTIAL");
  const missedPoint = { ...perfect, replies: [{ answers: 0, adds: 2, honest: 2, voice: 2 }, { answers: 2, adds: 2, honest: 2, voice: 2 }] };
  assert.equal(verdict({ hard: { autoFails: [], misses: [] }, judged: missedPoint, provenance: real }).verdict, "PARTIAL");
  // The judge writing PASS over a hard fail doesn't make a pass.
  assert.equal(verdict({ hard: { autoFails: [{ check: "project-leak" }], misses: [] }, judged: { ...perfect, grade: "PASS" }, provenance: real }).verdict, "FAIL");
  assert.equal(verdict({ hard: { autoFails: [], misses: [] }, judged: { ...perfect, triggered: false }, provenance: real }).verdict, "NOT-TRIGGERED");
  assert.equal(verdict({ hard: { autoFails: [], misses: [] }, judged: perfect, provenance: real, invalid: "tester scripted" }).verdict, "INVALID");
  assert.equal(verdict({ hard: { autoFails: [], misses: [] }, judged: { grade: "UNGRADED", error: "x" }, provenance: real }).verdict, "UNGRADED");
});

test("nothing a fake played or judged can pass, however well it scored", () => {
  for (const part of ["agents", "tester", "judge"]) {
    const v = verdict({ hard: { autoFails: [], misses: [] }, judged: perfect, provenance: { ...real, [part]: false } });
    assert.equal(v.verdict, "NOT-REAL");
    assert.equal(v.wouldBe, "PASS");
    assert.match(v.reasons[0], new RegExp(part));
  }
});

// ---- the command line ----------------------------------------------------------------------------------------------

test("the scene book: every scene has its card, place and opening; S10, S5 and S14 run; the rest say why not", () => {
  assert.equal(book.scenes.length, 17);
  for (const scene of book.scenes) {
    assert.ok(scene.card?.length > 40 && scene.opening && scene.place, scene.id);
    if (scene.runnable === false) assert.ok(scene.why, scene.id);
  }
  const { run, skipped } = pickScenes(book, ["S10", "S5", "S14", "S9"]);
  assert.deepEqual(run.map((s) => s.id), ["S10", "S5", "S14"]);
  assert.equal(skipped[0].verdict, "SKIPPED");
  assert.throws(() => pickScenes(book, ["S99"]), /no scene S99/);
  assert.ok(book.judgeRubric.includes("Automatic fails") || book.judgeRubric.length > 500);
});

test("options: the agents are what the hub is set to, a custom model comes from Ash's file without a key", () => {
  const o = parseArgs(["--scenes", "s10,s5", "--agents", "custom:grok", "--tester", "xai", "--tester-model", "grok-4", "--tester-key-env", "XAI_API_KEY"]);
  assert.deepEqual(o.scenes, ["S10", "S5"]);
  assert.equal(o.tester.keyEnv, "XAI_API_KEY");
  assert.equal(o.judge.provider, "claude");
  assert.throws(() => parseArgs(["--agents", "gpt"]), /claude:<model> or custom:<id>/);
  assert.equal(benchSpec(book, [], parseArgs([])).appModel, "claude:sonnet-5");
  assert.equal(benchSpec(book, [], parseArgs(["--agents", "claude:opus-4"])).model, "opus");
  const dir = tmp();
  const file = path.join(dir, "model.json");
  fs.writeFileSync(file, JSON.stringify({ customModels: [{ id: "grok", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4" }] }));
  assert.deepEqual(readCustomModel(file, "grok"), { id: "grok", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4" });
  fs.writeFileSync(file, JSON.stringify({ id: "grok", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4", apiKey: "not-real" }));
  assert.throws(() => readCustomModel(file, "grok"), /never takes a key/);
  assert.throws(() => readCustomModel(null, "grok"), /needs --custom-model/);
});

// ---- a whole run on a fake hub -------------------------------------------------------------------------------------

/** A stand-in for the realtest bench: a hub whose agents answer from `reply(text)`, and the hooks run as runBench runs them. */
function fakeBench({ reply }) {
  return async (_options, hooks) => {
    const evidence = path.join(tmp(), "run");
    fs.mkdirSync(evidence, { recursive: true });
    const project = path.join(evidence, "tally");
    fs.mkdirSync(project);
    const git = (...a) => execFileSync("git", a, { cwd: project, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(require('fs').existsSync('fixed') ? 0 : 1)\"" } }));
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "start");
    const events = [];
    const ops = [];
    const act = async (op, payload = {}) => {
      ops.push({ op, ...payload });
      if (op === "send") {
        const t = Date.now();
        events.push({ t, kind: "room-message", room: payload.to.room, from: "ash", text: payload.text });
        for (const [i, [from, text]] of reply(payload.text, project).entries()) events.push({ t: t + 10 + i, kind: "room-message", room: payload.to.room, from, text });
        return { ok: true, at: t, room: payload.to.room };
      }
      if (op === "snapshot") return { ok: true, sessions: [], monos: [{ id: "tally-lead", sessionId: "s-lead" }], rooms: [], dom: { elements: [] } };
      return { ok: true, model: { efforts: [] } };
    };
    const ctx = {
      act, events, evidence, project, log: () => {}, pump: async () => {}, usage: () => ({ turns: 0, requests: 0 }),
      claudeTexts: async () => [], delegationRows: async () => [], monoSession: async () => "s-lead",
      leadId: "tally-lead", roomId: "tally:leadership", spec: hooks.spec, deadline: Date.now() + 10 * 60_000, state: evidence,
    };
    await hooks.afterReady?.(ctx);
    const results = await hooks.play(ctx, { runScenario: async () => ({ chats: {} }), stopped: () => null });
    return { id: "test-run", evidence, results, stopReason: null, ops };
  };
}

test("a run on a fake provider writes transcripts and a report, and calls nothing a pass", { timeout: 60_000 }, async () => {
  const dir = tmp();
  const scenesFile = path.join(dir, "scenes.json");
  const scene = (id, title) => ({ id, title, card: `${title}: the room should talk to each other and to Ash with substance.`, place: { room: "room" }, opening: "should we keep pages to 3 builds at once or let it rip. be honest", maxAshTurns: 2, quietSec: 1, minutes: 1, expect: { roomSeatsMin: 1, projectTests: "npm test", filesChanged: true } });
  fs.writeFileSync(scenesFile, JSON.stringify({ ...book, scenes: [scene("T1", "a good round"), scene("T2", "a round with a bare ack")] }));
  let round = 0;
  const bench = fakeBench({
    reply: (text, project) => {
      round += 1;
      fs.writeFileSync(path.join(project, "fixed"), "1");
      if (round === 3) return [["chief-of-staff", "Noted."]];
      return [["frank", `Keep it at 3: two builds already fight over the one runner, and a fourth queues anyway. On "${text.slice(0, 20)}", I'd measure first.`], ["alfred", "Disagree a little with frank: 4 is fine once the runner is split; until then 3."]];
    },
  });
  const tester = makeClient({ provider: "fake", model: "fake" }, { script: (_s, _p, n) => (n % 2 ? '{"action":"send","text":"ok so wats the call"}' : '{"action":"done"}') });
  const judge = makeClient({ provider: "fake", model: "fake" }, { script: () => JSON.stringify(perfect) });
  const options = { ...parseArgs(["--scenes", "T1,T2", "--tester", "fake", "--judge", "fake"]), scenesFile };
  const outcome = await runRealconv(options, { bench, clients: { tester, judge, agentsReal: false } });

  assert.equal(outcome.code, 1);
  assert.deepEqual(outcome.results.map((r) => r.verdict), ["NOT-REAL", "NOT-REAL"]);
  assert.equal(outcome.results[0].wouldBe, "PASS");
  assert.equal(outcome.results[1].wouldBe, "FAIL");
  assert.ok(outcome.results[1].hard.autoFails.some((f) => f.check === "ack-only" && f.who === "chief-of-staff"));
  const out = path.dirname(outcome.report);
  const report = fs.readFileSync(outcome.report, "utf8");
  assert.match(report, /\*\*Not a real run\.\*\*/);
  assert.doesNotMatch(report, /\| PASS /);
  for (const id of ["T1", "T2"]) for (const file of ["transcript.md", "evidence.json", "result.json", "tester.ndjson"]) assert.ok(fs.existsSync(path.join(out, id, file)), `${id}/${file}`);
  const transcript = fs.readFileSync(path.join(out, "T1", "transcript.md"), "utf8");
  assert.match(transcript, /\*\*Ash\*\* \(his own words\): should we keep pages/);
  assert.match(transcript, /\*\*frank\*\*: Keep it at 3/);
  assert.match(transcript, /Files changed: .*fixed/);
  assert.match(transcript, /exit 0 in the main checkout/);
  const json = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
  assert.equal(json.real, false);
});

test("a dry run checks the options and starts nothing", async () => {
  let started = false;
  const outcome = await runRealconv({ ...parseArgs(["--scenes", "S10,S5,S14,S17", "--tester", "fake", "--judge", "fake", "--dry-run"]) }, { bench: async () => (started = true) });
  assert.equal(started, false);
  assert.deepEqual(outcome.plan.scenes, ["S10", "S5", "S14"]);
  assert.match(outcome.plan.skipped[0], /^S17: /);
});

// Ash, 21 Oct: real runs on Claude Code running Grok 4.7 through his Grok subscription.
test("--agents grok-sub puts the agents, the tester and the judge on the Grok subscription bridge", () => {
  const options = parseArgs(["--agents", "grok-sub"]);
  assert.equal(options.agents, "grok-sub");
  assert.equal(options.tester.provider, "grok-sub");
  assert.equal(options.judge.provider, "grok-sub");
  assert.equal(parseArgs(["--agents", "grok-sub", "--judge", "claude"]).judge.provider, "claude");
  const spec = providerSpec({ provider: "grok-sub" });
  assert.equal(spec.model, "grok-4.7");
  assert.equal(spec.real, true);
  // The app keeps a model it knows; the bench's wrapper sends every call to Grok 4.7.
  assert.equal(benchSpec(book, [], options).appModel, "claude:sonnet-5");
});

test("a grok-sub client runs the bridge launcher with Grok 4.7", async () => {
  const calls = [];
  const client = makeClient(providerSpec({ provider: "grok-sub" }), {
    spawnImpl: async (bin, args) => {
      calls.push({ bin, args });
      return { status: 0, stdout: "ok", stderr: "" };
    },
  });
  const answer = await client.complete({ system: "s", prompt: "p" });
  assert.equal(answer.text, "ok");
  assert.match(calls[0].bin, /\/\.local\/bin\/claude-grok$/);
  assert.equal(calls[0].args[calls[0].args.indexOf("--model") + 1], "grok-4.7");
});

test("S5 runs its coding-team chat in Full access; no other scene changes the mode", () => {
  const modes = book.scenes.filter((s) => s.runtimeMode).map((s) => [s.id, s.runtimeMode]);
  assert.deepEqual(modes, [["S5", "full-access"]]);
});

test("a quiet room isn't settled while a handoff started in the scene still runs", async () => {
  const { handoffsOpen } = await import("./realconv/player.mjs");
  const t0 = Date.parse("2026-10-21T11:19:24Z");
  const row = (state, created = "2026-10-21T11:20:00Z") => ({ state, created_at: created });
  assert.equal(handoffsOpen([row("running")], t0), true);
  assert.equal(handoffsOpen([row("question")], t0), true);
  assert.equal(handoffsOpen([row("completed"), row("failed"), row("cancelled")], t0), false);
  // One left open by an earlier scene isn't this scene's.
  assert.equal(handoffsOpen([row("running", "2026-10-21T10:00:00Z")], t0), false);
});

test("the app's 'Waiting on you' notice in a chat counts as its answer to Ash, first seen once", async () => {
  const { appNoticeLines } = await import("./realconv/player.mjs");
  const seen = new Map();
  const blocks = [
    { id: "a", role: "assistant", text: "working" },
    { id: "n1", role: "system", notice: "waiting-on-you", text: "Waiting on you: it asked to run `npm install zod`." },
    { id: "n2", role: "system", notice: "account-moved", text: "moved" },
  ];
  assert.deepEqual(appNoticeLines(blocks, seen, 100), [{ t: 100, text: "Waiting on you: it asked to run `npm install zod`." }]);
  assert.deepEqual(appNoticeLines(blocks, seen, 200), [{ t: 100, text: "Waiting on you: it asked to run `npm install zod`." }]);
});

test("in a clicks scene the tester may click a listed button, and an unlisted one is refused", async () => {
  const { nextAshMove } = await import("./realconv/ash.mjs");
  const answers = ['{"action":"click","label":"Delete"}', '{"action":"click","label":"Discard","why":"no"}'];
  const client = { complete: async () => ({ text: answers.shift() }) };
  const move = await nextAshMove(client, { id: "AD15", title: "t", card: "c" }, [], { elapsedSec: 1, ashTurns: 1, maxAshTurns: 4, buttons: [{ label: "Apply", disabled: false }, { label: "Discard", disabled: false }] }, { system: "s" });
  assert.equal(move.action, "click");
  assert.equal(move.label, "Discard");
  assert.match(move.refused[0], /no button "Delete"/);
});

test("a seat's room turn is counted once, in the room, not again as its chat text", async () => {
  const { dropRoomEchoes } = await import("./realconv/player.mjs");
  const lines = [
    { t: 8000, who: "chief-of-staff", where: "chat", text: "Morning. Nothing new on Tally." },
    { t: 8100, who: "chief-of-staff", where: "room", text: "Morning. Nothing new on Tally." },
    { t: 9000, who: "chief-of-staff", where: "chat", text: "Different words in its own chat." },
  ];
  assert.deepEqual(dropRoomEchoes(lines).map((l) => l.where + ":" + l.text.slice(0, 9)), ["room:Morning. ", "chat:Different"]);
});

test("a judge that narrates instead of answering gets one more go for the JSON", async () => {
  const { judgeScene } = await import("./realconv/judge.mjs");
  const answers = ["I'll check each seat's soul first.", '{"grade":"PASS","replies":[]}'];
  const prompts = [];
  const client = { provider: "fake", model: "m", real: false, complete: async ({ prompt }) => (prompts.push(prompt), { text: answers.shift() }) };
  const judged = await judgeScene(client, { id: "AD2", title: "t", card: "c" }, "## Timeline", {}, "rubric");
  assert.equal(judged.grade, "PASS");
  assert.match(prompts[1], /no tools/);
});

test("a judge that times out gets one more go, and a run's UNGRADED scenes can be judged again from what it saved", async () => {
  const { judgeScene } = await import("./realconv/judge.mjs");
  let calls = 0;
  const flaky = { provider: "fake", model: "m", real: true, complete: async ({ timeoutMs }) => {
    calls += 1;
    assert.equal(timeoutMs, 600_000);
    if (calls === 1) throw new Error("claude exited 143");
    return { text: '{"grade":"PASS","replies":[]}' };
  } };
  assert.equal((await judgeScene(flaky, { id: "AD5", title: "t", card: "c" }, "## Timeline", {}, "r")).grade, "PASS");

  const { rejudgeRun } = await import("./realconv/rejudge.mjs");
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "rejudge-"));
  for (const [id, verdict] of [["AD5", "UNGRADED"], ["AD3", "FAIL"]]) {
    fs.mkdirSync(path.join(run, id));
    fs.writeFileSync(path.join(run, id, "transcript.md"), `# ${id}\n- +1s **Ash**: hi`);
    fs.writeFileSync(path.join(run, id, "result.json"), JSON.stringify({ id, verdict, reasons: [], hard: { autoFails: [], misses: [] }, provenance: { agents: true, tester: true, judge: true } }));
  }
  const judge = { provider: "fake", model: "m", real: true, complete: async () => ({ text: '{"grade":"PASS","replies":[{"answers":2,"adds":2,"disagrees":null,"honest":2,"voice":2}],"sceneChecks":[],"autoFails":[]}' }) };
  const book = { scenes: [{ id: "AD5", title: "t", card: "c" }, { id: "AD3", title: "t", card: "c" }], judgeRubric: "r" };
  const changed = await rejudgeRun(run, { book, judge });
  assert.deepEqual(changed.map((c) => c.id), ["AD5"]);
  const after = JSON.parse(fs.readFileSync(path.join(run, "AD5", "result.json"), "utf8"));
  assert.equal(after.verdict, "PASS");
  assert.equal(after.before.verdict, "UNGRADED");
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, "AD3", "result.json"), "utf8")).verdict, "FAIL");
});
