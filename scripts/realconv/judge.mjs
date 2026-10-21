// The judge for `npm run hub:realconv` (docs/REALCONV.md): one model call per scene with Alfred's rubric (scene card,
// per-reply 0/1/2 checks, per-scene checks, automatic fails), the full transcript and the host's hard facts. It never
// sees a builder's own summary. The model scores; the verdict is computed here from its scores and the hard checks
// with Alfred's rules, so a judge that writes "PASS" over low scores or a hard fail doesn't make a pass, and nothing
// passes unless a real model played every part.

import { parseJsonObject } from "./llm.mjs";

export function judgeSystem(rubric) {
  return `You judge one scene of a live test of MonoCode Hub, an app where AI agents ("Monos") work for one person, Ash. The test asks one question above all: would a reader call this a real conversation?
Ash's side was played by a tester model in his voice; the agents are the real app. Judge the agents only. Use the rubric below exactly.

${rubric}

You get: the scene card, the transcript (times are seconds after the scene began; "Ash" lines are the tester's), and hard facts the test read from the app's own state (trust them over anything an agent claims: if an agent says it committed and the git facts show no change, that is "work claimed but not present").
Score every agent reply that Ash or the room could read. Checks per reply, 0/1/2: answers (answers the actual point), adds (adds something from its lane; repeating another seat is 0), disagrees (2 only if a disagreement was warranted and made; null when none was warranted), honest (labels verified vs not; claims nothing unseen), voice (short, plain, numbered when listing, no em dashes, no walls of text).
Answer with ONE JSON object and nothing else:
{"grade":"PASS|PARTIAL|FAIL|NOT-TRIGGERED","replies":[{"at":"+12s","who":"<seat or chat>","answers":0,"adds":0,"disagrees":null,"honest":0,"voice":0,"note":"<short>"}],"sceneChecks":[{"check":"dump protocol|work really happened|handoffs talk|ash heard back|<the card's own pass line>","pass":true,"why":"<one sentence>","evidence":["+12s ..."]}],"autoFails":[{"check":"<which automatic fail>","evidence":"+12s ..."}],"realConversation":true,"triggered":true,"items":[{"item":"<check>","grade":"PASS|PARTIAL|FAIL|NOT-TRIGGERED","why":"...","evidence":["..."]}],"summary":"<two sentences>","problems":["<one line a developer can fix>"]}
Leave a scene check out when the card doesn't need it (for example the dump protocol when Ash sent one ask). Set "triggered": false only when the situation the scene needs never arose (say why in summary).`;
}

export function judgePrompt(scene, transcriptText, hard) {
  return [
    `## Scene card: ${scene.id}. ${scene.title}`,
    scene.card,
    scene.note ? `\nTest note: ${scene.note}` : "",
    "",
    "## Hard facts from the app's state",
    "```json",
    JSON.stringify({ autoFails: hard.autoFails, missedExpectations: hard.misses, facts: hard.facts }, null, 2),
    "```",
    "",
    "## Transcript",
    transcriptText.length > 90_000 ? `${transcriptText.slice(0, 60_000)}\n[... cut ...]\n${transcriptText.slice(-28_000)}` : transcriptText,
  ].join("\n");
}

export const JUDGE_TIMEOUT_MS = 600_000;

export async function judgeScene(client, scene, transcriptText, hard, rubric) {
  try {
    const prompt = judgePrompt(scene, transcriptText, hard);
    // A long scene can take the judge past five minutes on Grok (Ash day AD5: "claude exited 143"): ten, and one more go.
    const ask = async (text) => {
      try {
        return await client.complete({ system: judgeSystem(rubric), prompt: text, timeoutMs: JUDGE_TIMEOUT_MS });
      } catch {
        return client.complete({ system: judgeSystem(rubric), prompt: text, timeoutMs: JUDGE_TIMEOUT_MS });
      }
    };
    let answer = await ask(prompt);
    let parsed = parseJsonObject(answer.text);
    if (!parsed) {
      // A model that starts narrating ("I'll check each seat's soul...") gets one more go: it has no tools, only the transcript.
      answer = await ask(`${prompt}\n\nYou have no tools and nothing else to read: everything is above. Answer now with the one JSON object only, no other words.`);
      parsed = parseJsonObject(answer.text);
    }
    if (!parsed) return { grade: "UNGRADED", error: `the judge's answer wasn't JSON: ${String(answer.text).slice(0, 200)}`, judge: meta(client) };
    return { ...parsed, judge: meta(client) };
  } catch (error) {
    return { grade: "UNGRADED", error: error.message, judge: meta(client) };
  }
}

const meta = (client) => ({ provider: client.provider, model: client.model, real: client.real });

const CHECKS = ["answers", "adds", "disagrees", "honest", "voice"];

/** The per-reply average over every scored check (nulls are N/A), and the lowest "answers" score. */
export function replyScores(replies = []) {
  const scores = [];
  let lowestAnswers = null;
  for (const reply of replies) {
    for (const check of CHECKS) {
      const value = reply?.[check];
      if (typeof value === "number" && value >= 0 && value <= 2) scores.push(value);
    }
    if (typeof reply?.answers === "number") lowestAnswers = lowestAnswers == null ? reply.answers : Math.min(lowestAnswers, reply.answers);
  }
  return { average: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null, lowestAnswers, scored: replies.length };
}

/**
 * The scene's verdict (Alfred's rules), from the hard checks, the judge's scores and who played:
 *  - INVALID: the tester couldn't play Ash without scripting, or the harness failed: it tests nothing.
 *  - NOT-REAL: the agents, the tester or the judge was the scripted fake. Never a pass, whatever it scored.
 *  - FAIL: any automatic fail (hard or the judge's), or nothing to judge.
 *  - NOT-TRIGGERED: the situation the scene needs never arose (a stuck worker that never got stuck).
 *  - PASS: every scene check passes (the judge's and the host's expectations), average >= 1.5, no reply below 1 on
 *    "answers", and the judge calls it a real conversation.
 *  - PARTIAL: no automatic fail, at most one scene check missed, average >= 1.0.
 */
export function verdict({ hard, judged, provenance, invalid = null, triggered = true }) {
  const reasons = [];
  if (invalid) return { verdict: "INVALID", reasons: [invalid] };
  const fake = Object.entries(provenance ?? {}).filter(([, real]) => real !== true).map(([part]) => part);
  const autoFails = [...(hard?.autoFails ?? []), ...(judged?.autoFails ?? [])];
  const scores = replyScores(judged?.replies);
  const sceneMisses = [...(hard?.misses ?? []), ...(judged?.sceneChecks ?? []).filter((c) => c && c.pass === false).map((c) => `${c.check}: ${c.why ?? ""}`)];
  let result;
  if (autoFails.length) {
    result = "FAIL";
    reasons.push(...autoFails.map((f) => `automatic fail: ${f.check}${f.who ? ` (${f.who})` : ""}${f.text ? `: "${f.text}"` : f.evidence ? `: ${f.evidence}` : ""}`));
  } else if (!triggered || judged?.triggered === false) {
    result = "NOT-TRIGGERED";
    reasons.push(judged?.summary ?? "the situation this scene needs never arose");
  } else if (!judged || judged.grade === "UNGRADED") {
    result = "UNGRADED";
    reasons.push(judged?.error ?? "no judge");
  } else if (scores.average == null) {
    result = "FAIL";
    reasons.push("no agent reply to score");
  } else if (!sceneMisses.length && scores.average >= 1.5 && (scores.lowestAnswers ?? 0) >= 1 && judged.realConversation !== false) {
    result = "PASS";
  } else if (sceneMisses.length <= 1 && scores.average >= 1.0) {
    result = "PARTIAL";
    reasons.push(...sceneMisses, ...(scores.average < 1.5 ? [`average reply score ${scores.average} (needs 1.5)`] : []), ...((scores.lowestAnswers ?? 0) < 1 ? ["a reply scored 0 on answering the point"] : []), ...(judged.realConversation === false ? ["the judge says it isn't a real conversation"] : []));
  } else {
    result = "FAIL";
    reasons.push(...sceneMisses, `average reply score ${scores.average}`);
  }
  if (fake.length) {
    return { verdict: "NOT-REAL", wouldBe: result, reasons: [`not a real run: ${fake.join(", ")} ${fake.length === 1 ? "was" : "were"} the scripted fake`, ...reasons], scores };
  }
  return { verdict: result, reasons, scores };
}
