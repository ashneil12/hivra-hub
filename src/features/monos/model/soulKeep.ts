// WP-21: a template update may replace SOUL.md or MEMORY.md only when the file is missing, or when it
// is exactly a known template (Mercury). A person's edit stays. A write that does not land is a retry.

import { needsMigration, normalizeSoulText } from "./vendor/mercurySoul";

export type KeptFile = {
  /** null: the file is not on disk yet. */
  text: string | null;
  hash: string;
};

export type WriteOutcome = "wrote" | "kept" | "retry";

/** True when the file is on disk and is not an exact known template. A missing file is not an edit. */
export function keepsEditedSoul(text: string | null | undefined, knownTemplates: readonly string[]): boolean {
  if (text == null) return false;
  return !needsMigration(text, knownTemplates);
}

/**
 * Replace `current` with `next` only when the file is missing or is one of `knownTemplates`.
 * `write` returns false when the file changed since it was read: that is a retry, and the text stays.
 */
export async function updateFileFromTemplate(
  current: KeptFile,
  next: string,
  knownTemplates: readonly string[],
  write: (text: string, expectedHash: string) => Promise<boolean>,
): Promise<{ outcome: WriteOutcome; text: string | null }> {
  if (keepsEditedSoul(current.text, knownTemplates)) return { outcome: "kept", text: current.text };
  if (current.text != null && normalizeSoulText(current.text) === normalizeSoulText(next)) {
    return { outcome: "kept", text: current.text };
  }
  const landed = await write(next, current.hash);
  if (!landed) return { outcome: "retry", text: current.text };
  return { outcome: "wrote", text: next };
}

const TEMPLATE_FILES = ["SOUL.md", "MEMORY.md"] as const;
export type TemplateFileName = (typeof TEMPLATE_FILES)[number];

/**
 * A template update of one Mono's soul and memory. `memoryTemplate` null never writes MEMORY.md.
 * The writer is only ever asked for those two names.
 */
export async function applyMonoTemplateUpdate(input: {
  soul: KeptFile;
  memory: KeptFile;
  soulTemplate: string;
  memoryTemplate: string | null;
  knownSouls: readonly string[];
  knownMemories: readonly string[];
  write: (file: TemplateFileName, text: string, expectedHash: string) => Promise<boolean>;
}): Promise<{ soul: WriteOutcome; memory: WriteOutcome }> {
  const soul = await updateFileFromTemplate(input.soul, input.soulTemplate, input.knownSouls, (text, hash) =>
    input.write("SOUL.md", text, hash),
  );
  if (input.memoryTemplate == null) return { soul: soul.outcome, memory: "kept" };
  const memory = await updateFileFromTemplate(
    input.memory,
    input.memoryTemplate,
    input.knownMemories,
    (text, hash) => input.write("MEMORY.md", text, hash),
  );
  return { soul: soul.outcome, memory: memory.outcome };
}
