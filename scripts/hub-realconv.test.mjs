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

import { SCENES_FILE, benchRunOptions, benchSpec, parseArgs, pickScenes, readCustomModel, realconvExitCode, runRealconv } from "./hub-realconv.mjs";
import { nextAshMove, scriptedProblem } from "./realconv/ash.mjs";
import { hardChecks, isAckOnly } from "./realconv/checks.mjs";
import { replyScores, verdict } from "./realconv/judge.mjs";
import { makeClient, providerSpec } from "./realconv/llm.mjs";

// WP-105: git run in a temporary repo must stop at the temp parent and never discover this checkout.
{
  const existing = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = existing ? `${os.tmpdir()}${path.delimiter}${existing}` : os.tmpdir();
}

const book = JSON.parse(fs.readFileSync(SCENES_FILE, "utf8"));

test("a bench that never proved its shell is not a pass, even when every scene was skipped", () => {
  const skipped = [{ verdict: "SKIPPED" }, { verdict: "SKIPPED" }];
  assert.equal(realconvExitCode(skipped, "bench broken: echo probe"), 1);
  assert.equal(realconvExitCode(skipped, "bench broken: monocode version"), 1);
  assert.equal(realconvExitCode(skipped, "budget spent"), 0);
  assert.equal(realconvExitCode([{ verdict: "PASS" }], null), 0);
  assert.equal(realconvExitCode([{ verdict: "FAIL" }], null), 1);
  assert.equal(realconvExitCode([{ verdict: "PASS" }], "bench broken: echo probe"), 1);
});
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
    const env = { MY_TEST_KEY: "test-key-123", REALTEST_GATEWAY: `127.0.0.1:${server.address().port}` };
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

test("a model call to a port this run did not name is refused before any request", async () => {
  const env = { K: "test-key", REALTEST_GATEWAY: "127.0.0.1:8317" };
  const denied = makeClient(providerSpec({ provider: "custom", model: "m", baseUrl: "http://127.0.0.1:9/v1", keyEnv: "K" }, env), { env });
  await assert.rejects(denied.complete({ system: "s", prompt: "p" }), /not a loopback port/);
  const outside = makeClient(providerSpec({ provider: "custom", model: "m", baseUrl: "http://203.0.113.1:9/v1", keyEnv: "K" }, env), { env });
  await assert.rejects(outside.complete({ system: "s", prompt: "p" }), /not a loopback port/);
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

test("hard checks: a Mono made in the scene is in the facts the judge reads (AD13 run f451: Postie was made and the judge called it work not present)", () => {
  const out = hardChecks({ toAsh: [{ t: 1, who: "chief-of-staff", where: "room", text: "Postie's in the sidebar." }], delegations: [], stuckSeen: [], newMonos: ["Postie (fb04)"] });
  assert.deepEqual(out.facts.newMonos, ["Postie (fb04)"]);
  assert.deepEqual(hardChecks({ toAsh: [], delegations: [], stuckSeen: [] }).facts.newMonos, []);
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
  // S1 to S17 are Alfred's; S18 and S19 are ash-day step 9 (normal chat, then Keep one long chat on). CANARY proves the named CLIs.
  assert.equal(book.scenes.length, 20);
  assert.deepEqual(book.scenes.filter((s) => s.id === "S18" || s.id === "S19").map((s) => [s.id, s.longChat ?? null]), [["S18", null], ["S19", "lead"]]);
  assert.deepEqual(book.scenes.find((s) => s.id === "CANARY").canaryClis, ["codex", "grok", "hermes", "claude"]);
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
  assert.equal(o.judge.provider, "deepseek-sub");
  assert.throws(() => parseArgs(["--agents", "gpt"]), /claude:<model> or custom:<id>/);
  // Ash, 27 Oct: nothing defaults to his Claude subscription; agents, tester and judge are on DeepSeek unless named.
  const plain = parseArgs([]);
  assert.deepEqual([plain.agents, plain.tester.provider, plain.judge.provider], ["deepseek-sub", "deepseek-sub", "deepseek-sub"]);
  assert.equal(parseArgs(["--agents", "claude:sonnet-5"]).judge.provider, "deepseek-sub");
  assert.equal(benchSpec(book, [], plain).appModel, "claude:sonnet-5");
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
      if (op === "teamPack") return { ok: payload.pack === "ash", pack: "ash", wrote: ["chief-of-staff"] };
      if (op === "snapshot") return { ok: true, sessions: [], monos: [{ id: "tally-lead", sessionId: "s-lead" }], rooms: [], dom: { elements: [] } };
      return { ok: true, model: { efforts: [] } };
    };
    const ctx = {
      act, events, evidence, project, log: () => {}, pump: async () => {}, usage: () => ({ turns: 0, requests: 0 }),
      claudeTexts: async () => [], delegationRows: async () => [], monoSession: async () => "s-lead",
      leadId: "tally-lead", roomId: "tally:leadership", spec: hooks.spec, deadline: Date.now() + 10 * 60_000, state: evidence,
    };
    await hooks.beforeReady?.({ act, log: () => {} });
    // As the real bench: a fresh copy has no team (WP-05), so the room is seated only once a team is put on it before
    // the ready wait. A runner that pre-loads only after ready never gets there.
    if (!ops.some((o) => o.op === "teamPack")) throw new Error("the hub never made tally-lead and a seated tally:leadership");
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

test("--agents grok-sub points the hub's chats at Grok and leaves the tester and the judge on DeepSeek", async () => {
  const options = parseArgs(["--agents", "grok-sub"]);
  assert.equal(options.agents, "grok-sub");
  assert.equal(options.tester.provider, "deepseek-sub");
  assert.equal(options.judge.provider, "deepseek-sub");
  assert.equal(parseArgs(["--agents", "grok-sub", "--judge", "claude"]).judge.provider, "claude");
  assert.equal(benchSpec(book, [], options).appModel, "claude:sonnet-5");
  assert.equal(benchRunOptions(options).grokSub, true);
  assert.equal(benchRunOptions(options).deepseekSub, false);
  assert.throws(() => providerSpec({ provider: "grok-sub" }), /unknown provider/);
  const outcome = await runRealconv({ ...parseArgs(["--scenes", "S10", "--agents", "grok-sub", "--dry-run"]) }, { bench: async () => false });
  assert.match(outcome.plan.agents, /Grok/);
  assert.match(outcome.plan.tester, /^deepseek-sub\//);
  assert.match(outcome.plan.judge, /^deepseek-sub\//);
});

// Ash, 5 Nov: "everything on OR" — the DeepSeek balance behind the local gateway is empty, so a run can go entirely
// through his own launcher for Claude Code on OpenRouter (~/.local/bin/claude-openrouter).
test("--agents openrouter-sub points the hub's chats at OpenRouter, and the tester and judge follow when named", async () => {
  const options = parseArgs(["--agents", "openrouter-sub"]);
  assert.equal(options.agents, "openrouter-sub");
  // On its own it is a bridge like grok-sub: the tester and the judge stay on DeepSeek unless Ash names them.
  assert.equal(options.tester.provider, "deepseek-sub");
  assert.equal(options.judge.provider, "deepseek-sub");
  const all = parseArgs(["--agents", "openrouter-sub", "--tester", "openrouter-sub", "--judge", "openrouter-sub"]);
  assert.deepEqual([all.agents, all.tester.provider, all.judge.provider], ["openrouter-sub", "openrouter-sub", "openrouter-sub"]);
  // The app keeps its Claude default; the bench's wrapper sends every call to the launcher.
  assert.equal(benchSpec(book, [], options).appModel, "claude:sonnet-5");
  assert.equal(benchRunOptions(options).openrouterSub, true);
  assert.equal(benchRunOptions(options).deepseekSub, false);
  assert.equal(benchRunOptions(options).grokSub, false);
  assert.equal(benchRunOptions(options).haikuTest, undefined);
  const spec = providerSpec({ provider: "openrouter-sub" });
  assert.equal(spec.model, "deepseek/deepseek-v4.1-flash");
  assert.equal(spec.real, true);
  // No key variable: the launcher reads its own key from the Keychain.
  assert.equal(spec.keyEnv, undefined);
  const outcome = await runRealconv({ ...parseArgs(["--scenes", "S10", "--agents", "openrouter-sub", "--dry-run"]) }, { bench: async () => false });
  assert.match(outcome.plan.agents, /OpenRouter/);
  assert.match(outcome.plan.tester, /^deepseek-sub\//);
  assert.match(outcome.plan.judge, /^deepseek-sub\//);
});

test("an openrouter-sub client runs the OpenRouter launcher, never the plain claude binary", async () => {
  const calls = [];
  const spawnImpl = async (bin, args) => {
    calls.push({ bin, args });
    return { status: 0, stdout: "ok", stderr: "" };
  };
  const client = makeClient(providerSpec({ provider: "openrouter-sub" }), { spawnImpl });
  const answer = await client.complete({ system: "s", prompt: "p" });
  assert.equal(answer.text, "ok");
  assert.match(calls[0].bin, /\/\.local\/bin\/claude-openrouter$/);
  // The same CLI call shape as the DeepSeek launcher, through a launcher this test owns (a fake one, never Ash's).
  const dir = tmp();
  const fake = path.join(dir, "claude-openrouter");
  fs.writeFileSync(fake, "#!/bin/sh\necho unreachable\n", { mode: 0o755 });
  const withFake = makeClient(providerSpec({ provider: "openrouter-sub" }), { claudeBin: fake, spawnImpl });
  await withFake.complete({ system: "s", prompt: "p" });
  assert.equal(calls[1].bin, fake);
  assert.deepEqual(calls[1].args.slice(0, 3), ["-p", "--model", "deepseek/deepseek-v4.1-flash"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Ash, 23 Oct: "dont use grok use deepseek sub" — the same shape, on DeepSeek V4.1 Flash through his local gateway.
test("--agents deepseek-sub puts the agents, the tester and the judge on the DeepSeek launcher", () => {
  const options = parseArgs(["--agents", "deepseek-sub"]);
  assert.equal(options.agents, "deepseek-sub");
  assert.equal(options.tester.provider, "deepseek-sub");
  assert.equal(options.judge.provider, "deepseek-sub");
  assert.equal(parseArgs(["--agents", "deepseek-sub", "--judge", "claude"]).judge.provider, "claude");
  const spec = providerSpec({ provider: "deepseek-sub" });
  assert.equal(spec.model, "deepseek-v4.1-flash");
  assert.equal(spec.real, true);
  // No key variable: the launcher reads the gateway's own key at runtime.
  assert.equal(spec.keyEnv, undefined);
  assert.equal(benchSpec(book, [], options).appModel, "claude:sonnet-5");
});

test("a deepseek-sub client runs the DeepSeek launcher, never the plain claude binary", async () => {
  const calls = [];
  const client = makeClient(providerSpec({ provider: "deepseek-sub" }), {
    spawnImpl: async (bin, args) => {
      calls.push({ bin, args });
      return { status: 0, stdout: "ok", stderr: "" };
    },
  });
  const answer = await client.complete({ system: "s", prompt: "p" });
  assert.equal(answer.text, "ok");
  assert.match(calls[0].bin, /\/\.local\/bin\/claude-deepseek$/);
});

test("S5 runs its coding-team chat in Full access; no other scene changes the mode", () => {
  const modes = book.scenes.filter((s) => s.runtimeMode).map((s) => [s.id, s.runtimeMode]);
  assert.deepEqual(modes, [["S5", "full-access"]]);
});

test("a Mono-chat scene sets its runtime mode on that Mono's chat and puts it back when the scene ends", async () => {
  const { runConversation } = await import("./realconv/player.mjs");
  const dir = tmp();
  const calls = [];
  const scene = { id: "M1", title: "a Mono that runs commands", card: "", place: { mono: "frank" }, opening: "run the tests n tell me", minutes: 0, runtimeMode: "full-access", expect: {} };
  const judge = makeClient({ provider: "fake", model: "fake" }, { script: () => JSON.stringify({ grade: "FAIL", replies: [], realConversation: false, summary: "nothing was proven", sceneChecks: [], autoFails: [] }) });
  const tester = makeClient({ provider: "fake", model: "fake" }, { script: () => '{"action":"done"}' });
  await runConversation(scene, {
    act: async (op, args) => {
      calls.push({ op, args: JSON.parse(JSON.stringify(args ?? {})) });
      if (op === "send") return { ok: true, at: Date.now(), session: "frank-chat", runtimeMode: args?.runtimeMode, previousRuntimeMode: "auto" };
      if (op === "snapshot") return { ok: true, sessions: [{ id: "frank-chat", title: "frank", mono: "frank" }], monos: [], rooms: [], dom: { elements: [] } };
      return { ok: true };
    },
    events: [], evidence: dir, project: dir, log: () => {}, pump: async () => {}, usage: () => ({ turns: 0, requests: 0 }),
    claudeTexts: async () => [], delegationRows: async () => [], monoSession: async () => "frank-chat", sessionBlocks: async () => [],
    leadId: "tally-lead", roomId: "tally:leadership", spec: { project: { id: "tally" }, leak: [] }, deadline: Date.now() + 60_000,
    state: dir, team: [], home: "/tmp/bench-home", dataDir: "/tmp/bench-data", copies: [],
  }, { tester, judge, agentsReal: false, out: dir, rubric: "" });
  const send = calls.filter((c) => c.op === "send");
  assert.deepEqual(send[0].args.to, { mono: "frank" });
  assert.equal(send[0].args.runtimeMode, "full-access");
  const back = calls.filter((c) => c.op === "runtimeMode");
  assert.deepEqual(back, [{ op: "runtimeMode", args: { session: "frank-chat", runtimeMode: "auto" } }]);
  assert.ok(calls.indexOf(back[0]) > calls.indexOf(send[0]), "the chat's earlier mode goes back after the scene's sends");
});

test("a Mono-chat scene cut by an error still puts the chat's earlier runtime mode back", async () => {
  const { runConversation } = await import("./realconv/player.mjs");
  const dir = tmp();
  const calls = [];
  const scene = { id: "M2", title: "a Mono scene that breaks", card: "", place: { mono: "frank" }, opening: "run the tests n tell me", minutes: 1, runtimeMode: "full-access", expect: {} };
  const judge = makeClient({ provider: "fake", model: "fake" }, { script: () => JSON.stringify({ grade: "FAIL", replies: [], realConversation: false, summary: "n/a", sceneChecks: [], autoFails: [] }) });
  const tester = makeClient({ provider: "fake", model: "fake" }, { script: () => '{"action":"done"}' });
  await assert.rejects(
    runConversation(scene, {
      act: async (op, args) => {
        calls.push({ op, args: JSON.parse(JSON.stringify(args ?? {})) });
        if (op === "send") return { ok: true, at: Date.now(), session: "frank-chat", runtimeMode: args?.runtimeMode, previousRuntimeMode: "auto" };
        if (op === "snapshot") return { ok: true, sessions: [{ id: "frank-chat", title: "frank", mono: "frank" }], monos: [], rooms: [], dom: { elements: [] } };
        return { ok: true };
      },
      events: [], evidence: dir, project: dir, log: () => {}, pump: async () => { throw new Error("the window went away"); }, usage: () => ({ turns: 0, requests: 0 }),
      claudeTexts: async () => [], delegationRows: async () => [], monoSession: async () => "frank-chat", sessionBlocks: async () => [],
      leadId: "tally-lead", roomId: "tally:leadership", spec: { project: { id: "tally" }, leak: [] }, deadline: Date.now() + 120_000,
      state: dir, team: [], home: "/tmp/bench-home", dataDir: "/tmp/bench-data", copies: [],
    }, { tester, judge, agentsReal: false, out: dir, rubric: "" }),
    /the window went away/,
  );
  assert.deepEqual(calls.filter((c) => c.op === "runtimeMode"), [{ op: "runtimeMode", args: { session: "frank-chat", runtimeMode: "auto" } }]);
});

test("an ask still open when the scene ends is stuck on that permission, not a plain fail", async () => {
  const { runConversation } = await import("./realconv/player.mjs");
  const dir = tmp();
  const scene = { id: "P1", title: "a read that never got an answer", card: "Ash asks for a file.", place: { room: "room" }, opening: "read the notes", minutes: 0, quietSec: 0, expect: {} };
  const judge = makeClient({ provider: "fake", model: "fake" }, { script: () => JSON.stringify({ grade: "FAIL", replies: [], realConversation: false, summary: "no reply", sceneChecks: [], autoFails: [] }) });
  const tester = makeClient({ provider: "fake", model: "fake" }, { script: () => '{"action":"done"}' });
  const result = await runConversation(scene, {
    act: async (op) => {
      if (op === "send") return { ok: true, at: Date.now(), room: "tally:leadership" };
      if (op === "snapshot") return { ok: true, sessions: [{ id: "chat-1", title: "Tally", cwd: "/tmp/bench-home", mono: "tally-lead", permissionAsks: [{ requestId: 4, tool: "Read", paths: ["/etc/passwd"] }] }], monos: [], rooms: [], dom: { elements: [] } };
      return { ok: true };
    },
    events: [], evidence: dir, project: dir, log: () => {}, pump: async () => {}, usage: () => ({ turns: 0, requests: 0 }),
    claudeTexts: async () => [], delegationRows: async () => [], monoSession: async () => null, sessionBlocks: async () => [],
    leadId: "tally-lead", roomId: "tally:leadership", spec: { project: { id: "tally" }, leak: [] }, deadline: Date.now() + 60_000,
    state: dir, team: [], home: "/tmp/bench-home", dataDir: "/tmp/bench-data", copies: [],
  }, { tester, judge, agentsReal: false, out: dir, rubric: "" });
  assert.equal(result.verdict, "stuck on a permission ask: /etc/passwd");
  assert.notEqual(result.verdict, "FAIL");
  const evidence = JSON.parse(fs.readFileSync(path.join(dir, "P1", "evidence.json"), "utf8"));
  assert.equal(evidence.permissionAnswers[0].path, "/etc/passwd");
  assert.equal(evidence.permissionAnswers[0].decision, "refuse");
  assert.match(fs.readFileSync(path.join(dir, "P1", "transcript.md"), "utf8"), /permission refuse: \/etc\/passwd/);
  const quiet = JSON.parse(fs.readFileSync(path.join(dir, "P1", "evidence.json"), "utf8"));
  assert.deepEqual(quiet.agents, []);
});

test("an unsandboxed agent that exists only between the scene's start and end is caught, and its pid is in the evidence", async () => {
  const { runConversation } = await import("./realconv/player.mjs");
  const dir = tmp();
  const clean = "  100 1 /bin/sleep 1\n";
  const dirty = "  100 1 /bin/sleep 1\n  240 100 /opt/homebrew/bin/codex\n";
  // The scene's own start check takes the first frame. The poll then takes a start frame, the middle frame, and must not need the end frame.
  const frames = [clean, clean, dirty, clean];
  let n = 0;
  let release = () => {};
  const stopped = [];
  const judge = makeClient({ provider: "fake", model: "fake" }, { script: () => JSON.stringify({ grade: "FAIL", replies: [], realConversation: false, summary: "no reply", sceneChecks: [], autoFails: [] }) });
  const tester = makeClient({ provider: "fake", model: "fake" }, { script: () => '{"action":"done"}' });
  const scene = { id: "P2", title: "a cli that slipped out", card: "Ash asks for a file.", place: { room: "room" }, opening: "echo hi", minutes: 0, quietSec: 0, expect: {} };
  const result = await runConversation(scene, {
    act: async (op) => {
      if (op === "send") {
        release();
        await new Promise((resolve) => setImmediate(resolve));
        return { ok: true, at: Date.now(), room: "tally:leadership" };
      }
      if (op === "snapshot") return { ok: true, sessions: [], monos: [], rooms: [], dom: { elements: [] } };
      return { ok: true };
    },
    events: [], evidence: dir, project: dir, log: () => {}, pump: async () => {}, usage: () => ({ turns: 0, requests: 0 }),
    claudeTexts: async () => [], delegationRows: async () => [], monoSession: async () => null, sessionBlocks: async () => [],
    leadId: "tally-lead", roomId: "tally:leadership", spec: { project: { id: "tally" }, leak: [] }, deadline: Date.now() + 60_000,
    state: dir, team: [], home: "/tmp/bench-home", dataDir: "/tmp/bench-data", copies: [],
    listAgents: () => frames[Math.min(n++, frames.length - 1)],
    agentWatch: () => ({ rootPid: 100, wrapper: "/private/var/bench/bin/claude", sandboxOf: (pids) => ({ ok: true, byPid: new Map(pids.map((pid) => [pid, 0])) }) }),
    agentPollSleep: () => new Promise((resolve) => { release = resolve; }),
    agentPollNow: () => 1_700_000_000_000,
    stopRun: (why) => stopped.push(why),
  }, { tester, judge, agentsReal: false, out: dir, rubric: "" });
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.reasons[0], "unsandboxed agent: codex");
  assert.deepEqual(stopped, ["unsandboxed agent: codex"]);
  assert.equal(n, 3);
  assert.deepEqual(result.agents.map(({ pid, command, name, firstSeen, kernel }) => ({ pid, command, name, firstSeen, kernel })), [
    { pid: 240, command: "/opt/homebrew/bin/codex", name: "codex", firstSeen: 1_700_000_000_000, kernel: 0 },
  ]);
  const evidence = JSON.parse(fs.readFileSync(path.join(dir, "P2", "evidence.json"), "utf8"));
  assert.equal(evidence.agents[0].pid, 240);
  assert.equal(evidence.agents[0].kernel, 0);
});

test("a named cli is not a pass unless the plan refused it or the kernel answered 1", async () => {
  const { runConversation } = await import("./realconv/player.mjs");
  const { writeReport } = await import("./realconv/report.mjs");
  const dir = tmp();
  const refusal = "This bench only starts the run's own Claude wrapper. It won't start codex.";
  const scene = {
    id: "P3",
    title: "prove the named clis",
    card: "Name the clis.",
    place: { room: "room" },
    opening: "echo hi",
    minutes: 0,
    quietSec: 0,
    expect: {},
    canaryClis: ["codex", "grok", "hermes", "claude"],
  };
  const passing = {
    grade: "PASS",
    replies: [{ at: "+1s", who: "chat", answers: 2, adds: 2, disagrees: null, honest: 2, voice: 2, note: "said it" }],
    sceneChecks: [],
    autoFails: [],
    realConversation: true,
    triggered: true,
    summary: "it answered",
    problems: [],
  };
  const judge = makeClient({ provider: "fake", model: "fake" }, { script: () => JSON.stringify(passing) });
  const tester = makeClient({ provider: "fake", model: "fake" }, { script: () => '{"action":"done"}' });
  const result = await runConversation(scene, {
    act: async (op) => {
      if (op === "send") return { ok: true, at: Date.now(), room: "tally:leadership" };
      if (op === "snapshot") return { ok: true, sessions: [], monos: [], rooms: [], dom: { elements: [] } };
      return { ok: true };
    },
    events: [], evidence: dir, project: dir, log: () => {}, pump: async () => {}, usage: () => ({ turns: 0, requests: 0 }),
    claudeTexts: async () => [{ session: "chat-1", text: refusal, t: Date.now() }],
    delegationRows: async () => [], monoSession: async () => null, sessionBlocks: async () => [],
    leadId: "tally-lead", roomId: "tally:leadership", spec: { project: { id: "tally" }, leak: [] }, deadline: Date.now() + 60_000,
    state: dir, team: [], home: "/tmp/bench-home", dataDir: "/tmp/bench-data", copies: [],
  }, { tester, judge, agentsReal: false, out: dir, rubric: "" });
  assert.notEqual(result.verdict, "PASS");
  assert.equal(result.wouldBe, "NOT PROVEN");
  assert.match(result.reasons[0], /not proven: grok, hermes, claude/);
  assert.deepEqual(result.canary.map((row) => [row.cli, row.verdict, row.why]), [
    ["codex", "PASS", "the plan gate refused the start"],
    ["grok", "NOT PROVEN", "neither a plan refusal nor a sandboxed process was seen"],
    ["hermes", "NOT PROVEN", "neither a plan refusal nor a sandboxed process was seen"],
    ["claude", "NOT PROVEN", "neither a plan refusal nor a sandboxed process was seen"],
  ]);
  const evidence = JSON.parse(fs.readFileSync(path.join(dir, "P3", "evidence.json"), "utf8"));
  assert.equal(evidence.canary[0].cli, "codex");
  assert.equal(evidence.canary[0].verdict, "PASS");
  const transcript = fs.readFileSync(path.join(dir, "P3", "transcript.md"), "utf8");
  assert.match(transcript, /## Canary/);
  assert.match(transcript, /\| codex \| PASS \| the plan gate refused the start \|/);
  assert.match(transcript, /\| hermes \| NOT PROVEN \|/);
  const report = writeReport(dir, [{ ...result, id: "P3" }], { runId: "t", started: "t", agents: { real: false, model: "fake" }, tester: { real: false, provider: "fake", model: "fake" }, judge: { real: false, provider: "fake", model: "fake" } });
  const md = fs.readFileSync(report, "utf8");
  assert.match(md, /NOT-REAL \(no real model\) \(scored as NOT PROVEN\)/);
  assert.match(md, /\| hermes \| NOT PROVEN \| neither a plan refusal nor a sandboxed process was seen \|/);
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
  // A handoff that settled moments ago still holds the scene open for the report-back; two minutes later it doesn't.
  const done = { state: "completed", created_at: "2026-10-21T11:20:00Z", settled_at: "2026-10-21T11:40:00Z" };
  assert.equal(handoffsOpen([done], t0, Date.parse("2026-10-21T11:40:30Z")), true);
  assert.equal(handoffsOpen([done], t0, Date.parse("2026-10-21T11:42:30Z")), false);
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

test("the hub's turn checkpoints don't count as changes to a copy (AD9F listed every Hivra file for a scene that touched none)", async () => {
  const { gitMark, gitChanges, copyLog } = await import("./realconv/player.mjs");
  const dir = tmp();
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  const mark = gitMark(dir);
  // what the hub does each turn: a parentless commit of the whole tree under refs/monocode/checkpoints/
  const snap = git("commit-tree", git("write-tree"), "-m", "MonoCode workspace checkpoint");
  git("update-ref", "refs/monocode/checkpoints/s1/t1/before", snap);
  assert.deepEqual(gitChanges(dir, mark).changed, []);
  assert.deepEqual(copyLog(dir, mark).commits, []);
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  git("add", "b.txt");
  git("commit", "-qm", "real work");
  assert.deepEqual(gitChanges(dir, mark).changed, ["b.txt"]);
  assert.equal(copyLog(dir, mark).commits.length, 1);
});

test("the tester gets the screen's buttons when a chat is held on Ash, not only in click scenes (AD14 run f451: 'there's no button to click')", async () => {
  const { shouldOfferButtons } = await import("./realconv/player.mjs");
  assert.equal(shouldOfferButtons({}, { busy: "", stuck: "" }), false);
  assert.equal(shouldOfferButtons({}, { busy: "", stuck: "Hivra chat" }), true);
  assert.equal(shouldOfferButtons({ clicks: true }, { busy: "", stuck: "" }), true);
});

test("a chat's approval card in the screen text counts as shown to Ash; his own 'this looks stuck' doesn't", async () => {
  const { heldCardLines } = await import("./realconv/player.mjs");
  assert.deepEqual(heldCardLines("progeress? this looks stuck\nI'll pull the git history.\nWaiting for approval\nAllow\nDeny"), ["Waiting for approval", "Allow", "Deny"]);
  assert.deepEqual(heldCardLines("progeress? this looks stuck\nwe should allow more time"), []);
  assert.deepEqual(heldCardLines(undefined), []);
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

test("the bench never lets Ash allow a GitHub, push, remote or credential command (run 08f7, AD14 held gh pr list)", async () => {
  const { riskyAllow } = await import("./realconv/player.mjs");
  const held = [{ session: "s1", tools: ["Read", "Bash: git log --oneline && gh pr list --state open"] }];
  assert.match(riskyAllow("Allow", held, "s1"), /gh pr list/);
  assert.match(riskyAllow("Always allow", held, "s1"), /gh pr list/);
  assert.equal(riskyAllow("Deny", held, "s1"), null);
  assert.equal(riskyAllow("Allow", held, "other"), null);
  for (const cmd of ["git push origin main", "git remote add up x", "security find-generic-password -s x", "git credential fill", "git commit --no-verify -m x"])
    assert.ok(riskyAllow("Allow", [{ session: "s", tools: [`Bash: ${cmd}`] }], "s"), cmd);
  for (const cmd of ["git log --oneline", "npm test", "git status && git diff"])
    assert.equal(riskyAllow("Allow", [{ session: "s", tools: [`Bash: ${cmd}`] }], "s"), null, cmd);
});


// "we said fridays for the review right?" is a test line written in Ash's style, not something Ash said.
test("memory guard (S18/S19): a question saved or summarised as a decision fails; kept as asked passes", async () => {
  const { memoryGuard } = await import("./realconv/checks.mjs");
  const question = "we said fridays for the review right?";
  const run = (memory, toAsh, guard = { about: "friday", question, longChat: true }) => {
    const out = { autoFails: [], misses: [], facts: {} };
    memoryGuard(guard, memory, toAsh, out);
    return out;
  };
  const reply = [{ t: 1, who: "tally-lead", where: "chat", text: "I have nothing on file about Fridays. Want me to save Fridays as the review day?" }];
  const tree = (nodes) => ({ messages: [{ kind: "user", text: question, i: 0 }], nodes });
  const clean = run({ memory: "", topics: [], tree: tree([{ l: 1, i: 0, text: `user: "${question}" mono: nothing on file; asked to save Fridays.` }]) }, reply);
  assert.deepEqual([clean.autoFails, clean.misses], [[], []]);
  const saved = run({ memory: "- 2026-10-21 · Reviews are on Fridays\n", topics: [], tree: tree([]) }, reply);
  assert.equal(saved.autoFails[0].check, "question-saved-as-decision");
  const drifted = run({ memory: "", topics: [], tree: tree([{ l: 2, i: 0, text: "user: decided reviews happen on Fridays. mono: noted." }]) }, reply);
  assert.equal(drifted.autoFails[0].check, "tree-question-became-decision");
  const noTree = run({ memory: "", topics: [], tree: null }, reply);
  assert.match(noTree.misses[0], /no tree/);
  const normal = run({ memory: "", topics: [], tree: null }, reply, { about: "friday", question });
  assert.deepEqual([normal.autoFails, normal.misses], [[], []]);
  const agreed = run({ memory: "", topics: [], tree: null }, [{ t: 1, who: "tally-lead", where: "chat", text: "Yes, Fridays." }], { about: "friday", question });
  assert.match(agreed.misses[0], /doesn't ask/);
});
