// WP-41: the always-on pstack instruction. The catalog is generated (pstackIndex.generated.json) so it cannot drift;
// a session fills in the absolute path of the installed copy. Claude gets this on --append-system-prompt and Codex as
// developerInstructions, the text those sessions already take.
import { joinPath, slash } from "../../../shared/lib/paths";
import { PLAIN_ENGLISH_RULE } from "../../firstmate/model/plainEnglish";
import index from "./pstackIndex.generated.json";

export const PSTACK_AUTOPILOT =
  "When the work matches a skill below, read its SKILL.md and follow it yourself, without waiting for a slash command. Say in one plain sentence which one you used. Suggest one when it would clearly help.";

const SHIM = "/claude/pstack";

/**
 * The installed plugin folder for a Claude shim path (`…/plugins/claude/pstack` → `…/plugins/installed/pstack`).
 * The first usable directory wins. A `..` segment is refused.
 */
export function pstackInstallRoot(dirs: readonly unknown[]): string | undefined {
  for (const dir of dirs) {
    if (typeof dir !== "string") continue;
    const path = slash(dir).replace(/\/+$/, "");
    if (!path.endsWith(SHIM) || path.split("/").includes("..")) continue;
    const parent = path.slice(0, -SHIM.length);
    if (!parent || parent === "/" || parent.split("/").includes("..")) continue;
    return joinPath(parent, "installed/pstack");
  }
  return undefined;
}

function field(value: string): string {
  return value.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
}

function firstSentence(text: string): string {
  const flat = field(text);
  const at = flat.search(/(?<=[.!?])\s/);
  return (at === -1 ? flat : flat.slice(0, at + 1)).trim();
}

/** Slash names and quoted aliases, so a when-clause that is only those can be dropped. */
function withoutAliases(when: string): string {
  return when
    .replace(/\/[A-Za-z0-9][\w-]*/g, " ")
    .replace(/["“”][^"“”]*["“”]/g, " ")
    .replace(/['‘’][^'‘’]*['‘’]/g, " ")
    .replace(/\b(?:Apply|Use)(?:\s+only)?\s+(?:when|for|before|after|to)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:]+|[\s,;:]+$/g, "")
    .replace(/^(?:or|and)\s+/i, "")
    .trim();
}

function wordCount(text: string): number {
  return text.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).length;
}

/** The when-clause to keep. Dropped when it only repeats slash aliases, or repeats what the skill is for. */
function keptWhen(purpose: string, when: string): string | undefined {
  const clean = field(when);
  if (!clean || clean === purpose) return undefined;
  const rest = firstSentence(withoutAliases(clean));
  if (!rest || rest === purpose || wordCount(rest) < 3) return undefined;
  return field(rest);
}

function safeRel(rel: string): boolean {
  if (!rel || rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || rel.includes("\\")) return false;
  return rel.split("/").every((part) => part && part !== "." && part !== "..");
}

/** The absolute SKILL.md path, or none when the root or the relative path is not safe. */
export function skillPath(root: string, rel: string): string | undefined {
  if (!root.trim() || slash(root).split("/").includes("..")) return undefined;
  if (!safeRel(rel)) return undefined;
  return joinPath(root, rel);
}

/** One compact line per skill. Unusable entries are skipped. None when nothing is left. */
export function indexLines(entries: unknown, root: string): string | undefined {
  if (!Array.isArray(entries)) return undefined;
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.for !== "string" || typeof record.when !== "string" || typeof record.rel !== "string")
      continue;
    const name = field(record.name);
    if (!name || seen.has(name)) continue;
    if (!skillPath(root, record.rel)) continue;
    seen.add(name);
    const purpose = firstSentence(record.for);
    const when = keptWhen(purpose, record.when);
    lines.push([name, purpose, ...(when ? [when] : []), record.rel].join(" | "));
  }
  return lines.length ? lines.join("\n") : undefined;
}

/** The install folder once, then one relative SKILL.md path per skill. Joining the two is still absolute. */
export function pstackIndexText(root: string): string | undefined {
  const lines = indexLines(index, root);
  return lines ? `${root}\n${lines}` : undefined;
}

/** The text a session is given. Pstack only when it is on; the plain-English ending only when that switch is on. */
export function sessionInstruction(input: { pstackRoot?: string; plainEnglish: boolean }): string {
  const parts: string[] = [];
  if (input.pstackRoot) {
    const lines = pstackIndexText(input.pstackRoot);
    if (lines) parts.push(`${PSTACK_AUTOPILOT}\n${lines}`);
  }
  if (input.plainEnglish) parts.push(PLAIN_ENGLISH_RULE);
  return parts.join("\n\n");
}
