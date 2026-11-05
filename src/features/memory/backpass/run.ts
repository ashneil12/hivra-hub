// WP-83: turn a model's staging copy into measured proposals.
// The model's own find and replace is never read. A path it names that this
// run did not name is ignored. Disk values are checked before they are used.

import { learn, type Proposal, type Transcript } from "./learn";
import { emptyGapLedger, type GapLedger } from "./ledger";
import { emptyRejections, type Rejections } from "./rejection";
import type { FileRole } from "./scope";
import { samePath } from "./scope";
import { estimateTokensFromBytes } from "./tokens";

/** WP-50's read cap. A cost estimate never counts more than one read of a file. */
const MAX_READ_BYTES = 32 * 1024 * 1024;

export type CostChat = { source: string; root: string; rel: string; bytes: number };

/** Distinct backing files. OpenCode and Cursor's IDE share one store across rows. */
export function costOf(chats: readonly CostChat[]): number {
  const seen = new Set<string>();
  let bytes = 0;
  for (const chat of chats) {
    if (!chat || typeof chat.root !== "string" || typeof chat.rel !== "string") continue;
    const source = typeof chat.source === "string" ? chat.source : "";
    const key =
      source === "opencode" || source === "cursor-ide" ? `${source}\0${chat.root}` : `${chat.root}\0${chat.rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const size = typeof chat.bytes === "number" && Number.isFinite(chat.bytes) && chat.bytes > 0 ? chat.bytes : 0;
    bytes += Math.min(size, MAX_READ_BYTES);
  }
  return estimateTokensFromBytes(bytes);
}

export type ModelFile = {
  file: string;
  title: string;
  staged: string;
  sightings: { sessionId: string; quote: string; proposedInstruction: string }[];
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Untrusted model text. Anything that is not the expected shape is dropped. */
export function parseModelFiles(text: string): ModelFile[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const root = asObject(parsed);
  const files = root && Array.isArray(root.files) ? root.files : [];
  const out: ModelFile[] = [];
  for (const item of files) {
    const row = asObject(item);
    if (!row || typeof row.file !== "string" || typeof row.staged !== "string") continue;
    if (!row.file || row.file.includes("\0")) continue;
    const sightings = Array.isArray(row.sightings) ? row.sightings : [];
    const clean: ModelFile["sightings"] = [];
    for (const sighting of sightings) {
      const seen = asObject(sighting);
      if (!seen) continue;
      if (
        typeof seen.sessionId !== "string" ||
        typeof seen.quote !== "string" ||
        typeof seen.proposedInstruction !== "string"
      ) {
        continue;
      }
      if (!seen.sessionId || seen.sessionId.includes("\0")) continue;
      clean.push({
        sessionId: seen.sessionId,
        quote: seen.quote,
        proposedInstruction: seen.proposedInstruction,
      });
    }
    const title = typeof row.title === "string" ? row.title.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    out.push({ file: row.file, title, staged: row.staged, sightings: clean });
  }
  return out;
}

export function lessonPrompt(
  files: readonly { path: string; text: string }[],
  transcripts: readonly Transcript[],
): string {
  const named = files.map((file) => `File ${file.path}:\n${file.text}`).join("\n\n");
  const chats = transcripts.map((chat) => `Chat ${chat.id}:\n${chat.text}`).join("\n\n");
  return [
    "Propose small edits to the named files only. Do not mention any other path.",
    "Reply with JSON only:",
    '{"files":[{"file":"the path","title":"short title","staged":"the full new file","sightings":[{"sessionId":"id","quote":"verbatim words from that chat","proposedInstruction":"the lesson"}]}]}',
    "A quote must be copied from that chat. A change needs two different chats.",
    'If nothing should change, reply {"files":[]}.',
    "",
    named,
    "",
    chats,
  ].join("\n");
}

export type NamedFile = { path: string; role: FileRole; original: string; picked?: boolean };

export function parseLedger(value: unknown): GapLedger {
  const root = asObject(value);
  if (!root || root.version !== 1 || !asObject(root.entries)) return emptyGapLedger();
  return { version: 1, entries: root.entries as GapLedger["entries"] };
}

export function parseRejections(value: unknown): Rejections {
  const root = asObject(value);
  const entries = asObject(root?.entries);
  if (!entries) return emptyRejections();
  const clean = emptyRejections();
  for (const [key, entry] of Object.entries(entries)) {
    const row = asObject(entry);
    if (!row || typeof row.kind !== "string" || typeof row.file !== "string") continue;
    if (typeof row.transcripts !== "number" || !Number.isFinite(row.transcripts)) continue;
    if (typeof row.rejectedAt !== "string") continue;
    clean.entries[key] = {
      kind: row.kind,
      file: row.file,
      transcripts: row.transcripts,
      rejectedAt: row.rejectedAt,
      ...(typeof row.title === "string" ? { title: row.title } : {}),
      ...(Array.isArray(row.gapIds) ? { gapIds: row.gapIds.filter((id): id is string => typeof id === "string") } : {}),
    };
  }
  return clean;
}

/**
 * Measure only files this run named. A plugin path is refused by the scope
 * check inside learn, and the refusal is returned rather than applied.
 */
export function measureRun(input: {
  named: readonly NamedFile[];
  modelText: string;
  transcripts: readonly Transcript[];
  ledger: GapLedger;
  rejections: Rejections;
  pluginRoots: readonly string[];
  now: string;
}): { proposals: Proposal[]; ledger: GapLedger; refused: string | null } {
  const asked = parseModelFiles(input.modelText);
  let ledger = input.ledger;
  const proposals: Proposal[] = [];
  let refused: string | null = null;
  const scope = {
    files: input.named.map((file) => ({ path: file.path, role: file.role, picked: file.picked })),
    pluginRoots: [...input.pluginRoots],
  };
  for (const file of input.named) {
    const match = asked.find((item) => samePath(item.file, file.path));
    if (!match) continue;
    const result = learn({
      transcripts: [...input.transcripts],
      sightings: match.sightings,
      file: file.path,
      role: file.role,
      original: file.original,
      staged: match.staged,
      title: match.title || "Lesson",
      ledger,
      rejections: input.rejections,
      scope,
      now: input.now,
    });
    ledger = result.ledger;
    if (result.refused && !refused) refused = result.refused;
    for (const proposal of result.proposals) {
      proposals.push({ ...proposal, id: `${proposal.file}:${proposal.id}` });
    }
  }
  return { proposals, ledger, refused };
}
