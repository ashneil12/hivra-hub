// PT-6: a living spec of record per project. Prompts and specs are the lasting artefact and code can be rebuilt from them,
// so a correction the person makes goes into the spec first and into the code second. The spec is plain Markdown in the
// project's own repo, one file per area under `docs/spec/` (or the project's `docs/specs/`, or a root `SPEC.md`) with a
// `README.md` index; each file is a title and `## <Section name>` sections, the heading being the section's stable id.
//
// A brief carries up to three spec parts, `{file, section, text}`: the section as it must read once the task is done.
// The engine is Rust (src-tauri/src/firstmate/spec_record.rs): it validates the same parts again, reads the project's current
// sections for the brief (`firstmate_spec_context`), keeps the parts on the task's row and holds the done check to them (the
// spec file must change and its section must hold the text). This module is what the webview does before a worker starts: it
// reads the parts in the same words Rust uses, reads the app's answer defensively, and writes the brief's "Spec of record"
// section (renderBrief in brief.ts places it).
import { normalPath } from "./briefChecks";

/** At most this many spec parts on one brief. */
export const SPEC_PARTS_MAX = 3;
/** The longest section text, in characters. */
export const SPEC_TEXT_MAX = 4_000;
/** The longest section name, in characters. */
export const SPEC_SECTION_MAX = 120;
/** The longest area name (a file's name without `.md`), in characters. */
const AREA_MAX = 80;
/** How much of a section's current text a brief shows, and of a context-only file. */
export const SPEC_CURRENT_MAX = 4_000;
export const SPEC_RELATED_MAX = 2_500;
const REFUSAL_MAX = 400;

/** The folders a spec lives in: the default, then the one a project may already keep. */
export const SPEC_FOLDERS = ["docs/spec", "docs/specs"] as const;
/** A project's single spec file, when it keeps one instead of a folder. */
export const SPEC_SINGLE_FILE = "SPEC.md";
/** The index beside the area files. */
export const SPEC_INDEX = "README.md";

/** The rule a worker's brief states: the spec first, in its own commit, then the code. */
export const SPEC_RULE = "Update the spec section first, in its own commit, then change the code to match it.";

/** A section of a spec file as it must read after the task. */
export type SpecPart = { file: string; section: string; text: string };

/** Where a project keeps its spec (`firstmate_spec_context`). */
export type SpecHome = { folder: string; singleFile: boolean; exists: boolean; index: boolean };
/** The current text of one section a brief touches, as the project's main checkout has it. */
export type SpecCurrent = { file: string; section: string; fileFound: boolean; found: boolean; text: string; cut: boolean };
/** A spec file whose `paths:` cover a brief with no spec part: its text, as context only. */
export type SpecRelated = { file: string; text: string; cut: boolean };
export type SpecContext = { home: SpecHome; refusal: string | null; current: SpecCurrent[]; related: SpecRelated[] };

/** What a brief says of the spec: its parts, and what the app read of the project's spec for them. */
export type SpecBrief = { parts: readonly SpecPart[]; context?: SpecContext | undefined };

// ---- validation (spec_record.rs `parse_deltas`) ------------------------------------------------------------------------------

function normWs(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** A section's name as a key: spacing collapsed, case ignored. */
function sectionKey(name: string): string {
  return normWs(name).toLowerCase();
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

/** A Windows device name is no file name there, whatever its extension. */
function reserved(name: string): boolean {
  const stem = name.split(".")[0].toUpperCase();
  return ["CON", "PRN", "AUX", "NUL"].includes(stem) || /^(?:COM|LPT)[1-9]$/.test(stem);
}

function areaProblem(stem: string): string | undefined {
  if (!stem) return "the file needs a name before .md.";
  if ([...stem].length > AREA_MAX) return `the file's name is longer than ${AREA_MAX} characters.`;
  if (/\s/.test(stem)) return "a file's name has no spaces: use hyphens, like login-flow.md.";
  if (/[\u0000-\u001f\u007f-\u009f<>:"|?*\\/]/.test(stem)) return "a file's name has a character that isn't allowed in a file name.";
  if (stem.startsWith(".") || stem.endsWith(".")) return "a file's name can't start or end with a dot.";
  if (reserved(stem)) return "that name is reserved on Windows.";
  return undefined;
}

/**
 * A spec file a brief names, validated: Markdown, directly under a spec folder (or the root `SPEC.md`), inside the project.
 * `..`, an absolute path, a drive and a control character are refused, as they are for `scope` and `leave`.
 */
export function specFile(raw: string): string {
  const path = normalPath(raw);
  if (path === SPEC_SINGLE_FILE) return path;
  for (const folder of SPEC_FOLDERS) {
    if (!path.startsWith(`${folder}/`)) continue;
    const rest = path.slice(folder.length + 1);
    if (rest.includes("/"))
      throw new Error(`"${path}" is in a sub-folder. A spec file sits directly in ${folder}/, one file per area: ${folder}/<area>.md.`);
    if (!rest.endsWith(".md")) throw new Error(`"${path}" isn't a Markdown file. Name it ${folder}/<area>.md.`);
    const stem = rest.slice(0, -3);
    if (stem.toLowerCase() === "readme")
      throw new Error(`${folder}/README.md is the index, and the worker keeps it. Name an area file, like ${folder}/<area>.md.`);
    const why = areaProblem(stem);
    if (why) throw new Error(`"${path}": ${why}`);
    return path;
  }
  throw new Error(
    `"${path}" isn't a spec file. A spec file is docs/spec/<area>.md (or the project's own: docs/specs/<area>.md, or SPEC.md).`,
  );
}

function sectionName(raw: string): string {
  if (/[\r\n]/.test(raw)) throw new Error("a spec part's section is one line: the name of one `##` heading.");
  const name = normWs(raw);
  if (!name) throw new Error("a spec part needs the section's name (section).");
  if (name.startsWith("#")) throw new Error("give the section's name without the `#` marks.");
  if ([...name].length > SPEC_SECTION_MAX) throw new Error(`the section's name is longer than ${SPEC_SECTION_MAX} characters.`);
  return name;
}

// ---- reading Markdown --------------------------------------------------------------------------------------------------------

/** Whether `line` opens or closes a fenced code block, and with which mark. */
function fenceMark(line: string): string | undefined {
  const trimmed = line.replace(/^ +/, "");
  if (line.length - trimmed.length > 3) return undefined;
  const mark = trimmed[0];
  if (mark !== "`" && mark !== "~") return undefined;
  let run = 0;
  while (trimmed[run] === mark) run += 1;
  if (run < 3) return undefined;
  // "```code```" on one line is inline code, not a fence.
  if (mark === "`" && trimmed.slice(run).includes("`")) return undefined;
  return mark;
}

/** An ATX heading's level (1 to 6) and title, closing `#`s taken off; none for any other line. */
function heading(line: string): { level: number; title: string } | undefined {
  const trimmed = line.replace(/^ +/, "");
  if (line.length - trimmed.length > 3) return undefined;
  let level = 0;
  while (trimmed[level] === "#") level += 1;
  if (level < 1 || level > 6) return undefined;
  const rest = trimmed.slice(level);
  if (rest && !/^[ \t]/.test(rest)) return undefined;
  const title = rest.trim();
  const bare = title.replace(/#+$/, "");
  return { level, title: bare.length < title.length && (!bare || /[ \t]$/.test(bare)) ? bare.trimEnd() : title };
}

/** The lines of a text, each with whether it sits in a fenced code block (a `## ` inside one is code, not a heading). */
function fencedLines(text: string): { line: string; fenced: boolean }[] {
  let open: string | undefined;
  return text.split(/\r\n|\r|\n/).map((line) => {
    const mark = fenceMark(line);
    if (open === undefined && mark !== undefined) {
      open = mark;
      return { line, fenced: true };
    }
    if (open !== undefined) {
      if (mark === open) open = undefined;
      return { line, fenced: true };
    }
    return { line, fenced: false };
  });
}

/**
 * The text of a part: the section's body, line endings read as one, its own heading taken off the top when it was sent with
 * it. A `#` or `##` heading inside would split the section, so it is refused.
 */
function sectionText(raw: string, section: string): string {
  if (raw.includes("\u0000")) throw new Error("a spec part's text has a null character.");
  const text = raw.replace(/\r\n|\r/g, "\n").trim();
  if (!text) throw new Error("a spec part needs the section as it must read (text).");
  if ([...text].length > SPEC_TEXT_MAX)
    throw new Error(
      `a spec part's text is longer than ${SPEC_TEXT_MAX} characters. Keep the section short, or split the area into two sections.`,
    );
  const lines = text.split("\n");
  const first = heading(lines[0]);
  if (first?.level === 2 && sectionKey(first.title) === sectionKey(section)) lines.shift();
  const body = lines.join("\n").trim();
  if (!body) throw new Error("a spec part needs the section as it must read (text).");
  if (fencedLines(body).some(({ line, fenced }) => !fenced && (heading(line)?.level ?? 9) <= 2))
    throw new Error("a spec part's text is the section's body: it has no `#` or `##` heading (use `###` for a part of it).");
  return body;
}

/** The spec parts of a tool call, validated: at most 3, each `{file, section, text}` and nothing else, no section twice. */
export function specParts(value: unknown): SpecPart[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("spec must be a list of {file, section, text}.");
  if (value.length > SPEC_PARTS_MAX)
    throw new Error(`Give at most ${SPEC_PARTS_MAX} spec parts on one brief; send the rest with the next task.`);
  const out: SpecPart[] = [];
  value.forEach((item, index) => {
    const number = index + 1;
    const own = (read: () => SpecPart): SpecPart => {
      try {
        return read();
      } catch (error) {
        throw new Error(`Spec part ${number}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    out.push(
      own(() => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("it must be {file, section, text}.");
        const object = item as Record<string, unknown>;
        const extra = Object.keys(object).find((key) => key !== "file" && key !== "section" && key !== "text");
        if (extra !== undefined) throw new Error(`it has file, section and text only; "${extra}" isn't one.`);
        const get = (key: "file" | "section" | "text"): string => {
          const found = object[key];
          if (typeof found !== "string") throw new Error(`${key} must be text.`);
          return found;
        };
        const file = specFile(get("file"));
        const section = sectionName(get("section"));
        const text = sectionText(get("text"), section);
        if (out.some((have) => samePath(have.file, file) && sectionKey(have.section) === sectionKey(section)))
          throw new Error(`"${section}" of ${file} is named twice. Send each section once.`);
        return { file, section, text };
      }),
    );
  });
  return out;
}

// ---- the app's answer ----------------------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cut(text: string, max: number, was: boolean): { text: string; cut: boolean } {
  const chars = [...text];
  return chars.length > max ? { text: chars.slice(0, max).join("").trimEnd(), cut: true } : { text, cut: was };
}

/** A spec file name read from the app's answer: one `specFile` accepts, or none. */
function trustedFile(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return specFile(value);
  } catch {
    return undefined;
  }
}

/**
 * What `firstmate_spec_context` answers, read defensively: a wrong shape is undefined (the brief then says to read the file
 * first). An entry that isn't text, or names a file outside a spec folder, is dropped; what is kept is capped.
 */
export function readSpecContext(value: unknown): SpecContext | undefined {
  if (!isRecord(value) || !isRecord(value.home) || !Array.isArray(value.current) || !Array.isArray(value.related)) return undefined;
  const { folder, singleFile, exists, index } = value.home;
  if (
    typeof folder !== "string" ||
    ![...SPEC_FOLDERS, SPEC_SINGLE_FILE].includes(folder as never) ||
    typeof singleFile !== "boolean" ||
    typeof exists !== "boolean" ||
    typeof index !== "boolean"
  )
    return undefined;
  const refusal = typeof value.refusal === "string" && value.refusal.trim() ? value.refusal.trim().slice(0, REFUSAL_MAX) : null;
  const current: SpecCurrent[] = [];
  for (const entry of value.current) {
    if (!isRecord(entry) || current.length >= SPEC_PARTS_MAX) continue;
    const file = trustedFile(entry.file);
    if (!file || typeof entry.section !== "string" || typeof entry.text !== "string") continue;
    if (typeof entry.fileFound !== "boolean" || typeof entry.found !== "boolean" || typeof entry.cut !== "boolean") continue;
    const capped = cut(entry.text, SPEC_CURRENT_MAX, entry.cut);
    current.push({ file, section: entry.section, fileFound: entry.fileFound, found: entry.found, ...capped });
  }
  const related: SpecRelated[] = [];
  for (const entry of value.related) {
    if (!isRecord(entry) || related.length >= 3) continue;
    const file = trustedFile(entry.file);
    if (!file || typeof entry.text !== "string" || typeof entry.cut !== "boolean") continue;
    related.push({ file, ...cut(entry.text, SPEC_RELATED_MAX, entry.cut) });
  }
  return { home: { folder, singleFile, exists, index }, refusal, current, related };
}

// ---- the brief's section -------------------------------------------------------------------------------------------------------

/** Every line of `text` indented, so nothing in it can open a heading or a block of the brief's own. */
function indented(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => `    ${line}`)
    .join("\n");
}

/** What the worker is told about one section's current text. */
function nowLines(part: SpecPart, context: SpecContext | undefined): string {
  const current = context?.current.find((entry) => samePath(entry.file, part.file) && sectionKey(entry.section) === sectionKey(part.section));
  if (!context || !current) return indented("(Not shown here: read the file first.)");
  if (current.found) return `${indented(current.text)}${current.cut ? `\n${indented("(cut: read the file for the rest)")}` : ""}`;
  if (current.fileFound) return indented(`(This section isn't in the file yet: add it under a "## ${part.section}" heading.)`);
  const { home } = context;
  const index = home.singleFile
    ? ""
    : home.index
      ? ` Also add one line for it to the index, ${home.folder}/${SPEC_INDEX}.`
      : ` Also create the index ${home.folder}/${SPEC_INDEX} with a title and one line for this file.`;
  return indented(
    `(This file doesn't exist yet: create it with a title, then this section under a "## ${part.section}" heading.${index} Start the file with a front-matter line "paths: <the code areas it covers>".)`,
  );
}

/**
 * The worker's "Spec of record" section: for a brief with spec parts, the rule and each section's current text and the text it
 * must read; for a brief with none whose scope the spec covers, those files as context only. None when there is nothing to say.
 */
export function specSection(spec: SpecBrief): string | undefined {
  const { parts, context } = spec;
  if (parts.length) {
    const where = !context
      ? "This project keeps a spec of record in its repo."
      : context.home.exists
        ? `This project keeps its spec of record in ${context.home.singleFile ? context.home.folder : `${context.home.folder}/`}.`
        : `This project has no spec of record yet. It starts in ${context.home.folder}/ with this task.`;
    return [
      "## Spec of record",
      `${where} ${SPEC_RULE} Each section below must read as given under "Must read" when you are done: the app checks that each file below changed and that its section holds that text (spacing aside).`,
      ...parts.flatMap((part) => ["", `### ${part.file}, ${part.section}`, "Now:", nowLines(part, context), "Must read:", indented(part.text)]),
    ].join("\n");
  }
  if (!context?.related.length) return undefined;
  return [
    "## Spec of record",
    "The spec files below cover code this brief names. They are context only: read them and keep to what they say. Change none of them unless this brief asks.",
    ...context.related.flatMap((file) => ["", `### ${file.file}`, indented(file.text), ...(file.cut ? [indented("(cut: read the file for the rest)")] : [])]),
  ].join("\n");
}
