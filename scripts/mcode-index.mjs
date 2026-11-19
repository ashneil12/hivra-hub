// WP-117: the skill index for the MiniMax skills in hivra-mcode, generated the way pstack's is (scripts/pstack-index.mjs)
// so it cannot drift from the copied plugin. Run: node scripts/mcode-index.mjs
// Each skill carries disable-model-invocation, so Claude Code does not offer it to the model itself: this index is how
// a session learns each one exists and where its SKILL.md is. The app bundles the JSON; a session fills in the folder.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { skillEntries } from "./pstack-index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, "../src-tauri/plugins/hivra-mcode/skills");
const OUT = join(HERE, "../src/features/plugins/model/mcodeIndex.generated.json");

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const entries = skillEntries(SKILLS);
  writeFileSync(OUT, `${JSON.stringify(entries, null, 2)}\n`);
  process.stdout.write(`${entries.length} skills\n`);
}
