// WP-41: the pstack skill index, generated from each SKILL.md frontmatter so it cannot drift from the
// pinned plugin. Run: node scripts/pstack-index.mjs
// The app bundles the JSON; a session fills in the absolute path of the installed copy.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, "../src-tauri/plugins/pstack/skills");
const OUT = join(HERE, "../src/features/plugins/model/pstackIndex.generated.json");

/** The first frontmatter block. Later `description:` lines in the body are examples, not the skill. */
export function parseFrontmatter(text) {
  const normalised = String(text)
    .replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!normalised.startsWith("---\n")) return undefined;
  const end = normalised.indexOf("\n---", 4);
  if (end < 0) return undefined;
  const fields = {};
  let key;
  for (const line of normalised.slice(4, end).split("\n")) {
    const headed = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (headed && !/^[\t ]/.test(line)) {
      key = headed[1];
      fields[key] = unquote(headed[2]);
    } else if (key && /^[\t ]/.test(line)) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  const name = fields.name?.trim();
  const description = fields.description?.replace(/\s+/g, " ").trim();
  if (!name || !description) return undefined;
  return { name, description };
}

function unquote(value) {
  const text = value.trim();
  if (text === ">" || text === "|" || text === "|-" || text === ">-") return "";
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const body = text.slice(1, -1);
    return text.startsWith('"') ? body.replace(/\\"/g, '"').replace(/\\n/g, " ") : body;
  }
  return text;
}

/**
 * What the skill is for, and when to reach for it, from its description. A description with no
 * when-clause keeps the same words in both, so every line still has both.
 */
export function splitPurpose(description) {
  const text = description.replace(/\s+/g, " ").trim();
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const whenAt = sentences.findIndex((sentence) =>
    /\b(?:Apply|Use)(?:\s+only)?\s+(?:when|for|before|after|to)\b/i.test(sentence),
  );
  if (whenAt < 0) return { for: text, when: text };
  const whenSentence = sentences[whenAt];
  const rest = sentences.filter((_, index) => index !== whenAt).join(" ").trim();
  if (rest) return { for: rest, when: whenSentence };
  const cut = whenSentence.search(/\b(?:Apply|Use)(?:\s+only)?\s+(?:when|for|before|after|to)\b/i);
  if (cut <= 0) return { for: whenSentence, when: whenSentence };
  const purpose = whenSentence.slice(0, cut).replace(/[\s.,:;]+$/, "").trim();
  return { for: purpose || whenSentence, when: whenSentence.slice(cut).trim() };
}

/** One entry per skill directory. Throws if a skill has no usable frontmatter or a name is repeated. */
export function skillEntries(skillsDir = SKILLS) {
  const dirs = readdirSync(skillsDir)
    .filter((name) => {
      if (name === "." || name === ".." || name.split(/[/\\]/).includes("..")) return false;
      const skill = join(skillsDir, name, "SKILL.md");
      try {
        return statSync(skill).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const seen = new Set();
  return dirs.map((dir) => {
    const text = readFileSync(join(skillsDir, dir, "SKILL.md"), "utf8");
    const front = parseFrontmatter(text);
    if (!front) throw new Error(`${dir}/SKILL.md has no name and description in its frontmatter`);
    if (seen.has(front.name)) throw new Error(`Two pstack skills are named ${front.name}`);
    seen.add(front.name);
    const purpose = splitPurpose(front.description);
    return { name: front.name, for: purpose.for, when: purpose.when, rel: `skills/${dir}/SKILL.md` };
  }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const entries = skillEntries();
  writeFileSync(OUT, `${JSON.stringify(entries, null, 2)}\n`);
  process.stdout.write(`${entries.length} skills\n`);
}
