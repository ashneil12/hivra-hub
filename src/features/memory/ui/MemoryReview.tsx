// WP-51: the memory screen. It takes ports so a browser test can drive it without Tauri.

import { useEffect, useRef, useState } from "react";
import { engineName, mentionsSecret, type MemoryDoc, type MemoryItem } from "../model/doc";
import { lastRecallFor, latestRecall, recallSummary } from "../model/lastRecall";
import { markLived } from "../model/fade";
import { askAnswer, askedNow, dueForAsk, nextAsk } from "../model/ask";
import { deleteMemory } from "../model/deletion";
import { healthOf } from "../model/health";
import { importOrderRefusal } from "../model/orderScan";
import { pausedNow } from "../model/memoryBudget";
import { bringBack, forgetLetGo, LET_GO_LABEL, letGoItem, memoryStatus } from "../model/letGo";
import { isEssential, markEssential } from "../model/essential";
import { MemoryAsk } from "./MemoryAsk";
import { MemoryHealthCard } from "./MemoryHealthCard";
import { MemoryProvenance } from "./MemoryProvenance";
import {
  acceptImport,
  acceptItem,
  acceptSkill,
  commitDoc,
  editItem,
  parkedDisputes,
  rejectImport,
  rejectItem,
  resolveDispute,
  searchMemory,
  stampImport,
  type DisputeChoice,
} from "../model/review";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";

export type ImportRow = { id: string; project: string; markdown: string; status: string };

export type MemoryPorts = {
  /** Which Mono's memory this screen is showing, when it knows. The last recall is read for it. */
  mateId?: string;
  load: () => Promise<MemoryDoc>;
  save: (revision: number, doc: MemoryDoc) => Promise<boolean>;
  proposals: () => Promise<ImportRow[]>;
  reviewImport: (id: string, decision: "confirmed" | "rejected") => Promise<boolean>;
  writeSkill: (name: string, lesson: string) => Promise<void>;
  undoSkill: (name: string, lesson: string) => Promise<void>;
};

const PILL = "h-7 rounded-full px-3 text-[12px] font-medium";
const PILL_ON = "bg-content text-background-base";
const PILL_OFF = "text-content/60 hover:bg-content/8 hover:text-content";

type Tab = "kept" | "let-go";

export function MemoryReview({ ports }: { ports: MemoryPorts }) {
  const [doc, setDoc] = useState<MemoryDoc | null>(null);
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [showing, setShowing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // WP-240: what is kept, or what was let go.
  const [tab, setTab] = useState<Tab>("kept");
  const busyRef = useRef(false);
  const portsRef = useRef(ports);
  portsRef.current = ports;

  async function refresh() {
    try {
      const [next, rows] = await Promise.all([portsRef.current.load(), portsRef.current.proposals()]);
      setDoc(next);
      setImports(rows);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function change(update: (doc: MemoryDoc) => MemoryDoc): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setNote("");
    try {
      // WP-100: a day the person works on memory is a day the app lived.
      const result = await commitDoc(portsRef.current.load, portsRef.current.save, (doc) =>
        markLived(update(doc), Date.now()),
      );
      setDoc(result.doc);
      setFailed(false);
      return result.applied;
    } catch {
      setNote("Memory could not be saved this time. It can be tried again.");
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // WP-100: a delete takes the fact out of its skill file too, and says plainly what still holds it.
  async function remove(item: MemoryItem) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNote("");
    try {
      const result = await deleteMemory(portsRef.current.load, portsRef.current.save, portsRef.current.undoSkill, item.id);
      setDoc(result.doc);
      setFailed(false);
      if (result.note) setNote(result.note);
    } catch {
      setNote("Memory could not be saved this time. It can be tried again.");
      void refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function decideImport(row: ImportRow, update: (doc: MemoryDoc) => MemoryDoc): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setNote("");
    try {
      const result = await stampImport(portsRef.current.load, portsRef.current.save, portsRef.current.reviewImport, update, row.id);
      setDoc(result.doc);
      setFailed(false);
      if (!result.stamped) return false;
      const decision = result.doc.imports[row.id];
      if (decision !== "confirmed" && decision !== "rejected") return false;
      setImports((current) => current.map((item) => (item.id === row.id ? { ...item, status: decision } : item)));
      return true;
    } catch {
      setNote("Memory could not be saved this time. It can be tried again.");
      void refresh();
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // One reading of the clock for the card and the questions, so a page shown across midnight is not half in each day.
  const now = Date.now();
  const items = doc ? searchMemory(doc.items, query) : [];
  // WP-111: a parked pair is its own card. The newer fact is not also listed on its own.
  const disputes = doc ? parkedDisputes(doc.items, query) : [];
  const plain = items.filter((item) => !item.dispute);
  // WP-100: one faded fact, asked about once. The question picked is held here until it is answered, and counted as
  // shown straight away, so the same question does not appear on every visit.
  const askingItem = doc && showing ? doc.items.find((item) => item.id === showing) : undefined;
  const asking = doc && askingItem && dueForAsk(doc, askingItem, now) ? askingItem : undefined;
  useEffect(() => {
    if (!doc) return;
    if (showing && !asking) {
      setShowing(null);
      return;
    }
    if (showing) return;
    const next = nextAsk(doc, Date.now());
    if (!next) return;
    setShowing(next.id);
    void change((current) => askedNow(current, next.id, Date.now()));
    // `now` is a new reading every render and must not stand in for `doc`; the question is picked when the doc (or
    // the question on screen) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, showing]);
  const answerNow = (answer: Parameters<typeof askAnswer>[2]) => {
    if (!asking) return;
    const id = asking.id;
    setShowing(null);
    void change((current) => askAnswer(current, id, answer, Date.now()));
  };
  // WP-99: the last turn's recall, in plain words, folded away unless asked for.
  const lastRecall = doc ? (ports.mateId ? lastRecallFor(ports.mateId) : latestRecall()) : undefined;
  const proposals = (doc ? imports : []).filter(
    (row) => row.status === "unreviewed" && !doc?.imports[row.id] && !mentionsSecret(row.markdown) && !mentionsSecret(row.project),
  );

  return (
    <section className="flex flex-col gap-4" aria-label="Memory">
      {lastRecall ? (
        <details data-recall-why>
          <summary className="cursor-pointer text-sm">Why these were recalled</summary>
          <p className="mt-2 text-sm">{recallSummary(lastRecall)}</p>
        </details>
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        Search memory
        <input
          aria-label="Search memory"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="rounded-md border border-content/15 bg-transparent px-2 py-1"
        />
      </label>
      {doc ? <MemoryHealthCard health={healthOf(doc, now)} now={now} paused={pausedNow(now)} /> : null}
      {failed && !doc ? (
        <div className="flex flex-col gap-2">
          <p>Memory could not be read this time.</p>
          <button type="button" className={BTN} onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      ) : null}
      {note ? <p>{note}</p> : null}
      {doc ? (
        <div role="tablist" aria-label="Which memory" className="flex flex-wrap gap-1.5" data-memory-tabs>
          {(["kept", "let-go"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              data-memory-tab={id}
              onClick={() => setTab(id)}
              className={`${PILL} ${tab === id ? PILL_ON : PILL_OFF}`}
            >
              {id === "kept" ? "Kept" : `Let go${doc.archived?.length ? ` (${doc.archived.length})` : ""}`}
            </button>
          ))}
        </div>
      ) : null}
      {tab === "let-go" && doc ? (
        <LetGoList
          doc={doc}
          query={query}
          busy={busy}
          onBringBack={(id) => void change((current) => bringBack(current, id, Date.now()))}
          onDelete={(id) => void change((current) => forgetLetGo(current, id))}
        />
      ) : (
        <>
      {doc && plain.length === 0 && disputes.length === 0 && proposals.length === 0 ? <p>No matches.</p> : null}
      {asking ? <MemoryAsk item={asking} busy={busy} onAnswer={answerNow} /> : null}
      <ul className="flex flex-col gap-3">
        {disputes.map((item) => {
          const other = doc?.items.find((row) => row.id === item.dispute?.otherId);
          const choose = (choice: DisputeChoice) => {
            void change((current) => resolveDispute(current, item.id, choice, Date.now()));
          };
          return (
            <li key={item.id} data-dispute={item.id} className="flex flex-col gap-2">
              <p>Needs review</p>
              <p>{item.dispute?.reason}</p>
              <div className="flex gap-4">
                <p data-old>{item.text}</p>
                <p data-new>{other?.text}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={BTN} disabled={busy} onClick={() => choose("keep-old")}>
                  Keep the old one
                </button>
                <button type="button" className={BTN} disabled={busy || !other} onClick={() => choose("use-new")}>
                  Use the new one
                </button>
                <button type="button" className={BTN} disabled={busy} onClick={() => choose("keep-both")}>
                  Keep both
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <ul className="flex flex-col gap-3">
        {plain.map((item) => (
          <li key={item.id} data-id={item.id} data-kind={item.action} data-skill={item.skill?.name} className="flex flex-col gap-1">
            <p>{item.text}</p>
            <p data-state>{item.action === "skill" && item.state === "confirmed" ? "Kept as a skill" : memoryStatus(item)}</p>
            <p data-source>{item.source.label}</p>
            {item.by ? <p data-by>{`Written by ${engineName(item.by)}`}</p> : null}
            {isEssential(item) ? <p data-essential>Sent in every chat</p> : null}
            <MemoryProvenance item={item} now={now} />
            {editing?.id === item.id ? (
              <div className="flex flex-col gap-1">
                <textarea aria-label="Memory text" value={editing.text} onChange={(event) => setEditing({ id: item.id, text: event.target.value })} />
                <button
                  type="button"
                  className={BTN}
                  disabled={busy}
                  onClick={() => {
                    const text = editing.text;
                    setEditing(null);
                    void change((current) => editItem(current, item.id, text, Date.now()));
                  }}
                >
                  Save
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {item.state === "unreviewed" && item.action === "skill" && item.skill ? (
                  <button
                    type="button"
                    className={BTN}
                    disabled={busy}
                    onClick={() => {
                      if (busyRef.current) return;
                      busyRef.current = true;
                      setBusy(true);
                      setNote("");
                      void (async () => {
                        try {
                          const result = await acceptSkill(
                            portsRef.current.load,
                            portsRef.current.save,
                            portsRef.current.writeSkill,
                            portsRef.current.undoSkill,
                            item.id,
                            Date.now(),
                          );
                          setDoc(result.doc);
                          setFailed(false);
                          if (!result.applied) setNote("That skill was not saved. It can be accepted again.");
                        } catch {
                          setNote("That skill was not saved. It can be accepted again.");
                          void refresh();
                        } finally {
                          busyRef.current = false;
                          setBusy(false);
                        }
                      })();
                    }}
                  >
                    {`Accept skill ${item.skill.name}`}
                  </button>
                ) : null}
                {item.state === "unreviewed" && item.action !== "skill" ? (
                  <button type="button" className={BTN} disabled={busy} onClick={() => void change((current) => acceptItem(current, item.id, Date.now()).doc)}>
                    {`Accept ${item.text}`}
                  </button>
                ) : null}
                {item.state === "unreviewed" ? (
                  <button
                    type="button"
                    className={BTN}
                    disabled={busy}
                    onClick={() => void change((current) => rejectItem(current, item.id))}
                  >
                    {item.action === "skill" && item.skill ? `Reject skill ${item.skill.name}` : `Reject ${item.text}`}
                  </button>
                ) : null}
                {item.action === "add" ? (
                  <button type="button" className={BTN} disabled={busy} onClick={() => setEditing({ id: item.id, text: item.text })}>
                    {`Edit ${item.text}`}
                  </button>
                ) : null}
                {item.action === "add" && item.state !== "unreviewed" ? (
                  <button
                    type="button"
                    className={BTN}
                    disabled={busy}
                    data-essential-button
                    aria-pressed={isEssential(item)}
                    onClick={() => void change((current) => markEssential(current, item.id, !isEssential(item)))}
                  >
                    {isEssential(item) ? `Stop sending in every chat: ${item.text}` : `Send in every chat: ${item.text}`}
                  </button>
                ) : null}
                {item.action === "add" ? (
                  <button
                    type="button"
                    className={BTN}
                    disabled={busy}
                    data-let-go-button
                    onClick={() => void change((current) => letGoItem(current, item.id, "manual", Date.now()))}
                  >
                    {`Let go ${item.text}`}
                  </button>
                ) : null}
                <button type="button" className={BTN} disabled={busy} onClick={() => void remove(item)}>
                  {`Delete ${item.text}`}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <ul className="flex flex-col gap-3">
        {proposals.map((row) => {
          const line = row.markdown.replace(/\r\n/g, "\n").split("\n").find((entry) => entry.trim()) ?? row.project;
          return (
            <li key={row.id} data-import={row.id} className="flex flex-col gap-1">
              <p>{line}</p>
              <p data-state>Unreviewed</p>
              <p data-source>{row.project}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={BTN}
                  disabled={busy}
                  onClick={() => {
                    const reason = importOrderRefusal(row.markdown);
                    void (async () => {
                      const ok = await decideImport(row, (current) => acceptImport(current, row, Date.now()));
                      if (ok && reason) setNote(reason);
                    })();
                  }}
                >
                  {`Accept import from ${row.project}`}
                </button>
                <button
                  type="button"
                  className={BTN}
                  disabled={busy}
                  onClick={() => void decideImport(row, (current) => rejectImport(current, row.id))}
                >
                  {`Reject import from ${row.project}`}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
        </>
      )}
    </section>
  );
}

/** WP-240: the "Let go" tab. Each item says why it went, and can be brought back or deleted for good. */
function LetGoList({
  doc,
  query,
  busy,
  onBringBack,
  onDelete,
}: {
  doc: MemoryDoc;
  query: string;
  busy: boolean;
  onBringBack: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const all = doc.archived ?? [];
  const items = searchMemory(all, query).slice().reverse();
  if (!all.length) return <p className="text-content/60">Nothing has been let go.</p>;
  if (!items.length) return <p>No matches.</p>;
  const textOf = (id: string | undefined) => (id ? doc.items.find((item) => item.id === id)?.text : undefined);
  return (
    <ul className="flex flex-col gap-3" data-let-go-list>
      {items.map((item) => {
        const reason = item.letGo?.reason ?? "manual";
        const by = textOf(item.letGo?.by);
        return (
          <li key={item.id} data-let-go={item.id} data-reason={reason} className="flex flex-col gap-1">
            <p>{item.text}</p>
            <p data-let-go-why className="text-content/60">
              {by && by !== item.text ? `${LET_GO_LABEL[reason]}: ${by}` : LET_GO_LABEL[reason]}
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={BTN} disabled={busy} onClick={() => onBringBack(item.id)}>
                {`Bring back ${item.text}`}
              </button>
              <button type="button" className={BTN} disabled={busy} onClick={() => onDelete(item.id)}>
                {`Delete ${item.text}`}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
