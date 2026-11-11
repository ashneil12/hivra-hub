// WP-51: accept, reject, edit, delete, search. A skill file and a draft stamp are written
// only after this window's compare-and-swap lands, and a later failure puts that write back.

import { ftsMatch } from "../vendor/mercuryBelief";
import { contradicts } from "./contradicts";
import { givesOrders } from "./orderScan";
import { bump, memoryId, mentionsSecret, normalizeFact, parseDoc, withForgotten, type MemoryDoc, type MemoryDispute, type MemoryItem } from "./doc";
import { touch } from "./fade";
import { letGoCopy, withArchived } from "./letGo";

/** WP-111: why a fact is parked. Shown as written. */
export const DISPUTE_REASON = "A newer message says something different";

export type DisputeChoice = "keep-old" | "use-new" | "keep-both";

const CITE = /\[src:\s+[A-Za-z0-9._:-]+\s+#[A-Za-z0-9._:-]+\]/;
const IMPORT_ID = /^[a-z0-9-]{1,80}$/;
const PROJECT = /^[a-z0-9-]{1,64}$/;

export type AcceptResult = { doc: MemoryDoc; skill?: { name: string; lesson: string } };

function replaceItem(doc: MemoryDoc, next: MemoryItem): MemoryDoc {
  return bump({ ...doc, items: doc.items.map((item) => (item.id === next.id ? next : item)) });
}

export function acceptItem(doc: MemoryDoc, id: string, now: number): AcceptResult {
  const item = doc.items.find((candidate) => candidate.id === id);
  if (!item || item.state !== "unreviewed" || item.dispute) return { doc };
  if (item.action === "skill" && item.skill) {
    return { doc: replaceItem(doc, touch({ ...item, state: "confirmed", updatedAt: now }, now)), skill: { ...item.skill } };
  }
  // WP-100: the person accepting it is a use, so it starts its clock from today.
  if (item.action === "add") return { doc: replaceItem(doc, touch({ ...item, state: "confirmed", updatedAt: now }, now)) };
  if (item.action === "update" && item.targetId) {
    const target = doc.items.find((candidate) => candidate.id === item.targetId && candidate.action === "add");
    const rest = doc.items.filter((candidate) => candidate.id !== item.id);
    if (!target) return { doc: bump({ ...doc, items: rest }) };
    // WP-240: the wording it had goes onto the "Let go" list, replaced by the row that now holds the new wording.
    const was = letGoCopy(target, "superseded", now, target.id, true);
    return {
      doc: bump(
        withArchived(
          {
            ...doc,
            items: rest.map((candidate) =>
              candidate.id === target.id
                ? touch({ ...candidate, text: item.text, state: "edited" as const, updatedAt: now, support: candidate.support + 1 }, now)
                : candidate,
            ),
          },
          [was],
        ),
      ),
    };
  }
  if (item.action === "remove" && item.targetId) {
    // WP-240: the fact the person agreed was stale is let go, not lost.
    const target = doc.items.find((candidate) => candidate.id === item.targetId);
    const kept = { ...doc, items: doc.items.filter((candidate) => candidate.id !== item.id && candidate.id !== item.targetId) };
    return { doc: bump(target ? withArchived(kept, [letGoCopy(target, "stale", now)]) : kept) };
  }
  return { doc };
}

export function rejectItem(doc: MemoryDoc, id: string): MemoryDoc {
  const item = doc.items.find((candidate) => candidate.id === id);
  if (!item || item.state !== "unreviewed" || item.dispute) return doc;
  return bump({ ...doc, items: doc.items.filter((candidate) => candidate.id !== id) });
}

export function editItem(doc: MemoryDoc, id: string, text: string, now: number): MemoryDoc {
  const clean = normalizeFact(text);
  if (!clean || mentionsSecret(clean)) return doc;
  const item = doc.items.find((candidate) => candidate.id === id && candidate.action === "add");
  if (!item || item.dispute || normalizeFact(item.text) === clean) return doc;
  // WP-100: the person rewrote it, so it is theirs now and does not fade (fade.ownerStated).
  return replaceItem(doc, { ...item, text: clean, state: "edited", updatedAt: now, fade: 1, lastUsedAt: now });
}

export function deleteItem(doc: MemoryDoc, id: string): MemoryDoc {
  const item = doc.items.find((candidate) => candidate.id === id);
  if (!item || item.dispute) return doc;
  const kept = { ...doc, items: doc.items.filter((candidate) => candidate.id !== id) };
  // A deleted fact or lesson leaves a digest, so a passing mention later does not bring it back. A removal proposal
  // is only a suggestion about another fact, so deleting it forgets nothing.
  const text = item.action === "skill" ? (item.skill?.lesson ?? item.text) : item.text;
  return bump(item.action === "remove" ? kept : withForgotten(kept, item.mateId, text));
}

function withoutDispute(item: MemoryItem): MemoryItem {
  const next = { ...item };
  delete next.dispute;
  return next;
}

function restoreParked(item: MemoryItem): MemoryItem {
  const was = item.dispute?.was;
  if (was !== "confirmed" && was !== "edited") return withoutDispute(item);
  return withoutDispute({ ...item, state: was });
}

/**
 * WP-111: parks every confirmed fact this new one contradicts, and links the new one back.
 * Nothing is overwritten. No clash leaves the doc and the item as they were.
 */
export function withContradiction(doc: MemoryDoc, item: MemoryItem): { doc: MemoryDoc; item: MemoryItem } {
  const clashes = doc.items.filter(
    (have) =>
      have.mateId === item.mateId &&
      have.action === "add" &&
      (have.state === "confirmed" || have.state === "edited") &&
      !have.dispute &&
      have.id !== item.id &&
      contradicts(have.text, item.text),
  );
  if (clashes.length === 0) return { doc, item };
  const reason = DISPUTE_REASON;
  const ids = new Set(clashes.map((clash) => clash.id));
  return {
    doc: {
      ...doc,
      items: doc.items.map((have) => {
        if (!ids.has(have.id)) return have;
        if (have.state !== "confirmed" && have.state !== "edited") return have;
        const dispute: MemoryDispute = { otherId: item.id, reason, was: have.state };
        // Keep the review state: a confirmed or edited fact stays in recall until the person settles the pair.
        return { ...have, dispute };
      }),
    },
    item: { ...item, dispute: { otherId: clashes[0].id, reason } },
  };
}

/** The parked older facts for this search. A match on either side keeps the pair on screen. */
export function parkedDisputes(items: readonly MemoryItem[], query: string): MemoryItem[] {
  const parked = items.filter((item) => item.dispute?.was);
  if (!query.trim()) return parked;
  const matched = new Set(searchMemory([...items], query).map((item) => item.id));
  return parked.filter((item) => {
    if (matched.has(item.id)) return true;
    const otherId = item.dispute?.otherId;
    return otherId ? matched.has(otherId) : false;
  });
}

/**
 * WP-111: the person's choice for a parked pair. Only the older fact (the one that remembers its
 * previous state) can be resolved. The three choices are the only way a clash is settled.
 */
export function resolveDispute(doc: MemoryDoc, parkedId: string, choice: DisputeChoice, now: number): MemoryDoc {
  if (choice !== "keep-old" && choice !== "use-new" && choice !== "keep-both") return doc;
  const item = doc.items.find((candidate) => candidate.id === parkedId);
  if (!item?.dispute?.was) return doc;
  const other = doc.items.find((candidate) => candidate.id === item.dispute?.otherId);
  if (choice === "use-new") {
    if (!other) return doc;
    const replaced = touch(withoutDispute({ ...item, text: other.text, state: "edited", updatedAt: now }), now);
    // WP-240: the old wording is let go as contradicted, by the row that now says the new one.
    const was = letGoCopy(item, "contradicted", now, item.id, true);
    return bump({
      ...withArchived(doc, [was]),
      items: doc.items
        .filter((candidate) => candidate.id !== other.id)
        .map((candidate) => {
          if (candidate.id === item.id) return replaced;
          if (candidate.dispute?.otherId === other.id) {
            return { ...candidate, dispute: { ...candidate.dispute, otherId: item.id } };
          }
          return candidate;
        }),
    });
  }
  if (choice === "keep-both") {
    const restored = restoreParked(item);
    return bump({
      ...doc,
      items: doc.items.map((candidate) => {
        if (candidate.id === item.id) return restored;
        if (other && candidate.id === other.id) {
          return touch(withoutDispute({ ...candidate, state: "confirmed", updatedAt: now }), now);
        }
        return candidate;
      }),
    });
  }
  const removedId = other?.id;
  return bump({
    ...doc,
    items: doc.items
      .filter((candidate) => candidate.id !== removedId)
      .map((candidate) => {
        if (candidate.id === item.id) return restoreParked(candidate);
        if (removedId && candidate.dispute?.otherId === removedId && candidate.dispute.was) return restoreParked(candidate);
        return candidate;
      }),
  });
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
    if (!text || !CITE.test(text) || mentionsSecret(text) || givesOrders(text)) continue;
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
  return (
    a.generation === b.generation &&
    a.items === b.items &&
    a.doneTurns === b.doneTurns &&
    a.imports === b.imports &&
    a.livedDays === b.livedDays
  );
}

export type CommitResult = { doc: MemoryDoc; applied: boolean };

/** Writes only on top of the revision just read. A mismatch loads again and reapplies. A throw is not final. */
export async function commitDoc(
  load: () => Promise<MemoryDoc>,
  save: (revision: number, doc: MemoryDoc) => Promise<boolean>,
  change: (doc: MemoryDoc) => MemoryDoc,
): Promise<CommitResult> {
  let latest = parseDoc(await load());
  for (let attempt = 0; attempt < 5; attempt++) {
    const doc = attempt === 0 ? latest : parseDoc(await load());
    latest = doc;
    const next = change(doc);
    if (sameDoc(next, doc)) return { doc, applied: false };
    try {
      const saved = await save(doc.revision, { ...next, revision: doc.revision });
      if (saved) return { doc: { ...next, revision: doc.revision + 1 }, applied: true };
    } catch {
      // The folder was busy or away. Try again on the next read.
    }
  }
  throw new MemoryDeferred();
}

function reopenSkill(doc: MemoryDoc, id: string, name: string, lesson: string): MemoryDoc {
  const item = doc.items.find((candidate) => candidate.id === id);
  if (!item || item.action !== "skill" || item.state !== "confirmed" || !item.skill) return doc;
  if (item.skill.name !== name || item.skill.lesson !== lesson) return doc;
  return replaceItem(doc, { ...item, state: "unreviewed" });
}

/** Confirms the skill, then writes its file. A lost accept writes nothing. A failed write puts the row back. */
export async function acceptSkill(
  load: () => Promise<MemoryDoc>,
  save: (revision: number, doc: MemoryDoc) => Promise<boolean>,
  writeSkill: (name: string, lesson: string) => Promise<void>,
  undoSkill: (name: string, lesson: string) => Promise<void>,
  id: string,
  now: number,
): Promise<CommitResult> {
  const accepted = await commitDoc(load, save, (doc) => acceptItem(doc, id, now).doc);
  if (!accepted.applied) return accepted;
  const item = accepted.doc.items.find((candidate) => candidate.id === id);
  if (!item || item.action !== "skill" || item.state !== "confirmed" || !item.skill) return accepted;
  const { name, lesson } = item.skill;
  try {
    await writeSkill(name, lesson);
  } catch {
    const rolled = await commitDoc(load, save, (doc) => reopenSkill(doc, id, name, lesson));
    const stillConfirmed = rolled.doc.items.some(
      (candidate) => candidate.id === id && candidate.action === "skill" && candidate.state === "confirmed" && candidate.skill?.name === name,
    );
    if (!stillConfirmed) {
      try {
        await undoSkill(name, lesson);
      } catch {
        // The row is unreviewed again. A later accept writes the lesson if it is missing.
      }
    }
    throw new MemoryDeferred();
  }
  return accepted;
}

function dropImport(doc: MemoryDoc, id: string): MemoryDoc {
  if (!doc.imports[id]) return doc;
  const items = doc.items.filter((item) => item.source.kind !== "import" || item.source.ref !== id);
  const imports = { ...doc.imports };
  delete imports[id];
  return bump({ ...doc, items, imports });
}

/**
 * Stores this window's import decision, then stamps the draft with that same decision.
 * A lost save does not stamp. A stamp that does not land removes the facts again.
 */
export async function stampImport(
  load: () => Promise<MemoryDoc>,
  save: (revision: number, doc: MemoryDoc) => Promise<boolean>,
  review: (id: string, decision: "confirmed" | "rejected") => Promise<boolean>,
  update: (doc: MemoryDoc) => MemoryDoc,
  id: string,
): Promise<CommitResult & { stamped: boolean }> {
  const saved = await commitDoc(load, save, update);
  if (!saved.applied) return { ...saved, stamped: false };
  const decision = saved.doc.imports[id];
  if (decision !== "confirmed" && decision !== "rejected") return { ...saved, stamped: false };
  let landed = false;
  try {
    landed = await review(id, decision);
  } catch {
    // A timeout is not a decision. The facts are put back so this can be tried again.
    landed = false;
  }
  if (landed) return { ...saved, stamped: true };
  const rolled = await commitDoc(load, save, (doc) => dropImport(doc, id));
  if (rolled.doc.imports[id]) throw new MemoryDeferred();
  throw new MemoryDeferred();
}
