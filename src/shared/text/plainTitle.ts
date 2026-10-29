/**
 * A chat or conversation title as plain text (Alfred's r50 blind run, 22 Oct): a title is often the first message, so it
 * can hold markdown ("The current branch is **pm/pages-live**..."), which showed raw in the header, the conversation list
 * and the delete confirm. Links keep their words, code keeps its text, emphasis marks, headings, quotes and list marks
 * go, and it is one line. No cutting: callers that need a short title cut it themselves.
 */
export function plainTitle(raw: string): string {
  if (!raw) return raw;
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A stored session title starts with its harness's label (session.ts formatSessionTitle: "claude · ..."), for the tab
// strip; the labels are session.ts HARNESS_LABEL's, kept here so shared/ needs nothing from features/.
const HARNESS_PREFIX = /^(?:claude|codex|cursor|grok|opencode|pi|omp|fx|antigravity|devin) · /i;
// A turn the Hub wrote opens with its kind in brackets ("[MonoCode brief from MonoCode Hub lead] ..."), and a title made
// from that turn kept it, sometimes cut before its "]" ("[MonoCode brief fr…").
const MONOCODE_TAG = /^\[MonoCode\b[^\]\n]*(?:\]|$)\s*[:\-–—]?\s*/i;
// A Lead's brief often opens by quoting Ash (PM's r63 run, 29 Oct: a worker tab read "Ash's words, verbatim: "can u get
// someone…""). A title is the job, so a quote opener and the quote marks around what follows go.
const QUOTE_OPENER =
  /^(?:(?:Ash|he|his|the user)(?:'s|’s)?\s+(?:own\s+)?(?:words|ask|request|message)(?:,?\s*(?:verbatim|word for word|exactly))?|Ash\s+(?:said|asked|wrote|wants)|(?:verbatim|quote|brief|task|job))\s*[:\-–—]\s*/i;
function unquote(title: string): string {
  const open = /^["“]/.exec(title);
  if (!open) return title;
  const inner = title.slice(1);
  const close = inner.search(/["”]/);
  // "the whole title" or a quote cut before its close ("can u get someone…) loses its marks; "a" b keeps them.
  if (close === -1) return inner.trim();
  if (close === inner.length - 1) return inner.slice(0, -1).trim();
  if (/^["”]\s*…?$/.test(inner.slice(close))) return (inner.slice(0, close) + inner.slice(close + 1)).trim();
  return title;
}

/**
 * A title as a list shows it (PM's r51 run, 22 Oct: sub-chats listed as "claude · I'll run that comma…" and
 * "claude · [MonoCode brief fr…"): plain (plainTitle), without the harness label the tab strip's copy starts with, and
 * without a leading [MonoCode …] tag. Empty when nothing is left, so callers fall back to their own word.
 */
export function listTitle(raw: string): string {
  if (!raw) return "";
  let title = raw.trim();
  for (;;) {
    const next = title.replace(HARNESS_PREFIX, "").replace(MONOCODE_TAG, "").replace(QUOTE_OPENER, "").trim();
    if (next === title) break;
    title = next;
  }
  // What a cut tag leaves, "…" alone, is nothing to show.
  const plain = plainTitle(title).replace(/^…$/, "");
  return unquote(plain);
}
