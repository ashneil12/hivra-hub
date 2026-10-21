// "Ask Alfred to merge it": the one way a Mono's soul is changed by another Mono (Alfred's lane: he looks after souls).
//
// Soul refresh leaves a soul alone when it can't tell Ash's own edits from old app wording (soulRefresh.ts). Ash then
// asks Alfred ("merge hivra leads update"). Alfred reads the soul and the app's newer version (`souls.read`) and writes
// one soul that takes the app's new wording and keeps every change Ash made himself, his wording winning wherever the
// two clash; he hands it to the app (`souls.merge`). The app, not Alfred, decides whether it goes in:
// - only Alfred's own chat may ask (never a habit run, a worker, another Mono, or Alfred for his own soul);
// - the soul must still be the one Alfred read (the read-before-write guard: an edit Ash made meanwhile refuses it);
// - the merged soul is a soul (opens with "# Soul", not blank, not huge) and is made only of lines from the current
//   soul or the app's template, so nothing new is invented, and every section Ash added himself is still in it;
// - the whole old soul is saved in that Mono's memory first, the template it now follows is recorded (so later
//   refreshes know Ash's edits), and one plain Bot changes row with Undo and Redo says what changed.
// The souls' home stays out of every chat's write reach (hubMcp.ts monoHomeDeniedTools); this action is the app's own
// hash-checked write (mono.rs check_write behind it).
import { listMonos } from "../../monos/model/mono";
import type { AgentFilePath } from "../../monos/model/monoFiles";
import { recordBotChange } from "./botChanges";
import {
  saveOldSoul,
  sectionSentence,
  SOUL_TEMPLATE_FILE,
  soulSections,
  soulTemplates,
  templateFingerprint,
  undoneSoulLine,
  type SoulFiles,
  type SoulTemplate,
} from "./soulRefresh";
import { forUser } from "./userName";

/** The Mono whose lane is looking after souls. By id only: a Mono can rename itself, not change its id. */
export const SOUL_KEEPER_ID = "alfred";
export const SOUL_KEEPER_NAME = "Alfred";
const MAX_SOUL = 240_000;

export class SoulMergeRefused extends Error {}

const norm = (text: string) => text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
const lines = (text: string) => norm(text).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
const heading = (key: string) => key.replace(/^## /, "");

/** Why the app won't take this merged soul, in plain words; undefined when it passes. */
export function checkMergedSoul(current: string, template: string, merged: string): string | undefined {
  if (merged.includes("\0") || !merged.trim()) return "The merged soul is blank.";
  if (merged.length > MAX_SOUL) return "The merged soul is too long.";
  if (!/^# Soul\s*\n/.test(merged.replace(/\r\n/g, "\n"))) return 'The merged soul must open with "# Soul", like every soul.';
  if (norm(merged) === norm(current)) return "The merged soul is the same as the soul it has now; there is nothing to merge.";
  const allowed = new Set([...lines(current), ...lines(template)]);
  const invented = lines(merged).find((l) => !allowed.has(l));
  if (invented !== undefined)
    return `The merged soul has a line that is in neither its soul nor the app's newer version: "${invented.slice(0, 120)}". Merge only, never add.`;
  const templateKeys = new Set(soulSections(template).map((s) => s.key));
  const mergedKeys = new Set(soulSections(merged).map((s) => s.key));
  const lost = soulSections(current).find((s) => s.key && !templateKeys.has(s.key) && !mergedKeys.has(s.key));
  if (lost) return forUser`The merged soul leaves out "${heading(lost.key)}", a part Ash added himself. Keep it.`;
  return undefined;
}

/** What the merge did, section by section: taken from the app, kept as Ash had it, or combined. */
export function describeMerge(current: string, template: string, merged: string, name: string): { line: string; details: string[] } {
  const cur = new Map(soulSections(current).map((s) => [s.key, norm(s.text)]));
  const tpl = new Map(soulSections(template).map((s) => [s.key, norm(s.text)]));
  const taken: string[] = [];
  const kept: string[] = [];
  const combined: string[] = [];
  for (const s of soulSections(merged)) {
    const text = norm(s.text);
    const mine = cur.get(s.key);
    const app = tpl.get(s.key);
    if (app === undefined || mine === app) continue; // his own part, or nothing to merge there
    if (text === app) taken.push(s.key);
    else if (text === mine) kept.push(s.key);
    else combined.push(s.key);
  }
  const quote = (key: string) => (key ? `'${heading(key)}'` : "its opening");
  const list = (keys: string[]) =>
    keys.length <= 1 ? keys.map(quote).join("") : `${keys.slice(0, -1).map(quote).join(", ")} and ${quote(keys[keys.length - 1])}`;
  const yours = [...kept, ...combined];
  const line = `${SOUL_KEEPER_NAME} merged the app's update into ${name}'s soul${yours.length ? ` and kept your changes to ${list(yours)}` : ""}.`;
  const details = [
    ...taken.map((key) => sectionSentence(key, name)),
    ...combined.map((key) => `${name}'s ${quote(key)} part now has the app's update with your own changes kept.`),
    ...kept.map((key) => `Your own wording of ${name}'s ${quote(key)} part stays as you wrote it.`),
    `The old soul is saved in ${name}'s memory, and Undo puts it back.`,
  ];
  return { line, details };
}

export type SoulMergeCaller = { monoId: string | undefined; isOwnChat: boolean };

function keeperOnly(caller: SoulMergeCaller, target: string): void {
  if (caller.monoId !== SOUL_KEEPER_ID || !caller.isOwnChat)
    throw new SoulMergeRefused(`Only ${SOUL_KEEPER_NAME}'s own chat can merge a Mono's soul update.`);
  if (target === SOUL_KEEPER_ID) throw new SoulMergeRefused(forUser("Change your own soul with soul.update when Ash asks."));
}

function templateFor(target: string, templates: SoulTemplate[]): SoulTemplate {
  const t = templates.find((x) => x.monoId === target);
  if (!t) throw new SoulMergeRefused(`"${target}" has no app soul to merge: only the team, the project Leads and the checker do.`);
  return t;
}

/** `souls.read`: the soul as it is, its hash (pass it back to souls.merge) and the app's newer version. */
export async function readForMerge(
  caller: SoulMergeCaller,
  target: string,
  files: SoulFiles,
  templates: SoulTemplate[] = soulTemplates(listMonos()),
): Promise<{ mono: string; name: string; soul: string; hash: string; appVersion: string; sameAsApp: boolean }> {
  keeperOnly(caller, target);
  const t = templateFor(target, templates);
  const soul = await files.read(target, "SOUL.md");
  if (soul.text == null) throw new SoulMergeRefused(`${t.name} has no soul yet.`);
  return { mono: target, name: t.name, soul: soul.text, hash: soul.hash, appVersion: t.template, sameAsApp: norm(soul.text) === norm(t.template) };
}

/** `souls.merge`: the app checks Alfred's merged soul, saves the old one, writes it, and logs one row with Undo. */
export async function mergeSoul(
  caller: SoulMergeCaller,
  input: { mono: string; text: string; expectedHash: string },
  files: SoulFiles,
  templates: SoulTemplate[] = soulTemplates(listMonos()),
  now: Date = new Date(),
): Promise<{ mono: string; merged: true; line: string; details: string[] }> {
  keeperOnly(caller, input.mono);
  const t = templateFor(input.mono, templates);
  const soul = await files.read(input.mono, "SOUL.md");
  if (soul.text == null) throw new SoulMergeRefused(`${t.name} has no soul yet.`);
  if (soul.hash !== input.expectedHash)
    throw new SoulMergeRefused(forUser`${t.name}'s soul changed since you read it (Ash may be editing it). Nothing was saved; read it again with souls.read.`);
  const problem = checkMergedSoul(soul.text, t.template, input.text);
  if (problem) throw new SoulMergeRefused(`${problem} Nothing was saved.`);
  const tag = `merge-${templateFingerprint(input.text)}`;
  if (!(await saveOldSoul(files, input.mono, soul.text, now, tag)))
    throw new SoulMergeRefused(`${t.name}'s old soul couldn't be saved first, so nothing was changed.`);
  try {
    await files.write(input.mono, "SOUL.md", input.text, soul.hash);
  } catch {
    throw new SoulMergeRefused(forUser`${t.name}'s soul changed while merging (Ash may be editing it). Nothing was saved; read it again with souls.read.`);
  }
  if ((await files.read(input.mono, "SOUL.md")).text !== input.text)
    throw new SoulMergeRefused(`${t.name}'s soul didn't take the merge. Read it again with souls.read.`);
  const record = await files.read(input.mono, SOUL_TEMPLATE_FILE as AgentFilePath);
  await files.write(input.mono, SOUL_TEMPLATE_FILE, t.template, record.hash).catch(() => undefined);
  const { line, details } = describeMerge(soul.text, t.template, input.text, t.name);
  recordBotChange({
    id: `soul-merge:${input.mono}:${now.getTime().toString(36)}`,
    bot: SOUL_KEEPER_NAME,
    day: "Today",
    line,
    now: "Its soul as it was",
    after: "Its soul with the app's update merged in",
    undoneText: undoneSoulLine(t.name),
    details,
    monoId: input.mono,
    file: "SOUL.md",
    beforeText: soul.text,
    afterText: input.text,
  });
  return { mono: input.mono, merged: true, line, details };
}
