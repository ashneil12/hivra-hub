#!/usr/bin/env node
// Real conversations with the hub (docs/REALCONV.md). Alfred's scenes (tests/realconv/scenes.json, from
// real-conversation-tests.md), played against the REAL hub: the realtest bench's dev copy under a temporary HOME
// (scripts/hub-realtest.mjs: real Monos, the real leadership room, real coding-team and Claude Code chats on the Tally
// test project), with a tester model playing Ash in his own voice (tests/realconv/ash-voice.md) and a judge model
// scoring each scene with Alfred's rubric. Hard checks read the hub's own state (scripts/realconv/checks.mjs) and fail a
// scene whatever the judge says. A scene only counts as passed when a real model ran the agents, Ash and the judge.
//
//   npm run hub:realconv -- --scenes S10,S5,S14
//   npm run hub:realconv -- --scenes S5 --tester xai --tester-model grok-4 --tester-key-env XAI_API_KEY \
//                           --judge deepseek --judge-model deepseek-chat --judge-key-env DEEPSEEK_API_KEY
//   npm run hub:realconv -- --scenes S10 --agents custom:grok --custom-model ~/grok-model.json
//   npm run hub:realconv -- --scenes S10,S5,S14 --agents deepseek-sub  # everything on DeepSeek V4.1 Flash (local gateway)
//   npm run hub:realconv -- --list          # the scenes and which can run
//   npm run hub:realconv -- --dry-run ...   # check the options and print the plan; nothing starts
//
// Defaults (Ash, 27 Oct: no test or run may use his Claude subscription): agents, tester and judge on deepseek-sub.
// Claude runs only when someone names it (`--agents claude:<model>`, `--tester claude`, `--judge claude`). Keys: only
// from a variable Ash names with --*-key-env, never found on their own.

import fs from "node:fs";
import path from "node:path";

import { ROOT, isMain, readJson } from "./hub-dev.mjs";
import { claudeConfigArgs } from "./hub-realtest-accounts.mjs";
import { makeClient, providerSpec } from "./realconv/llm.mjs";

export const SCENES_FILE = path.join(ROOT, "tests/realconv/scenes.json");

export function parseArgs(argv, env = process.env) {
  const value = (flag, fallback = null) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : fallback;
  };
  const llm = (who, fallbackProvider) => ({
    provider: value(`--${who}`, fallbackProvider),
    model: value(`--${who}-model`),
    baseUrl: value(`--${who}-base-url`),
    keyEnv: value(`--${who}-key-env`),
    effort: value(`--${who}-effort`),
  });
  const agents = value("--agents", "deepseek-sub");
  if (!/^(claude:[\w.-]+|custom:[\w.-]+|deepseek-sub|haiku-test|grok-sub)$/.test(agents)) throw new Error(`--agents is claude:<model> or custom:<id> (or deepseek-sub, haiku-test, grok-sub), not "${agents}"`);
  // The tester and judge stay on DeepSeek unless named; never Claude by default, even with Claude agents.
  const llmDefault = "deepseek-sub";
  return {
    scenes: value("--scenes", "S10,S5,S14").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    agents,
    customModel: value("--custom-model"),
    tester: llm("tester", llmDefault),
    judge: llm("judge", llmDefault),
    out: value("--out"),
    scenesFile: path.resolve(value("--scenes-file", SCENES_FILE)),
    list: argv.includes("--list"),
    dryRun: argv.includes("--dry-run"),
    build: !argv.includes("--no-build"),
    keep: argv.includes("--keep"),
    // More Claude accounts Ash signed in himself, for the app's helper calls (E5; hub-realtest-accounts.mjs).
    claudeConfigs: claudeConfigArgs(argv),
    slot: value("--slot", `${path.basename(ROOT)}-realconv`),
    maxMinutes: Number(value("--max-minutes", "0")) || null,
    maxTurns: Number(value("--max-turns", "0")) || null,
    env,
  };
}

/** The custom model's metadata from Ash's file: what the hub's own export holds (never a key). */
export function readCustomModel(file, id) {
  if (!file) throw new Error(`--agents custom:${id} needs --custom-model <file.json> with the model's settings (name, provider, baseUrl, modelId), as the hub's setup export has them`);
  const raw = readJson(path.resolve(file.replace(/^~(?=\/)/, process.env.HOME ?? "~")));
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.customModels) ? raw.customModels : [raw];
  const model = list.find((m) => m?.id === id) ?? (list.length === 1 ? { ...list[0], id } : null);
  if (!model) throw new Error(`no custom model "${id}" in ${file}`);
  const keyish = Object.keys(model).filter((k) => /key|token|secret|password/i.test(k));
  if (keyish.length) throw new Error(`${file} has ${keyish.join(", ")}: the runner never takes a key. Save the key in a dev copy's Other models (the Keychain item monocode-hub-dev:model-key) and leave it out of the file`);
  for (const field of ["name", "provider", "baseUrl", "modelId"]) if (typeof model[field] !== "string" || !model[field]) throw new Error(`${file}: the model needs "${field}"`);
  const { id: _, name, provider, baseUrl, modelId, reasoningEfforts } = model;
  return { id, name, provider, baseUrl, modelId, ...(Array.isArray(reasoningEfforts) ? { reasoningEfforts } : {}) };
}

/** Which scenes run, and why the rest don't. */
export function pickScenes(book, ids) {
  const known = new Map(book.scenes.map((s) => [s.id, s]));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`no scene ${unknown.join(", ")} (there are ${[...known.keys()].join(", ")})`);
  const run = [];
  const skipped = [];
  for (const id of ids) {
    const scene = known.get(id);
    if (scene.runnable === false) skipped.push({ id, title: scene.title, verdict: "SKIPPED", reasons: [scene.why] });
    else run.push(scene);
  }
  return { run, skipped };
}

/** The bench's spec for this run: the scene book's project and memory, the agents' model, a budget sized to the scenes. */
export function benchSpec(book, scenes, options) {
  const claudeModel = options.agents.startsWith("claude:") ? options.agents.slice(7) : null;
  const minutes = scenes.reduce((sum, s) => sum + (s.minutes ?? 12), 0) + 8;
  return {
    version: 1,
    about: book.about,
    project: book.project,
    team: book.team ?? "ash",
    copies: book.copies ?? [],
    memory: book.memory,
    leak: book.leak,
    // The wrapper holds Claude chats to this alias (sonnet unless Ash asked for another); routed chats are left alone.
    model: claudeModel ? claudeModel.split("-")[0] : book.model ?? "sonnet",
    // On a gateway launcher the app keeps its Claude default; the bench's wrapper sends every call to the launcher.
    appModel: options.agents === "deepseek-sub" || options.agents === "grok-sub" ? "claude:sonnet-5" : options.agents === "haiku-test" ? "claude:haiku-4.5" : options.agents,
    effort: book.effort ?? "medium",
    budget: { ...book.budget, maxMinutes: options.maxMinutes ?? Math.min(book.budget?.maxMinutes ?? 100, minutes) },
    scenarios: [],
  };
}

/** What realconv asks the realtest bench to run. Grok is its own launcher, not DeepSeek. */
export function benchRunOptions(options) {
  return {
    build: options.build,
    keep: options.keep,
    grade: false,
    slot: options.slot,
    maxTurns: options.maxTurns,
    maxMinutes: options.maxMinutes,
    maxRequests: null,
    only: [],
    claudeConfigs: options.claudeConfigs ?? [],
    deepseekSub: options.agents === "deepseek-sub",
    grokSub: options.agents === "grok-sub",
    ...(options.agents === "haiku-test" ? { haikuTest: true } : {}),
  };
}

export async function runRealconv(options, { bench, clients } = {}) {
  const book = readJson(options.scenesFile ?? SCENES_FILE);
  if (options.list) {
    for (const s of book.scenes) console.log(`${s.id.padEnd(4)} ${s.runnable === false ? "(can't run yet) " : ""}${s.title}`);
    return { code: 0 };
  }
  const { run, skipped } = pickScenes(book, options.scenes);
  const testerSpec = providerSpec(options.tester, options.env);
  const judgeSpec = providerSpec(options.judge, options.env);
  const custom = options.agents.startsWith("custom:") ? readCustomModel(options.customModel, options.agents.slice(7)) : null;
  const spec = benchSpec(book, run, options);
  const plan = {
    scenes: run.map((s) => s.id),
    skipped: skipped.map((s) => `${s.id}: ${s.reasons[0]}`),
    agents: custom
      ? `${options.agents} (${custom.provider} ${custom.modelId} through the hub's router)`
      : options.agents === "deepseek-sub"
        ? "deepseek-sub (Claude Code on DeepSeek V4.1 Flash through the local gateway)"
        : options.agents === "grok-sub"
          ? "grok-sub (Claude Code on Grok through the local gateway; the tester and the judge stay on DeepSeek)"
          : options.agents,
    tester: `${testerSpec.provider}/${testerSpec.model}${testerSpec.keyEnv ? ` (key from $${testerSpec.keyEnv})` : ""}`,
    judge: `${judgeSpec.provider}/${judgeSpec.model}${judgeSpec.keyEnv ? ` (key from $${judgeSpec.keyEnv})` : ""}`,
    budget: spec.budget,
  };
  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return { code: 0, plan };
  }
  const tester = clients?.tester ?? makeClient(testerSpec, { env: options.env });
  const judge = clients?.judge ?? makeClient(judgeSpec, { env: options.env });
  const agentsReal = clients?.agentsReal ?? true;
  const started = new Date().toISOString();
  const { runConversation } = await import("./realconv/player.mjs");
  const { writeReport } = await import("./realconv/report.mjs");
  const runBench = bench ?? (await import("./hub-realtest.mjs")).runBench;
  let out = null;
  const outcome = await runBench(
    benchRunOptions(options),
    {
      spec,
      label: "realconv",
      evidenceDir: options.out ?? "evidence/realconv",
      routedAgents: !!custom,
      async beforeReady({ act, log }) {
        // The scenes play Ash's own Monos: a fresh dev copy starts with no team (WP-05), so pick his pre-load and seat
        // it in this project's room before the bench waits. Returning it keeps the bench from loading the team twice.
        if ((book.team ?? "ash") !== "ash") return null;
        const team = await act("teamPack", { pack: "ash", project: spec.project.id });
        if (!team.ok) throw new Error(`the hub wouldn't pre-load Ash's team: ${team.error ?? team.pack}`);
        const names = (team.monos ?? []).map((mono) => mono.name).filter(Boolean).join(", ");
        log(`team: Ash's pre-load (${names || "none"}; souls written: ${(team.wrote ?? []).join(", ") || "none"})`);
        return team;
      },
      async afterReady(ctx) {
        out = ctx.evidence;
        fs.writeFileSync(path.join(out, "realconv-plan.json"), JSON.stringify(plan, null, 2));
        if (!custom) return;
        const added = await ctx.act("customModel", { model: custom });
        if (!added.ok) throw new Error(`the hub wouldn't take the custom model: ${added.error ?? added.skipped?.join("; ") ?? "?"}`);
        await ctx.act("defaults", { model: options.agents, effort: spec.effort });
        ctx.log(`agents on ${options.agents}: ${custom.provider} ${custom.modelId}, levels ${added.model.efforts.join("/") || "none"}`);
      },
      async play(ctx, { runScenario, stopped }) {
        out = ctx.evidence;
        const results = [];
        for (const scene of run) {
          if (stopped()) {
            results.push({ id: scene.id, title: scene.title, verdict: "SKIPPED", reasons: [stopped()] });
            continue;
          }
          ctx.log(`== ${scene.id}: ${scene.title}`);
          try {
            results.push(await runConversation(scene, ctx, { tester, judge, agentsReal, out, rubric: book.judgeRubric, runScenario }));
          } catch (error) {
            ctx.log(`${scene.id} failed to run: ${error.stack ?? error.message}`);
            results.push({ id: scene.id, title: scene.title, verdict: "ERROR", reasons: [error.message] });
          }
        }
        return results;
      },
    },
  );
  const results = [...(outcome.results ?? []), ...skipped];
  const report = writeReport(outcome.evidence ?? out, results, {
    runId: outcome.id,
    started,
    stopReason: outcome.stopReason,
    agents: { model: options.agents, real: agentsReal },
    tester: { provider: tester.provider, model: tester.model, real: tester.real },
    judge: { provider: judge.provider, model: judge.model, real: judge.real },
  });
  console.log(`report: ${path.relative(process.cwd(), report)}`);
  return { code: results.every((r) => r.verdict === "PASS" || r.verdict === "SKIPPED") ? 0 : 1, report, results };
}

if (isMain(import.meta.url)) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    const { code } = await runRealconv(options);
    process.exit(code);
  })().catch((error) => {
    console.error(`hub:realconv: ${error.message}`);
    process.exit(2);
  });
}
