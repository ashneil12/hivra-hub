// WP-51: accept, reject, edit, delete, search. A skill is not written here; the screen writes it only after an accept.

import { ftsMatch } from "../vendor/mercuryBelief";
import { bump, memoryId, mentionsSecret, normalizeFact, parseDoc, type MemoryDoc, type MemoryItem } from "./doc";

const CITE = /\[src:\s+[A-Za-z0-9._:-]+\s+#[A-Za-z0-9._:-]+\]/;
const IMPORT_ID = /^[a-z0-9-]{1,80}$/;
const PROJECT = /^[a-z0-9-]{1,64}$/;

export type AcceptResult = { doc: MemoryDoc; skill?: { name: string; lesson: string } };

function replaceItem(doc: MemoryDoc, next: MemoryItem): MemoryDoc {
  return bump({ ...doc, items: doc.items.map((item) => (item.id === next.id ? next : item)) });
}

export function acceptItem(doc: MemoryDoc, id: string, now: number): AcceptResult {
  const item = doc.items.find((candidate) => candidate.id === id);
  if (!item || item.state !== "unreviewed") return { doc };
  if (item.action === "skill" && item.skill) {
    return { doc: replaceItem(doc, { ...item, state: "confirmed", updatedAt: now }), skill: { ...item.skill } };
  }
  if (item.action === "add") return { doc: replaceItem(doc, { ...item, state: "confirmed", updatedAt: now }) };
  if (item.action === "update" && item.targetId) {
    const target = doc.items.find((candidate) => candidate.id === item.targetId && candidate.action === "add");
    const rest = doc.items.filter((candidate) => candidate.id !== item.id);
    if (!target) return { doc: bump({ ...doc, items: rest }) };
    return {
      doc: bump({
        ...doc,
        items: rest.map((candidate) =>
          candidate.id === target.id ? { ...candidate, text: item.text, state: "edited" as const, updatedAt: now } : candidate,
        ),
      }),
    };
  }
  if (item.action === "remove" && item.targetId) {
    return { doc: bump({ ...doc, items: doc.items.filter((candidate) => candidate.id !== item.id && candidate.id !== item.targetId) }) };
  }
  return { doc };
}

export function rejectItem(doc: MemoryDoc, id: string): MemoryDoc {
  const item = doc.items.find((candidate) => candidate.id === id);
  if (!item || item.state !== "unreviewed") return doc;
  return bump({ ...doc, items: doc.items.filter((candidate) => candidate.id !== id) });
}

export function editItem(doc: MemoryDoc, id: string, text: string, now: number): MemoryDoc {
  const clean = normalizeFact(text);
  if (!clean || mentionsSecret(clean)) return doc;
  const item = doc.items.find((candidate) => candidate.id === id && candidate.action === "add");
  if (!item || normalizeFact(item.text) === clean) return doc;
  return replaceItem(doc, { ...item, text: clean, state: "edited", updatedAt: now });
}

export function deleteItem(doc: MemoryDoc, id: string): MemoryDoc {
  if (!doc.items.some((item) => item.id === id)) return doc;
  return bump({ ...doc, items: doc.items.filter((item) => item.id !== id) });
}

export function searchMemory(items: readonly MemoryItem[], query: string): MemoryItem[] {
  const trimmed = query.trim();
  if (!trimmed) return [...items];
  const match = ftsMatch(trimmed, { minLength: 2 });
  const needle = normalizeFact(trimmed).toLowerCase();
  if (!match) return items.filter((item) => normalizeFact(item.text).toLowerCase().includes(needle));
  const terms = match.split(" OR ").map((term) => term.slice(1, -1));
  return items.filter((item) => {
    const hay = `${normalizeFact(item.text)} ${item.skill?.name ?? ""}`.toLowerCase();
    return terms.some((term) => hay.includes(term));
  });
}

export type ImportProposal = { id: string; project: string; markdown: string };

/** Cited lines become confirmed facts. A line with a secret, or without a source, is dropped. */
export function acceptImport(doc: MemoryDoc, proposal: ImportProposal, now: number): MemoryDoc {
  if (!IMPORT_ID.test(proposal.id) || doc.imports[proposal.id]) return doc;
  if (mentionsSecret(proposal.project)) return doc;
  const project = PROJECT.test(proposal.project) ? proposal.project : "history";
  const mateId = `${project}-lead`;
  const items = [...doc.items];
  for (const line of proposal.markdown.replace(/\r\n/g, "\n").split("\n")) {
    const text = normalizeFact(line);
    if (!text || !CITE.test(text) || mentionsSecret(text)) continue;
    const id = memoryId([mateId, "add", text.toLowerCase()]);
    if (items.some((item) => item.id === id)) continue;
    items.push({
      id,
      mateId,
      action: "add",
      text,
      state: "confirmed",
      source: { kind: "import", ref: proposal.id, label: project },
      evidence: text,
      support: 1,
      against: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
  const added = items.length !== doc.items.length;
  return bump({ ...doc, items, imports: { ...doc.imports, [proposal.id]: added ? "confirmed" : "rejected" } });
}

export function rejectImport(doc: MemoryDoc, id: string): MemoryDoc {
  if (!IMPORT_ID.test(id) || doc.imports[id]) return doc;
  return bump({ ...doc, imports: { ...doc.imports, [id]: "rejected" } });
}

export class MemoryDeferred extends Error {
  constructor() {
    super("Memory could not be saved this time.");
    this.name = "MemoryDeferred";
  }
}

function sameDoc(a: MemoryDoc, b: MemoryDoc): boolean {
  return a.generation === b.generation && a.items === b.items && a.doneTurns === b.doneTurns && a.imports === b.imports;
}

/** Writes only on top of the revision just read. A mismatch loads again and reapplies. A throw is not final. */
export async function commitDoc(
  load: () => Promise<MemoryDoc>,
  save: (revision: number, doc: MemoryDoc) => Promise<boolean>,
  change: (doc: MemoryDoc) => MemoryDoc,
): Promise<MemoryDoc> {
  let latest = parseDoc(await load());
  for (let attempt = 0; attempt < 5; attempt++) {
    const doc = attempt === 0 ? latest : parseDoc(await load());
    latest = doc;
    const next = change(doc);
    if (sameDoc(next, doc)) return doc;
    try {
      const saved = await save(doc.revision, { ...next, revision: doc.revision });
      if (saved) return { ...next, revision: doc.revision + 1 };
    } catch {
      // The folder was busy or away. Try again on the next read.
    }
  }
  throw new MemoryDeferred();
}
