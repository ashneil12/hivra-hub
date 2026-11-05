// The run's report for `npm run hub:realconv`: report.md (one line per scene, then why) and report.json.

import fs from "node:fs";
import path from "node:path";

import { canaryTable } from "../bench-guard.mjs";

const MARK = { PASS: "PASS", PARTIAL: "PARTIAL", FAIL: "FAIL", "NOT PROVEN": "NOT PROVEN", "NOT-TRIGGERED": "NOT-TRIGGERED", "NOT-REAL": "NOT-REAL (no real model)", INVALID: "INVALID (tester)", UNGRADED: "UNGRADED", SKIPPED: "SKIPPED", ERROR: "ERROR" };

export function writeReport(out, results, meta) {
  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const real = meta.agents?.real && meta.tester?.real && meta.judge?.real;
  const lines = [
    `# Real-conversation run ${meta.runId}`,
    "",
    real
      ? "Every part was a real model: these verdicts are behaviour results."
      : "**Not a real run.** At least one part (agents, tester or judge) was the scripted fake, so no scene here counts as passed. This checks the runner, nothing about the agents.",
    "",
    `- Agents (the hub's own chats): ${meta.agents?.model ?? "?"}${meta.agents?.real ? "" : " (fake)"}`,
    `- Ash (tester): ${meta.tester?.provider}/${meta.tester?.model}${meta.tester?.real ? "" : " (fake)"}`,
    `- Judge: ${meta.judge?.provider}/${meta.judge?.model}${meta.judge?.real ? "" : " (fake)"}`,
    `- Started ${meta.started}, ${results.length} scene(s): ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`,
    meta.stopReason ? `- Stopped early: ${meta.stopReason}` : "",
    "",
    "| Scene | Verdict | Avg | Why |",
    "| --- | --- | --- | --- |",
    ...results.map((r) => `| ${r.id} ${r.title ?? ""} | ${MARK[r.verdict] ?? r.verdict}${r.wouldBe ? ` (scored as ${r.wouldBe})` : ""} | ${r.scores?.average ?? "-"} | ${(r.reasons ?? []).slice(0, 3).join("; ").replace(/\|/g, "/").slice(0, 300) || "-"} |`),
    "",
    ...results.flatMap((r) => [
      `## ${r.id}: ${r.title ?? ""}`,
      "",
      `Verdict: **${MARK[r.verdict] ?? r.verdict}**${r.minutes != null ? ` in ${r.minutes} min` : ""}. Transcript: ${r.verdict === "SKIPPED" ? "none" : `[${r.id}/transcript.md](${r.id}/transcript.md)`}`,
      "",
      ...(r.reasons ?? []).map((x) => `- ${x}`),
      ...(r.hard?.autoFails?.length ? ["", "Automatic fails from the hub's state:", ...r.hard.autoFails.map((f) => `- ${f.check}${f.who ? ` (${f.who})` : ""}${f.text ? `: "${f.text}"` : ""}`)] : []),
      ...(r.hard?.misses?.length ? ["", "Expectations the hub's state doesn't show:", ...r.hard.misses.map((m) => `- ${m}`)] : []),
      ...(r.judged?.summary ? ["", `Judge: ${r.judged.summary}`] : []),
      ...(r.judged?.problems?.length ? ["", "Problems:", ...r.judged.problems.map((p) => `- ${p}`)] : []),
      ...(r.canary?.length ? ["", "Canary:", "", canaryTable(r.canary), ""] : []),
      "",
    ]),
  ].filter((l) => l !== null);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "report.md"), `${lines.join("\n")}\n`);
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ ...meta, counts, real: !!real, results: results.map(({ judged, hard, ...r }) => ({ ...r, autoFails: hard?.autoFails ?? [], misses: hard?.misses ?? [], judgeSummary: judged?.summary ?? null })) }, null, 2));
  return path.join(out, "report.md");
}
