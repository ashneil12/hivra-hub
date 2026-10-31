// r100 (parent, after B5 e805 counted 39): every B5 report lists each ask Ash sent, by number, with the state the
// Lead's status answer gives it, so a missing one shows at once. And (g): what the rendered chat shows next to the raw
// transcript, so repeats that are only in the transcript are labelled. Report-only; the grader's rules are untouched.

// r100 run 4 (571a): a paragraph may open with its number ("14 done. ...", "1 waiting on you.").
const N = String.raw`(?:\*\*)?(?:\d+\s+)?`;
const BUCKETS = [
  ["done", new RegExp(`^${N}(?:done|finished|also done)\\b`, "i")],
  ["running", new RegExp(`^${N}(?:running|under way|in progress|still running)\\b`, "i")],
  ["waiting on you", new RegExp(`^${N}(?:waiting(?: on you)?|needs you)\\b`, "i")],
  ["blocked by your answers", new RegExp(`^${N}blocked\\b`, "i")],
  ["parked", new RegExp(`^${N}(?:parked|held|not started)\\b`, "i")],
  ["lost", new RegExp(`^${N}lost\\b`, "i")],
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

/** The Inbox's "Waiting on you" text after the reopen, else "". */
export function inboxCard(evidence) {
  const view = (evidence.views ?? []).find((v) => v.name === "inbox-after-reopen") ?? (evidence.views ?? []).find((v) => (v.mainText ?? "").includes("Waiting on you"));
  const text = view?.mainText ?? "";
  const at = text.indexOf("Waiting on you");
  return at >= 0 ? text.slice(at) : "";
}

/** Each ask with the bucket its paragraph sits under in the answer ("missing" when no key word appears). */
export function askLedger(asks, answer, inbox = "") {
  // r100 run 1 (9882): the answer points to "4 decisions on your Inbox card" instead of pasting them, so an ask
  // found only on the Inbox's Waiting on you card is waiting on you there, not missing.
  const card = inbox.toLowerCase();
  const paras = answer.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  let bucket = "mentioned";
  const tagged = paras.map((para) => {
    const hit = BUCKETS.find(([, re]) => re.test(para));
    if (hit) bucket = hit[0];
    return { para: para.toLowerCase(), bucket };
  });
  return asks.map((ask) => {
    const found = tagged.find((t) => ask.keys.some((k) => t.para.includes(k.toLowerCase())));
    const onCard = !found && card && ask.keys.some((k) => card.includes(k.toLowerCase()));
    return { n: ask.n, place: ask.place, ask: ask.ask, state: found ? found.bucket : onCard ? "waiting on you (on the Inbox card)" : "MISSING" };
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
    const ledger = askLedger(evidence.asks, statusAnswer(evidence), inboxCard(evidence));
    const missing = ledger.filter((a) => a.state === "MISSING").length;
    lines.push(`Asks Ash sent: ${ledger.length}; missing from the status answer: ${missing}.`, "");
    for (const a of ledger) lines.push(`${a.n}. [${a.place}] ${a.ask}: ${a.state}`);
    lines.push("");
  }
  lines.push(renderedVsRaw(evidence, transcript), "");
  return lines;
}
