// r97 (Critiquito j, c02 BLIND 242d): the Lead's interim line "Verifying the health endpoint and negative bump in the
// code. Preparing a consolidated rollup." used office words. The line Ash sees between steps reads in plain words:
// "Putting the summary together". Only these stock phrases change; anything else is left as written.
const SWAPS: [RegExp, string][] = [
  // "Preparing/Compiling/Drafting/Building (a/the) (consolidated/final) rollup/roll-up/summary report"
  [/\b(?:preparing|compiling|drafting|building|assembling|writing up|putting together)\s+(?:a|the|my)?\s*(?:consolidated|combined|final|overall|unified)?\s*(?:roll-?ups?|summary report|status rollup)\b/gi, "putting the summary together"],
  [/\b(?:consolidating|aggregating|synthesi[sz]ing|collating)\s+(?:the\s+)?(?:results|findings|reports|outputs|updates)\b/gi, "putting the results together"],
  [/\b(?:the|a)\s+(?:consolidated\s+)?roll-?up\b/gi, "the summary"],
  [/\bconsolidated\s+(summary|report|update)\b/gi, "$1"],
  [/\bverifying\b/gi, "checking"],
  [/\btriaging\b/gi, "sorting out"],
  [/\borchestrating\b/gi, "organising"],
  [/\bdispatching\b/gi, "handing out"],
];

const capFirst = (s: string) => s.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_, lead: string, c: string) => lead + c.toUpperCase());

/** The interim line in plain words. */
export function plainInterim(text: string): string {
  let out = text;
  for (const [rx, to] of SWAPS) out = out.replace(rx, (m) => (/^\p{Lu}/u.test(m) ? to[0]!.toUpperCase() + to.slice(1) : to));
  return out === text ? text : capFirst(out);
}
