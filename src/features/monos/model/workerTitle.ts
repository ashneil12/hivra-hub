/**
 * A worker's title is a job name, never the Lead's own sentence. r63 (PM's C1 on 0.16.3): a Hivra worker was titled
 * "I'll check the live Canary sitemap and request..." because the title fell back to the first line of the Lead's
 * prompt. The Lead's "I'll / I will / Let me / I'm going to …" opener goes, and what is left reads as a task:
 * "Check the live Canary sitemap and request…". A title that is all opener ("On it.", "Sure.") gives way to `fallback`.
 */
const OPENER =
  /^(?:(?:ok(?:ay)?|sure|right|great|alright|got it|on it)[,.!:\s]+)*(?:i['’]ll|i will|i['’]m going to|i am going to|i['’]m gonna|let me|let['’]s|we['’]ll|i['’]d like to|i need to|i want to|i can)\s+/i;
const FILLER = /^(?:ok(?:ay)?|sure|right|great|alright|got it|on it|will do|yes|done)[\s,.!:]*$/i;
const ADVERB = /^(?:now|first|quickly|just|also|then|go ahead and|go and|go)\s+/i;

export function workerTitle(raw: string | null | undefined, fallback = ""): string {
  const line = (raw ?? "").trim().split("\n")[0].trim();
  if (!line || FILLER.test(line)) return fallback;
  let rest = line;
  if (OPENER.test(rest)) {
    rest = rest.replace(OPENER, "");
    while (ADVERB.test(rest)) rest = rest.replace(ADVERB, "");
  }
  rest = rest.trim();
  if (!rest || FILLER.test(rest)) return fallback;
  return rest[0].toUpperCase() + rest.slice(1);
}
