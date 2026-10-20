// The real-Claude bench's grader (scripts/hub-realtest.mjs, docs/REALTEST.md). Each scenario's transcript.md (what Ash
// sent, every room message and chat reply with times, delegation rows, the views) plus its rule metrics go to Sonnet at
// medium effort, with the benchmark items the scenario covers; it answers PASS / PARTIAL / FAIL / NOT-TRIGGERED per item
// with the evidence quoted. The rule metrics (timings, counts) are computed by the player, not the model, and are
// written next to the model's grade so a reader can check one against the other. report.md puts it all together.
//
//   node scripts/hub-realtest-grade.mjs evidence/realtest/<run>      # grade a finished run (again)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
export const BENCHMARK = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/realtest/benchmark.json"), "utf8"));

const SYSTEM = `You grade one scenario of a real end-to-end test of "MonoCode Hub", an app where AI agents (Monos) work for one person, Ash.
Ash has a leadership room (group chat: Chief of Staff, Projects Manager, frank, Alfred), a project Lead per project (here "tally-lead"), and temporary workers the Lead delegates to.
You get: the benchmark items this scenario covers (Ash's own standard, from a team he liked), the scenario's intent, a timeline (times are seconds after the scenario started; "Ash ->" lines are what the test sent as Ash), delegation rows, what the app's views showed, and metrics computed by the test (trust these numbers).
Grade each item strictly against what the timeline shows, never against what an agent claims. Use:
- PASS: the item's behaviour clearly happened, within its time limit.
- PARTIAL: some of it happened, or late, or with a real flaw.
- FAIL: it did not happen, or the opposite happened.
- NOT-TRIGGERED: the situation the item needs never arose in this scenario (say why), so it can't be judged.
Quote the evidence verbatim (short, with its +Ns time). Name concrete problems a developer could fix (what was seen, where).
Answer with ONE JSON object and nothing else:
{"grade":"PASS|PARTIAL|FAIL|NOT-TRIGGERED","items":[{"item":"<id>","grade":"...","why":"<one or two sentences>","evidence":["+12s ..."]}],"summary":"<two sentences>","problems":["<one line each>"]}
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
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function gradeScenario(dir, { claudeConfig, claude = path.join(os.homedir(), ".local/bin/claude"), model = "sonnet", effort = "medium" } = {}) {
  const evidence = JSON.parse(fs.readFileSync(path.join(dir, "evidence.json"), "utf8"));
  let transcript = fs.readFileSync(path.join(dir, "transcript.md"), "utf8");
  if (transcript.length > 90_000) transcript = `${transcript.slice(0, 60_000)}\n\n[... cut ...]\n\n${transcript.slice(-28_000)}`;
  const prompt = [
    "## Benchmark items for this scenario",
    benchText(evidence.bench ?? []),
    "",
    transcript,
  ].join("\n");
  const run = spawnSync(
    claude,
    ["-p", "--model", model, "--effort", effort, "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "user", "--no-session-persistence", "--system-prompt", SYSTEM],
    {
      input: prompt,
      encoding: "utf8",
      cwd: dir,
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfig, CLAUDE_SECURESTORAGE_CONFIG_DIR: claudeConfig, DISABLE_AUTOUPDATER: "1" },
    },
  );
  const grade = parseGrade(run.stdout ?? "") ?? { grade: "UNGRADED", summary: `grader failed: ${(run.stderr || run.stdout || "").slice(0, 300)}`, items: [], problems: [] };
  grade.grader = { model, effort, exit: run.status };
  fs.writeFileSync(path.join(dir, "grade.json"), JSON.stringify(grade, null, 2));
  return grade;
}

export async function gradeRun(evidenceDir, { claudeConfig }) {
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
    grades[id] = gradeScenario(path.join(scenariosDir, id), { claudeConfig });
    console.log(`[realtest grade] ${id}: ${grades[id].grade}`);
  }
  fs.writeFileSync(path.join(evidenceDir, "grades.json"), JSON.stringify(grades, null, 2));
  fs.writeFileSync(path.join(evidenceDir, "report.md"), report(evidenceDir, summary, grades));
  console.log(`[realtest grade] report: ${path.relative(ROOT, path.join(evidenceDir, "report.md"))}`);
  return 0;
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
    const timings = (result.metrics?.replies ?? []).map((r) => `${r.label ?? r.to}: ${r.firstReplySec}s${r.from ? ` (${r.from})` : ""}`).join("; ");
    lines.push(
      `| ${result.id} ${result.title ?? ""} | ${result.skipped ? `SKIPPED (${result.skipped})` : result.error ? `ERROR (${result.error})` : (grade?.grade ?? "UNGRADED")} | ${(result.bench ?? []).join(", ")} | ${timings || "-"} | ${(grade?.summary ?? "").replace(/\|/g, "/").replace(/\n/g, " ")} |`,
    );
  }
  lines.push("", "## Per item", "");
  for (const [id, grade] of Object.entries(grades)) {
    lines.push(`### ${id}: ${grade.grade}`, "");
    for (const item of grade.items ?? []) lines.push(`- **${item.item}** ${item.grade}: ${item.why}${item.evidence?.length ? ` Evidence: ${item.evidence.map((e) => `"${e}"`).join("; ")}` : ""}`);
    if (grade.problems?.length) lines.push("", "Problems:", ...grade.problems.map((p) => `- ${p}`));
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/hub-realtest-grade.mjs evidence/realtest/<run>");
    process.exit(64);
  }
  await gradeRun(path.resolve(dir), { claudeConfig: path.join(os.homedir(), ".monocode-hub-dev/claude-config") });
}
