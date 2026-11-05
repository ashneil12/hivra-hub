// The real-Claude bench's grader (scripts/hub-realtest.mjs, docs/REALTEST.md). Each scenario's transcript.md (what Ash
// sent, every room message and chat reply with times, delegation rows, the views) plus its rule metrics go to Sonnet at
// medium effort, with the benchmark items the scenario covers; it answers PASS / PARTIAL / FAIL / NOT-TRIGGERED per item
// with the evidence quoted. The rule metrics (timings, counts) are computed by the player, not the model, and are
// written next to the model's grade so a reader can check one against the other. report.md puts it all together.
//
//   node scripts/hub-realtest-grade.mjs evidence/realtest/<run>      # grade a finished run (again), on DeepSeek
//   node scripts/hub-realtest-grade.mjs evidence/realtest/<run> --agents claude   # on Claude, only if named
//
// The grader runs where the bench's agents ran (hub-realtest.mjs graderVia): DeepSeek by default, never Claude unless named.

import { asksSection } from "./hub-realtest-asks.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
export const BENCHMARK = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/realtest/benchmark.json"), "utf8"));

export const SYSTEM = `You grade one scenario of a real end-to-end test of "MonoCode Hub", an app where AI agents (Monos) work for one person, Ash.
Ash has a leadership room. Its seats are ordinary Monos: Coordinator (older notes say Chief of Staff), Planner (Projects Manager), Record keeper (frank), Team steward (Alfred) and Design review (Critiquito). A project Lead per project (here "tally-lead"), a coding team per project (chats Ash starts in the project's code folder, each an orchestrator like the Lead, shown as "coding-team chat"), and temporary workers the Lead or a coding-team chat delegates to.
You get: the benchmark items this scenario covers (Ash's own standard, from a team he liked), the scenario's intent, a timeline (times are seconds after the scenario started; "Ash ->" lines are what the test sent as Ash), delegation rows, what the app's views showed, and metrics computed by the test (trust these numbers).
Grade each item strictly against what the timeline shows, never against what an agent claims. Use:
- PASS: the item's behaviour clearly happened, within its time limit.
- PARTIAL: some of it happened, or late, or with a real flaw.
- FAIL: it did not happen, or the opposite happened.
- NOT-TRIGGERED: the situation the item needs never arose in this scenario (say why), so it can't be judged.
Quote the evidence verbatim (short, with its +Ns time). Name concrete problems a developer could fix (what was seen, where).
Answer with ONE JSON object and nothing else:
{"grade":"PASS|PARTIAL|FAIL|NOT-TRIGGERED","items":[{"item":"<id>","grade":"...","why":"<one or two sentences>","evidence":["+12s ..."]}],"summary":"<two sentences>","problems":["<one line each>"]}
A status count line follows Ash's rule (h): it leaves out a bucket that is empty, so never mark a run down for omitting "running" (or any other bucket) when nothing is in it; check only that the numbers it gives add up to the total and match the evidence. (r101: our bench grader, changed to agree with rule h.)
The scenario's overall grade is the worst grade among items that were triggered.`;

function benchText(ids) {
  return ids
    .map((id) => {
      const item = BENCHMARK.items[id];
      return item ? `- ${id}: ${item}` : `- ${id}: (unknown item)`;
    })
    .join("\n");
}

/** One JSON object out of the model's answer (it is asked for nothing else; tolerate a code fence). */
export function parseGrade(text) {
  // The grader runs with --output-format json (r72: on the Grok bridge, plain -p text came back empty after a long think
  // while the JSON envelope still carried the answer), so read the envelope's result first, then the raw text.
  try {
    const envelope = JSON.parse(text);
    if (envelope && typeof envelope.result === "string" && !("grade" in envelope)) return parseGrade(envelope.result);
  } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** What the grader said when no grade came back: the JSON envelope's result (or error), else its raw text. */
function graderSays(stdout = "") {
  try {
    const envelope = JSON.parse(stdout);
    return String(envelope.result || envelope.error || envelope.subtype || "");
  } catch {
    return stdout;
  }
}

export const BLOCKED_BEFORE_QUESTION = "BLOCKED-BEFORE-QUESTION";

/**
 * r102 (6): a run whose Quit was refused because a chat was still running at the cap never reached Ash's question, so
 * it counts neither way: BLOCKED-BEFORE-QUESTION, not PARTIAL, and no grader call.
 */
export function blockedGrade(evidence) {
  if (!evidence?.blockedBeforeQuestion) return null;
  return {
    grade: BLOCKED_BEFORE_QUESTION,
    items: [],
    summary: `Not graded: ${evidence.blockedBeforeQuestion}. It counts neither for nor against.`,
    problems: [],
    grader: { model: "none", effort: "none", exit: 0 },
  };
}

export function gradeScenario(dir, { claudeConfig, claude = path.join(os.homedir(), ".local/bin/claude"), model = "sonnet", effort = "medium" } = {}) {
  const evidence = JSON.parse(fs.readFileSync(path.join(dir, "evidence.json"), "utf8"));
  const blocked = blockedGrade(evidence);
  if (blocked) {
    fs.writeFileSync(path.join(dir, "grade.json"), JSON.stringify(blocked, null, 2));
    return blocked;
  }
  let transcript = fs.readFileSync(path.join(dir, "transcript.md"), "utf8");
  if (transcript.length > 90_000) transcript = `${transcript.slice(0, 60_000)}\n\n[... cut ...]\n\n${transcript.slice(-28_000)}`;
  const prompt = [
    "## Benchmark items for this scenario",
    benchText([...new Set([...(evidence.bench ?? []), ...(BENCHMARK.always ?? [])])]),
    "",
    transcript,
  ].join("\n");
  const ask = (input) =>
    spawnSync(
    claude,
    ["-p", "--model", model, "--effort", effort, "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "user", "--no-session-persistence", "--output-format", "json", "--system-prompt", SYSTEM],
    {
      input,
      encoding: "utf8",
      cwd: dir,
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfig, CLAUDE_SECURESTORAGE_CONFIG_DIR: claudeConfig, DISABLE_AUTOUPDATER: "1" },
    },
  );
  // Grok sometimes answers a tool-less grading prompt with "I'll check the repo..." and stops; ask once more, plainly.
  let run = ask(prompt);
  if (!parseGrade(run.stdout ?? "") && run.status === 0) run = ask(`${prompt}\n\n## Note\nYou have no tools and cannot check anything else. Grade from this evidence alone and reply with only the JSON object now.`);
  const parsed = parseGrade(run.stdout ?? "");
  if (!parsed) fs.writeFileSync(path.join(dir, "grade.raw.txt"), `${run.stdout ?? ""}\n--- stderr ---\n${run.stderr ?? ""}`);
  const grade = parsed ?? { grade: "UNGRADED", summary: `grader failed: ${(graderSays(run.stdout) || run.stderr || "").slice(0, 300)}`, items: [], problems: [] };
  grade.grader = { model, effort, exit: run.status };
  fs.writeFileSync(path.join(dir, "grade.json"), JSON.stringify(grade, null, 2));
  return grade;
}

export async function gradeRun(evidenceDir, { claudeConfig, claude, model }) {
  const scenariosDir = path.join(evidenceDir, "scenarios");
  const summary = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(evidenceDir, "summary.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  const ids = fs.existsSync(scenariosDir) ? fs.readdirSync(scenariosDir).filter((name) => fs.existsSync(path.join(scenariosDir, name, "evidence.json"))).sort() : [];
  const grades = {};
  for (const id of ids) {
    console.log(`[realtest grade] ${id} ...`);
    grades[id] = gradeScenario(path.join(scenariosDir, id), { claudeConfig, ...(claude ? { claude } : {}), ...(model ? { model } : {}) });
    console.log(`[realtest grade] ${id}: ${grades[id].grade}`);
  }
  fs.writeFileSync(path.join(evidenceDir, "grades.json"), JSON.stringify(grades, null, 2));
  fs.writeFileSync(path.join(evidenceDir, "report.md"), report(evidenceDir, summary, grades));
  console.log(`[realtest grade] report: ${path.relative(ROOT, path.join(evidenceDir, "report.md"))}`);
  return 0;
}

const pct = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

/**
 * Where the time goes, from the wrapper's per-process logs: each helper call (the room's router picking who answers,
 * its chime-in pick, chat titles) from spawn to the end of its answer (its `result`, or the model's end_turn: the app
 * takes the answer there and stops the process), with the wait before the app even sent the prompt; and each room turn
 * (a Mono's "[MonoCode room]" prompt, "[MonoCode group chat]" before 20 Oct) from prompt to result.
 */
export function latency(evidenceDir) {
  const dir = path.join(evidenceDir, "claude", "claude");
  const helpers = [];
  const roomTurns = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".ndjson")) : []) {
    const entries = fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const start = entries.find((e) => e.dir === "start");
    if (!start) continue;
    const helper = (start.args ?? []).includes("--no-session-persistence");
    let prompt = null;
    for (const entry of entries) {
      if (entry.dir === "prompt") prompt = entry;
      if (entry.dir !== "out" || !prompt) continue;
      let message;
      try {
        message = JSON.parse(entry.line);
      } catch {
        continue;
      }
      const ended = message.type === "stream_event" && !message.parent_tool_use_id && message.event?.type === "message_delta" && message.event?.delta?.stop_reason === "end_turn";
      if (message.type !== "result" && !(helper && ended)) continue;
      const text = prompt.text ?? "";
      if (helper) {
        const kind = /route a message in a group chat to the ONE member/i.test(text) ? "router-pick" : /"chime"/.test(text) || /chime/i.test(text.slice(0, 400)) ? "router-chime" : /title/i.test(text.slice(0, 300)) ? "title" : "other";
        helpers.push({ kind, waitBeforePromptSec: (prompt.t - start.t) / 1000, totalSec: (entry.t - start.t) / 1000 });
      } else if (text.includes("[MonoCode room]") || text.includes("[MonoCode group chat]")) roomTurns.push({ turnSec: (entry.t - prompt.t) / 1000 });
      prompt = null;
    }
  }
  const sum = (rows, key) => ({ n: rows.length, median: pct(rows.map((r) => r[key]), 50), p90: pct(rows.map((r) => r[key]), 90), max: rows.length ? Math.max(...rows.map((r) => r[key])) : null });
  const kinds = [...new Set(helpers.map((h) => h.kind))];
  return {
    helpers: Object.fromEntries(kinds.map((kind) => {
      const rows = helpers.filter((h) => h.kind === kind);
      return [kind, { total: sum(rows, "totalSec"), waitBeforePrompt: sum(rows, "waitBeforePromptSec"), over20s: rows.filter((r) => r.totalSec > 20).length }];
    })),
    roomTurns: sum(roomTurns, "turnSec"),
  };
}

export function report(evidenceDir, summary, grades) {
  const lines = ["# Real-Claude test run", ""];
  if (summary)
    lines.push(
      `Run ${summary.runId}, build ${summary.build}, ${Math.round(summary.wallMinutes)} min wall, ${summary.usage.turns} model turns (${summary.usage.requests} model requests, ${summary.usage.helperTurns} helper calls), models ${summary.usage.models.join(", ")}.`,
      "",
    );
  lines.push("| Scenario | Grade | Benchmark | Key timings | Summary |", "| --- | --- | --- | --- | --- |");
  const results = summary?.results ?? Object.keys(grades).map((id) => ({ id }));
  for (const result of results) {
    const grade = grades[result.id];
    const timings = (result.metrics?.replies ?? [])
      .map((r) => `${r.label ?? r.to}: ${r.firstWordsSec != null && r.firstWordsSec < r.firstReplySec ? `words ${r.firstWordsSec}s, ` : ""}${r.firstReplySec}s${r.from ? ` (${r.from})` : ""}`)
      .join("; ");
    lines.push(
      `| ${result.id} ${result.title ?? ""} | ${result.skipped ? `SKIPPED (${result.skipped})` : result.error ? `ERROR (${result.error})` : (grade?.grade ?? "UNGRADED")} | ${(result.bench ?? []).join(", ")} | ${timings || "-"} | ${(grade?.summary ?? "").replace(/\|/g, "/").replace(/\n/g, " ")} |`,
    );
  }
  const timing = latency(evidenceDir);
  lines.push("", "## Where the time goes", "", "```json", JSON.stringify(timing, null, 2), "```");
  fs.writeFileSync(path.join(evidenceDir, "latency.json"), JSON.stringify(timing, null, 2));
  lines.push("", "## Per item", "");
  for (const [id, grade] of Object.entries(grades)) {
    lines.push(`### ${id}: ${grade.grade}`, "");
    for (const item of grade.items ?? []) lines.push(`- **${item.item}** ${item.grade}: ${item.why}${item.evidence?.length ? ` Evidence: ${item.evidence.map((e) => `"${e}"`).join("; ")}` : ""}`);
    if (grade.problems?.length) lines.push("", "Problems:", ...grade.problems.map((p) => `- ${p}`));
    lines.push("");
    // r100: each ask by number with its state, and rendered chat vs raw transcript (report only, not the grade).
    try {
      const dir = path.join(evidenceDir, "scenarios", id);
      const evidence = JSON.parse(fs.readFileSync(path.join(dir, "evidence.json"), "utf8"));
      lines.push(...asksSection(evidence, fs.readFileSync(path.join(dir, "transcript.md"), "utf8")));
    } catch {
      // no evidence for this scenario
    }
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/hub-realtest-grade.mjs evidence/realtest/<run>");
    process.exit(64);
  }
  const { benchAgents, graderVia } = await import("./hub-realtest.mjs");
  const at = process.argv.indexOf("--agents");
  const via = graderVia(benchAgents(process.argv, at > 0 ? process.argv[at + 1] : null));
  await gradeRun(path.resolve(dir), { claudeConfig: path.join(os.homedir(), ".monocode-hub-dev/claude-config"), ...via });
}
