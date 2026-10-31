// r100 (parent, after B5 e805 counted 39): every B5 report lists each ask Ash sent, by number, with the state the
// Lead's status answer gives it, so a missing one shows at once. And (g): what the rendered chat shows next to the raw
// transcript, so repeats that are only in the transcript are labelled. Report-only; the grader's rules are untouched.

const BUCKETS = [
  ["done", /^(?:\*\*)?(?:done|finished|also done)\b/i],
  ["running", /^(?:\*\*)?(?:running|under way|in progress|still running)\b/i],
  ["waiting on you", /^(?:\*\*)?(?:waiting(?: on you)?|needs you)\b/i],
  ["blocked by your answers", /^(?:\*\*)?blocked\b/i],
  ["parked", /^(?:\*\*)?(?:parked|held|not started)\b/i],
  ["lost", /^(?:\*\*)?lost\b/i],
];

/** The Lead's answer to the status question: the rendered text after it in the view that shows it, else "". */
export function statusAnswer(evidence, question = "wat happened") {
  for (const view of evidence.views ?? []) {
    const text = view.mainText ?? "";
    const at = text.toLowerCase().indexOf(question);
    if (at >= 0) return text.slice(at + question.length);
  }
  return "";
}

/** Each ask with the bucket its paragraph sits under in the answer ("missing" when no key word appears). */
export function askLedger(asks, answer) {
  const paras = answer.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  let bucket = "mentioned";
  const tagged = paras.map((para) => {
    const hit = BUCKETS.find(([, re]) => re.test(para));
    if (hit) bucket = hit[0];
    return { para: para.toLowerCase(), bucket };
  });
  return asks.map((ask) => {
    const found = tagged.find((t) => ask.keys.some((k) => t.para.includes(k.toLowerCase())));
    return { n: ask.n, place: ask.place, ask: ask.ask, state: found ? found.bucket : "MISSING" };
  });
}

const MARKER = /needs\s+(?:ash|the\s+user)\s*(?:\([^)]*\))?\s*[:\-—]\s*([^/\n]+)/gi;

/** How many times each open-ask question is written in the raw transcript, and whether the rendered views carry markers. */
export function renderedVsRaw(evidence, transcript) {
  const counts = new Map();
  for (const m of transcript.matchAll(MARKER)) {
    const q = m[1].trim().toLowerCase();
    counts.set(q, (counts.get(q) ?? 0) + 1);
  }
  const repeated = [...counts.values()].filter((c) => c > 1);
  const rendered = (evidence.views ?? []).map((v) => v.mainText ?? "").join("\n");
  const markersShown = (rendered.match(/needs (?:ash|the user)\s*:|my pick\s*:/gi) ?? []).length;
  const raw = repeated.length
    ? `the raw transcript writes ${repeated.length} open question(s) more than once (${repeated.reduce((a, b) => a + b, 0)} times in all)`
    : "the raw transcript writes each open question once";
  return `Rendered chat vs raw transcript: ${raw}; the rendered chat shows ${markersShown} marker line(s) and each open ask once (repeats are left out where it renders, askMarkers.ts). Repeats counted only from the transcript are transcript-only, not what Ash reads.`;
}

/** The report section for one scenario. */
export function asksSection(evidence, transcript) {
  const lines = [];
  if (evidence.asks?.length) {
    const ledger = askLedger(evidence.asks, statusAnswer(evidence));
    const missing = ledger.filter((a) => a.state === "MISSING").length;
    lines.push(`Asks Ash sent: ${ledger.length}; missing from the status answer: ${missing}.`, "");
    for (const a of ledger) lines.push(`${a.n}. [${a.place}] ${a.ask}: ${a.state}`);
    lines.push("");
  }
  lines.push(renderedVsRaw(evidence, transcript), "");
  return lines;
}
