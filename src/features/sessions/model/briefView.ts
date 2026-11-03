/**
 * A delegated chat's first turn is the app's brief (agentAppTasks.briefPrompt): "[MonoCode brief from X]", the Lead's
 * words, the worker's rules, the finish line and the project memory. PM's r63 run (29 Oct) found it shown raw in the
 * worker chat: markdown, a literal </project_memory>, <worker_rules> tags and local paths (/Users/ash/agent-memory,
 * ~/.claude/settings.local.json). The chat shows it as one collapsed "Brief" line instead (Critiquito, r63); opening it
 * shows the Lead's ask in plain words, never a tag, the injected memory or rules, or a path on the Mac.
 */
import { listTitle, plainTitle } from "../../../shared/text/plainTitle";
import { specOf, withoutTemplate } from "../../firstmate/model/brief";

const BRIEF_HEAD = /^\s*\[MonoCode brief from ([^\]\n]{1,80})\]\s*/;
/** A whole tagged block the app adds (<project_memory>, <worker_rules>, …), and any stray tag left after a cut. */
const TAG_BLOCK = /<([a-z][a-z0-9_-]*)>[\s\S]*?<\/\1>/gi;
const LOOSE_TAG = /<\/?[a-z][a-z0-9_-]*>/gi;
/** A path on the Mac, outside the project (home, agent memory, Claude settings, system folders). */
const LOCAL_PATH =
  /(?:~|\/(?:Users|home|private|var|tmp|opt|etc|Library|Volumes|Applications))(?:\/[^\s"'`),;\]]*)+/g;
const SELF_REVIEW = /\n##\s*Self-review[\s\S]*$/i;

export type BriefView = {
  /** Who sent it ("Hivra lead"). */
  from: string;
  /** The job, as one plain line: the brief's first line, without quote openers. */
  job: string;
  /** The ask, in plain words, without tags, injected context or paths. */
  body: string;
};

/** Plain words of a brief for showing, with nothing the app injected and no local path. */
export function plainBriefText(text: string): string {
  // Hivra WP-10: a brief from the template shows the intent and spec, never its fixed sections.
  let body = withoutTemplate(text).replace(TAG_BLOCK, "");
  // A block cut before its close (a long memory) still never shows: everything from its opening tag goes.
  body = body.replace(/<(project_memory|worker_rules|memory|rules)>[\s\S]*$/i, "");
  body = body.replace(SELF_REVIEW, "").replace(LOOSE_TAG, "").replace(LOCAL_PATH, "a local file");
  return body
    .split("\n")
    .map((line) => plainTitle(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function briefView(text: string | undefined | null): BriefView | undefined {
  if (!text) return undefined;
  const head = BRIEF_HEAD.exec(text);
  if (!head) return undefined;
  const rest = text.slice(head[0].length);
  const body = plainBriefText(rest);
  // The job is the spec's first line (Hivra WP-10's template), else the brief's own.
  const spec = specOf(rest);
  const from = spec ? plainBriefText(spec) : body;
  const firstLine = from.split("\n").map((line) => listTitle(line)).find(Boolean) ?? "";
  const job = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
  return { from: head[1].trim(), job: job || "Delegated work", body };
}
