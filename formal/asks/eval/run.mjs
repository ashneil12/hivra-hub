// Extraction recall for the ask ledger: formal/asks/README.md, part A. Not wired into CI.
//
//   node formal/asks/eval/run.mjs                      the standard suite, offline (rules, oracle, recorded, and three stress runs)
//   node formal/asks/eval/run.mjs --mode rules         only what the app keeps with no model
//   node formal/asks/eval/run.mjs --mode hub           a hub chat no first mate hears, as the app writes it now (rules + the old hub regex)
//   node formal/asks/eval/run.mjs --mode hub-old       the old hub ledger's extractor alone (hub/model/askLedger.ts): the baseline
//   node formal/asks/eval/run.mjs --mode recorded --recorded formal/asks/eval/recorded/typical.json
//   node formal/asks/eval/run.mjs --mode recorded --lazy 2        the model names only its first two asks per message
//   node formal/asks/eval/run.mjs --mode recorded --fail-first 1  the first model call per message times out (retry)
//   node formal/asks/eval/run.mjs --mode live --live-cmd 'claude -p' --record formal/asks/eval/recorded/live.json
//        live: the command gets hearPrompt() on stdin and prints the reply. Needs a model and the network: only when asked.
//   --messages FILE  another corpus   --json FILE  the raw numbers   --out FILE  the report as markdown   --min-recall 0.9  exit 1 below that
//
// The app's own modules are loaded as they are, through Vite's server-side loader, so this runs the TypeScript the app
// runs (no copy). See lib.ts for what is imported and what is mirrored.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 14).join("\n"));
  process.exit(0);
}

const value = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const number = (name) => {
  const raw = value(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(`${name} needs a whole number, got "${raw}"`);
    process.exit(2);
  }
  return parsed;
};
const readJson = (file) => JSON.parse(readFileSync(path.resolve(file), "utf8"));

const server = await createServer({
  root,
  configFile: false,
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});

let code = 0;
try {
  const lib = await server.ssrLoadModule("/formal/asks/eval/lib.ts");
  const corpus = readJson(value("--messages") ?? path.join(here, "messages.json"));
  const recordedFile = value("--recorded") ?? path.join(here, "recorded", "typical.json");
  const failFirst = number("--fail-first");
  const lazy = number("--lazy");
  const mode = value("--mode");

  const suite = mode
    ? [{ mode, ...(failFirst !== undefined ? { failFirst } : {}), ...(lazy !== undefined ? { lazy } : {}) }]
    : [
        { mode: "hub-old" },
        { mode: "hub" },
        { mode: "rules" },
        { mode: "oracle" },
        { mode: "recorded" },
        { mode: "recorded", lazy: 2 },
        { mode: "recorded", failFirst: 1 },
        { mode: "recorded", failFirst: 2 },
      ];

  const needsRecording = suite.some((options) => options.mode === "recorded");
  const recording = needsRecording ? readJson(recordedFile) : undefined;
  const liveCmd = value("--live-cmd");
  if (suite.some((options) => options.mode === "live") && !liveCmd) {
    console.error('--mode live needs --live-cmd, for example --live-cmd "claude -p"');
    process.exit(2);
  }

  const answers = {};
  const all = [];
  const liveAsks = corpus.messages.reduce((n, m) => n + m.asks.filter((a) => !a.cancelled).length, 0);
  const withdrawn = corpus.messages.reduce((n, m) => n + m.asks.filter((a) => a.cancelled).length, 0);
  const out = [`# Ask extraction eval\n\nMessages: ${corpus.messages.length}. Labelled asks: ${liveAsks}, plus ${withdrawn} asked and withdrawn in the same message. Corpus: ${path.relative(root, value("--messages") ? path.resolve(value("--messages")) : path.join(here, "messages.json"))}\n`];
  console.log(out[0]);
  for (const base of suite) {
    const options = { ...base, ...(recording ? { recording } : {}), ...(liveCmd ? { liveCmd } : {}), onLive: (id, record) => (answers[id] = record) };
    const run = await lib.evaluate(corpus, options);
    const text = lib.report(run, options);
    out.push(text);
    console.log(text, "\n");
    all.push({ options: { ...base }, totals: run.totals, results: run.results });
    const floor = value("--min-recall");
    if (floor !== undefined && run.totals.recallStrict < Number(floor)) code = 1;
  }

  const recordTo = value("--record");
  if (recordTo && Object.keys(answers).length) {
    writeFileSync(path.resolve(recordTo), `${JSON.stringify({ provenance: `Captured from \`${liveCmd}\` by formal/asks/eval/run.mjs. Real model replies to hearPrompt().`, answers }, null, 2)}\n`);
    console.log(`Recorded ${Object.keys(answers).length} live replies to ${recordTo}`);
  }
  const outFile = value("--out");
  if (outFile) writeFileSync(path.resolve(outFile), `${out.join("\n\n")}\n`);
  const json = value("--json");
  if (json) writeFileSync(path.resolve(json), `${JSON.stringify(all, null, 2)}\n`);
} finally {
  await server.close();
}
process.exit(code);
