// Judge again the scenes of a finished realconv run whose judge never answered (UNGRADED), from what the run saved:
// <run>/<scene>/transcript.md and result.json's hard facts and provenance. Nothing in the app is touched.
//   node scripts/realconv/rejudge.mjs <run dir> [--scenes-file tests/realconv/ash-day.json] [--judge grok-sub] [--all]
import fs from "node:fs";
import path from "node:path";
import { judgeScene, verdict } from "./judge.mjs";
import { makeClient, providerSpec } from "./llm.mjs";

export async function rejudgeRun(runDir, { book, judge, all = false, log = () => {} }) {
  const scenes = new Map((book.scenes ?? []).map((scene) => [scene.id, scene]));
  const changed = [];
  for (const id of fs.readdirSync(runDir).sort()) {
    const file = path.join(runDir, id, "result.json");
    const scene = scenes.get(id);
    if (!scene || !fs.existsSync(file)) continue;
    const result = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!all && result.verdict !== "UNGRADED") continue;
    const transcriptText = fs.readFileSync(path.join(runDir, id, "transcript.md"), "utf8");
    const judged = await judgeScene(judge, scene, transcriptText, result.hard ?? {}, book.judgeRubric);
    const provenance = { ...(result.provenance ?? {}), judge: judge.real === true };
    const next = { ...result, provenance, ...verdict({ hard: result.hard, judged, provenance }), judged, rejudged: new Date().toISOString(), before: { verdict: result.verdict, reasons: result.reasons } };
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    log(`${id}: ${result.verdict} -> ${next.verdict}${next.reasons?.length ? `: ${next.reasons.join("; ").slice(0, 400)}` : ""}`);
    changed.push({ id, before: result.verdict, after: next.verdict });
  }
  return changed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const value = (flag, fallback) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback);
  const runDir = path.resolve(argv[0] ?? "");
  if (!argv[0] || !fs.existsSync(runDir)) throw new Error("usage: rejudge.mjs <run dir> [--scenes-file f] [--judge grok-sub|claude] [--all]");
  const book = JSON.parse(fs.readFileSync(path.resolve(value("--scenes-file", "tests/realconv/scenes.json")), "utf8"));
  const judge = makeClient(providerSpec({ provider: value("--judge", "grok-sub"), model: value("--judge-model") }));
  await rejudgeRun(runDir, { book, judge, all: argv.includes("--all"), log: (line) => console.log(`[rejudge] ${line}`) });
}
