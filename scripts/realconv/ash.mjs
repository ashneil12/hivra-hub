// The tester: a model playing Ash in `npm run hub:realconv` (docs/REALCONV.md). It gets his voice notes
// (tests/realconv/ash-voice.md: frank's openings and Alfred's notes), the scene card, and what Ash can see so far, and
// answers with his next line or "wait" / "done". It never edits his opening, never tags anyone, and never tells an
// agent which file to read or what to reply: a line that does is refused and asked for again, and if it still does,
// the scene is marked INVALID (a tester problem), never passed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseJsonObject } from "./llm.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VOICE_FILE = path.join(HERE, "../../tests/realconv/ash-voice.md");

const FILE = String.raw`[\w./-]*\w\.(?:md|ts|tsx|js|mjs|cjs|json|py|rs|toml|ya?ml|css|html|txt|sh)\b`;
/**
 * Why a line Ash would send is scripted, or null. Scripted = it steers the agent mechanically instead of talking:
 * "read X.md", "open src/foo.ts and ...", "reply with ...", "say only ...", or an @-tag (he hates tagging).
 */
export function scriptedProblem(text) {
  const t = String(text ?? "");
  if (new RegExp(String.raw`\b(read|open|cat|look at|check|load)\s+(the\s+)?(file\s+)?` + "`?" + FILE, "i").test(t)) return "tells an agent which file to read";
  if (/\b(reply|respond|answer|say|write)\s+(only\s+)?(with|exactly|just|only)\b/i.test(t)) return "tells an agent what to reply";
  if (/\bsay\s+["'`]/i.test(t)) return "tells an agent what to say";
  if (/(^|\s)@[A-Za-z]/.test(t)) return "tags someone (Ash wants the right one to answer without tags)";
  return null;
}

export function testerSystem(voice = fs.readFileSync(VOICE_FILE, "utf8")) {
  return `You play Ash, the one person a team of AI agents ("Monos") works for, in a live test of his app, MonoCode Hub.
You are testing whether the agents hold a real conversation: they answer the point, push back, delegate, report back, and never just say "noted".
Write exactly the way Ash writes. His voice brief follows; copy the style, never the exact examples unless they fit.

${voice}

Rules for you:
- React only to what the agents actually said (given below), the way Ash would: short pings, blunt pushback when something is vague or overclaimed, a side question while they work, "ok go" when it's good.
- Never tag anyone with @. Never tell an agent which file to read, which command to run, or what to reply. Never explain the test.
- Never be easier on them than Ash would be. If an answer is vague, say so like he would. If they did well, move on.
- You may send nothing ("wait") while work is visibly running, and end ("done") when Ash would stop: the scene's point has played out, or it is clearly not going to.
Answer with ONE JSON object and nothing else:
{"action":"send"|"wait"|"done","text":"<Ash's next message when action is send>","why":"<one short line, for the test log only>"}`;
}

/** What the tester reads: the scene, then what Ash can see, newest last. */
export function testerPrompt(scene, seen, { elapsedSec, ashTurns, maxAshTurns, busy, stuck, buttons }) {
  const lines = [
    `## The scene (${scene.id}: ${scene.title})`,
    scene.card,
    scene.followUps?.length ? `Lines Ash might use later, only if they fit what was said: ${scene.followUps.map((f) => `"${f}"`).join(", ")}` : "",
    scene.asideWhileBusy ? "While the work is running, Ash asks a quick side question (the scene needs it)." : "",
    "",
    `## What Ash can see now (${Math.round(elapsedSec)} s in; he has sent ${ashTurns} of at most ${maxAshTurns} messages)`,
    busy ? `The hub shows work running: ${busy}.` : "Nothing shows as running.",
    stuck ? `The hub shows something stuck: ${stuck}.` : "",
    "",
    ...seen.map((line) => `- ${line.who}: ${line.text}`),
    ...(buttons
      ? [
          "",
          `## Buttons Ash can see on the open screen`,
          buttons.length ? buttons.map((b) => `- "${b.label}"${b.disabled ? " (greyed out)" : ""}`).join("\n") : "(none)",
          `He may click one instead of typing: {"action":"click","label":"<exact label>","why":"..."}. He never clicks anything that deletes; he cancels instead.`,
        ]
      : []),
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/**
 * Ash's next move: {action, text, why, refused?}. Asks again once when the line is scripted; a second scripted line
 * comes back as {action: "invalid"}.
 */
export async function nextAshMove(client, scene, seen, state, { system = testerSystem() } = {}) {
  let prompt = testerPrompt(scene, seen, state);
  const refused = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await client.complete({ system, prompt });
    const move = parseJsonObject(answer.text);
    if (move?.action === "click" && state.buttons) {
      const label = String(move.label ?? "").trim();
      if (state.buttons.some((b) => b.label === label && !b.disabled)) return { action: "click", label, why: move.why ?? "", refused };
      refused.push(`no button "${label}" to click`);
      prompt += `\n\nThere is no clickable button "${label}". Pick one from the list, or type, wait, or end.`;
      continue;
    }
    if (!move || !["send", "wait", "done"].includes(move.action)) {
      refused.push(`not a move: ${String(answer.text).slice(0, 120)}`);
      prompt += "\n\nAnswer with the one JSON object only.";
      continue;
    }
    if (move.action !== "send") return { ...move, refused };
    const text = String(move.text ?? "").trim();
    const problem = text ? scriptedProblem(text) : "empty message";
    if (!problem) return { action: "send", text, why: move.why ?? "", refused };
    refused.push(`${problem}: ${text.slice(0, 160)}`);
    prompt += `\n\nYour last line was refused: it ${problem}. Ash never does that. Write it again the way he would.`;
  }
  return { action: "invalid", refused };
}
