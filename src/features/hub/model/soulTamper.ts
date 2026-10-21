// The soul tamper check (Alfred's idea, the CoS's guard on it). The app keeps the hash of every soul it saves
// (monos/model/soulSaved.ts). When it reads or opens a soul whose file no longer matches, something other than the app
// changed it, and the file's change time is set against when chats were running (monos/model/sessionRuns.ts):
// - an agent or worker chat was running then: the last saved soul is put back, the changed file is kept beside it in
//   that Mono's memory, and one Bot changes row says so, whose button ("Keep that change") brings the change back;
// - nothing was running: it was Ash editing the file by hand. His version is kept and becomes the saved one, with a
//   row whose Undo goes back to what the app last saved. Ash's edits always win.
// A Mono the app has no saved soul for yet (first launch with this, or storage cleared) just has its file recorded.
import { listMonos, monoLook } from "../../monos/model/mono";
import { readAgentFile, setSoulOpenCheck, writeAgentFile, type AgentFilePath } from "../../monos/model/monoFiles";
import { recordSavedSoul, savedSoul } from "../../monos/model/soulSaved";
import { runsAt, type RunWindow } from "../../monos/model/sessionRuns";
import { recordBotChange } from "./botChanges";

export type TamperFiles = {
  read(monoId: string, path: AgentFilePath): Promise<{ text: string | null; hash: string; modifiedMs?: number }>;
  write(monoId: string, path: AgentFilePath, text: string, expectedHash?: string): Promise<string>;
};

export type SoulCheck = "unchanged" | "recorded" | "put-back" | "kept-ash" | "skipped";

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

/** Where the changed file is kept when the saved soul is put back. */
export function changedSoulNote(at: number): AgentFilePath {
  return `memory/soul-changed-outside-${stamp(at)}.md`;
}

export function putBackLine(name: string): string {
  return `Something outside the app changed ${name}'s soul while a worker was running, so it was put back.`;
}

export function keptAshLine(name: string): string {
  return `${name}'s soul was edited outside the app. Kept your version.`;
}

/** One Mono's soul, checked against the last one the app saved. */
export async function checkSoul(
  monoId: string,
  name: string,
  files: TamperFiles = { read: readAgentFile, write: writeAgentFile },
  running: (at: number) => RunWindow[] = (at) => runsAt(at),
  now: number = Date.now(),
): Promise<SoulCheck> {
  const soul = await files.read(monoId, "SOUL.md");
  const saved = savedSoul(monoId);
  if (soul.text == null) return "skipped";
  if (!saved) {
    recordSavedSoul(monoId, soul.text, soul.hash, now);
    return "recorded";
  }
  if (soul.hash === saved.hash) return "unchanged";
  // Only the text matters (a hash format change, or the same text saved again, is no tamper).
  if (soul.text === saved.text) {
    recordSavedSoul(monoId, soul.text, soul.hash, now);
    return "unchanged";
  }
  const changedAt = soul.modifiedMs ?? now;
  const runs = running(changedAt);
  if (runs.length) {
    // 1. The changed file, kept beside it in its memory (never lost).
    const note = changedSoulNote(changedAt);
    const existing = await files.read(monoId, note);
    if (existing.text !== soul.text) await files.write(monoId, note, soul.text, existing.hash);
    // 2. The last saved soul back, over the changed one only.
    await files.write(monoId, "SOUL.md", saved.text, soul.hash);
    const back = await files.read(monoId, "SOUL.md");
    if (back.text !== saved.text) return "skipped";
    recordSavedSoul(monoId, saved.text, back.hash, now);
    recordBotChange({
      id: `soul-put-back:${monoId}:${soul.hash}`,
      bot: name,
      day: "Today",
      line: putBackLine(name),
      now: "Changed from outside the app",
      after: "Back to the soul the app last saved",
      details: [
        `${runs.length === 1 ? "A chat was" : `${runs.length} chats were`} running when it changed.`,
        `The changed version is kept in ${name}'s memory, and "Keep that change" brings it back.`,
      ],
      undoLabel: "Keep that change",
      undoneText: `Kept the outside change to ${name}'s soul.`,
      monoId,
      file: "SOUL.md",
      beforeText: soul.text,
      afterText: saved.text,
      at: now,
    });
    return "put-back";
  }
  recordSavedSoul(monoId, soul.text, soul.hash, now);
  recordBotChange({
    id: `soul-outside:${monoId}:${soul.hash}`,
    bot: name,
    day: "Today",
    line: keptAshLine(name),
    now: "The soul the app last saved",
    after: "Your version",
    details: ["No chat was running when it changed, so it was you. Undo goes back to the soul the app last saved."],
    undoneText: `Undone: ${name}'s soul is back to how the app last saved it.`,
    monoId,
    file: "SOUL.md",
    beforeText: saved.text,
    afterText: soul.text,
    at: now,
  });
  return "kept-ash";
}

/**
 * A portable restore wrote these Monos' souls (some from Rust, which the app's own save path never sees): each soul as
 * it now stands is the app's save, so no "edited outside the app" row appears and nothing is put back.
 */
export async function recordRestoredSouls(
  monoIds: readonly string[],
  files: Pick<TamperFiles, "read"> = { read: readAgentFile },
  now: number = Date.now(),
): Promise<void> {
  for (const id of new Set(monoIds)) {
    try {
      const soul = await files.read(id, "SOUL.md");
      if (soul.text != null) recordSavedSoul(id, soul.text, soul.hash, now);
    } catch {
      /* unreadable now: its next check records it, or treats it as Ash's */
    }
  }
}

/** Opening a Mono's files checks its soul first (monoFiles.ts readMonoFiles). */
export function watchSoulOpens(): void {
  setSoulOpenCheck(async (monoId) => {
    const mono = listMonos().find((m) => m.id === monoId);
    if (mono) await checkSoul(monoId, monoLook(mono).name);
  });
}

/** Every Mono's soul, before anything else reads them at launch. One that can't be read is checked next time. */
export async function checkSouls(
  monos: readonly { id: string; name?: string }[] = listMonos().map((m) => ({ id: m.id, name: monoLook(m).name })),
  files?: TamperFiles,
): Promise<Record<string, SoulCheck>> {
  const out: Record<string, SoulCheck> = {};
  for (const m of monos) {
    try {
      out[m.id] = await checkSoul(m.id, m.name?.trim() || m.id, files);
    } catch {
      /* moved or unreadable now: the next read checks it */
    }
  }
  return out;
}
