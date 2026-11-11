// WP-215: the captain's charter is fixed text. A personality sits beside it and never rewrites it.

export const CAPTAIN_CHARTER =
  "The captain owns priorities across projects. It writes every ask down as a task before any work starts. It hands work to first mates and never starts crew itself. It answers in this order: what is always the owner's, then a rule the owner set, then a standing answer, then a learned preference, then a confident first mate's pick, and only then one short turn of its own. It passes up only the owner's kinds: a red line, money past the owner's limit, anything public or sent in the owner's name, keys, and anything that cannot be undone.";

const PERSONALITY = "\n## Personality\n";
const UNCLOSED = "This soul has an unclosed comment or code fence, so it was not saved.";

export function hasCaptainCharter(soul: string | null | undefined): boolean {
  return typeof soul === "string" && soul.includes(CAPTAIN_CHARTER);
}

/** Headings are matched after case, width and invisible characters are folded away. */
function foldLine(line: string): string {
  return line.normalize("NFKC").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");
}

function isAtx(line: string): boolean {
  return /^ {0,3}#{1,6}(\s|$)/.test(foldLine(line));
}

function isRoleAtx(line: string): boolean {
  return /^ {0,3}#{1,6}[ \t]+role[ \t]*#*[ \t]*$/i.test(foldLine(line));
}

function isSetextUnderline(line: string): boolean {
  return /^ {0,3}(?:=+|-+)[ \t]*$/.test(foldLine(line));
}

function isSetextHeading(title: string, underline: string): boolean {
  const name = foldLine(title).trim();
  if (!name || isAtx(title)) return false;
  return isSetextUnderline(underline);
}

function isRoleSetext(title: string, underline: string): boolean {
  return isSetextHeading(title, underline) && /^role$/i.test(foldLine(title).trim());
}

function openingFence(line: string): { ch: "`" | "~"; len: number } | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(foldLine(line));
  if (!match) return null;
  const ch = match[2][0] as "`" | "~";
  if (ch === "`" && match[3].includes("`")) return null;
  return { ch, len: match[2].length };
}

function closingFence(line: string, open: { ch: "`" | "~"; len: number }): boolean {
  return new RegExp(`^ {0,3}\\${open.ch}{${open.len},}[ \\t]*$`).test(foldLine(line));
}

function hasRoleHeading(chunk: string): boolean {
  const lines = chunk.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (isRoleAtx(lines[i] ?? "")) return true;
    if (i + 1 < lines.length && isRoleSetext(lines[i] ?? "", lines[i + 1] ?? "")) return true;
  }
  return false;
}

type Span = { start: number; end: number };

/**
 * Closed comments and fences. An unclosed one is refused: a half-written soul is not saved.
 * A fence owns its lines, so a comment inside one is not a comment, and the reverse.
 */
function roleCarriers(text: string): { carriers: Span[]; unclosed: boolean } {
  const lines = text.split("\n");
  const offsets: number[] = [];
  let acc = 0;
  for (const line of lines) {
    offsets.push(acc);
    acc += line.length + 1;
  }
  const carriers: Span[] = [];
  let commentAt = -1;
  let fence: { ch: "`" | "~"; len: number; at: number } | null = null;
  const endOf = (n: number) => (n + 1 < lines.length ? offsets[n + 1] - 1 : text.length);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? "";
    const base = offsets[n] ?? 0;
    if (fence) {
      if (closingFence(line, fence)) {
        carriers.push({ start: fence.at, end: endOf(n) });
        fence = null;
      }
      continue;
    }
    if (commentAt >= 0) {
      const close = line.indexOf("-->");
      if (close >= 0) {
        carriers.push({ start: commentAt, end: base + close + 3 });
        commentAt = -1;
        const rest = line.slice(close + 3);
        const again = rest.indexOf("<!--");
        if (again >= 0) {
          const abs = base + close + 3 + again;
          const close2 = rest.indexOf("-->", again + 4);
          if (close2 >= 0) carriers.push({ start: abs, end: base + close + 3 + close2 + 3 });
          else commentAt = abs;
        }
      }
      continue;
    }
    const fenceOpen = openingFence(line);
    const comment = line.indexOf("<!--");
    if (fenceOpen && comment !== 0) {
      fence = { ...fenceOpen, at: base };
      continue;
    }
    if (comment >= 0) {
      const close = line.indexOf("-->", comment + 4);
      if (close >= 0) carriers.push({ start: base + comment, end: base + close + 3 });
      else commentAt = base + comment;
    }
  }
  return { carriers, unclosed: commentAt >= 0 || fence !== null };
}

function cutSpans(text: string, spans: readonly Span[]): string {
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of sorted) {
    if (span.start < 0 || span.end < span.start || span.end > out.length) continue;
    out = out.slice(0, span.start) + out.slice(span.end);
  }
  return out;
}

function isHeadingAt(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (isAtx(line)) return true;
  return index + 1 < lines.length && isSetextHeading(line, lines[index + 1] ?? "");
}

/** Every Role section, at any level, setext included, from its heading to the next heading. */
function removeRoleSections(text: string): string {
  const lines = text.split("\n");
  const drop = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const atx = isRoleAtx(lines[i] ?? "");
    const setext = i + 1 < lines.length && isRoleSetext(lines[i] ?? "", lines[i + 1] ?? "");
    if (!atx && !setext) continue;
    let j = i + (setext ? 2 : 1);
    while (j < lines.length && !isHeadingAt(lines, j)) j++;
    for (let k = i; k < j; k++) drop.add(k);
    i = j - 1;
  }
  return lines.filter((_, index) => !drop.has(index)).join("\n");
}

/** A leading "# Title" is not where the role goes. The role sits just before the next section, so nothing else lands in it. */
function isDocTitle(line: string): boolean {
  return /^ {0,3}#[ \t]+\S/.test(foldLine(line)) && !/^ {0,3}#{2,}/.test(foldLine(line)) && !isRoleAtx(line);
}

function insertCanonical(text: string): string {
  const lines = text.split("\n");
  let heading = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isHeadingAt(lines, i) || isRoleAtx(lines[i] ?? "")) continue;
    if (heading < 0 && isDocTitle(lines[i] ?? "")) continue;
    heading = i;
    break;
  }
  const block = `## Role\n${CAPTAIN_CHARTER}\n`;
  if (heading < 0) {
    const rest = lines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    return rest ? `${rest}\n\n${block}` : block;
  }
  const before = lines.slice(0, heading).join("\n").replace(/\n+$/, "");
  const after = lines.slice(heading).join("\n").replace(/^\n+/, "");
  return before ? `${before}\n\n${block}\n${after}` : `${block}\n${after}`;
}

/**
 * A soul that carries the charter keeps exactly one Role section, and it is exactly those words.
 * Headings are read after folding and trimming, at any level, including a setext Role.
 * A Role hidden in a comment or a fence is removed with that comment or fence.
 * An unclosed comment or fence is refused, so a half-written soul is not saved.
 * A soul that does not carry the charter is unchanged.
 */
export function withLockedRole(soul: string): string {
  const text = soul.replace(/\r\n?/g, "\n");
  if (!hasCaptainCharter(text)) return text;
  const found = roleCarriers(text);
  if (found.unclosed) throw new Error(UNCLOSED);
  const hiding = found.carriers.filter((span) => hasRoleHeading(text.slice(span.start, span.end)));
  return insertCanonical(removeRoleSections(cutSpans(text, hiding)));
}

/**
 * A soul write that would add the charter where it is not already.
 * Only a Mono that is already the captain may gain it. A soul that already has it may keep it.
 * Throws before the caller writes, so the file stays as it was.
 */
export function refuseAddedCharter(
  mono: { captain?: boolean; templateId?: string } | null | undefined,
  current: string | null | undefined,
  next: string | null | undefined,
): void {
  if (!hasCaptainCharter(next) || hasCaptainCharter(current) || isCaptainMono(mono)) return;
  throw new Error("Only the captain carries the charter. This soul was not saved.");
}

/** The coordinator starter, or a Mono flagged as the captain. The id and the display name do not count. */
export function isCaptainMono(
  mono: { id?: string; name?: string; captain?: boolean; templateId?: string } | null | undefined,
): boolean {
  if (!mono) return false;
  if (mono.captain === true) return true;
  return (mono.templateId ?? "").trim() === "coordinator";
}

/** The captain's display name, after width, invisible characters and extra spaces are folded away. */
export function isChiefOfStaffName(name: string): boolean {
  if (typeof name !== "string") return false;
  const folded = name
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  return folded === "chief of staff";
}

/** The personality section, or empty when the soul has none. The charter is not part of it. */
export function personalityOf(soul: string): string {
  const text = soul.replace(/\r\n?/g, "\n");
  const start = text.indexOf(PERSONALITY);
  if (start < 0) return "";
  const rest = text.slice(start + PERSONALITY.length);
  const next = rest.search(/\n## /);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

/**
 * Replaces only the personality section. The charter's place in the soul stays put.
 * A soul with no charter, or no personality section, is refused.
 */
export function applyPersonality(soul: string, personality: string): string {
  const text = soul.replace(/\r\n?/g, "\n");
  const charterAt = text.indexOf(CAPTAIN_CHARTER);
  if (charterAt < 0) throw new Error("This soul has no captain charter.");
  const start = text.indexOf(PERSONALITY);
  if (start < 0) throw new Error("This soul has no personality section.");
  const bodyStart = start + PERSONALITY.length;
  const rest = text.slice(bodyStart);
  const next = rest.search(/\n## /);
  const after = next < 0 ? "" : rest.slice(next);
  // A heading inside the personality would cut the following sections off. It is dropped, and so is anything after it.
  const clean = personality.replace(/\r\n?/g, "\n").split(/\n## /)[0]?.trim() ?? "";
  const nextSoul = `${text.slice(0, bodyStart)}${clean}\n${after}`;
  if (nextSoul.indexOf(CAPTAIN_CHARTER) !== charterAt) {
    throw new Error("The captain charter is fixed.");
  }
  return nextSoul;
}

/** The charter is not editable. Settings changes the personality beside it. */
export function editCharter(): never {
  throw new Error("The captain charter is fixed. Edit the personality beside it.");
}

/**
 * Puts the charter into a soul that does not have it yet. One that already has it is unchanged.
 * An existing coordinator gets it on load; a new one gets it from the starter template.
 */
export function ensureCaptainCharter(soul: string): string {
  const text = soul.replace(/\r\n?/g, "\n");
  if (text.includes(CAPTAIN_CHARTER)) return text;
  const role = "\n## Role\n";
  const at = text.indexOf(role);
  if (at >= 0) {
    const insertAt = at + role.length;
    return `${text.slice(0, insertAt)}${CAPTAIN_CHARTER}\n${text.slice(insertAt)}`;
  }
  const head = text.startsWith("# Soul") ? text : `# Soul\n\n${text}`;
  const nl = head.indexOf("\n");
  const insertAt = nl < 0 ? head.length : nl + 1;
  return `${head.slice(0, insertAt)}\n## Role\n${CAPTAIN_CHARTER}\n${head.slice(insertAt)}`;
}
