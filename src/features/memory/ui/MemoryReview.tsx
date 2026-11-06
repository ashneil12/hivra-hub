// WP-51: the memory screen. It takes ports so a browser test can drive it without Tauri.

import { useEffect, useRef, useState } from "react";
import { engineName, mentionsSecret, type MemoryDoc, type MemoryItem } from "../model/doc";
import { markLived } from "../model/fade";
import {
  acceptImport,
  acceptItem,
  acceptSkill,
  commitDoc,
  deleteItem,
  editItem,
  rejectImport,
  rejectItem,
  searchMemory,
  stampImport,
} from "../model/review";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";

export type ImportRow = { id: string; project: string; markdown: string; status: string };

export type MemoryPorts = {
  load: () => Promise<MemoryDoc>;
  save: (revision: number, doc: MemoryDoc) => Promise<boolean>;
  proposals: () => Promise<ImportRow[]>;
  reviewImport: (id: string, decision: "confirmed" | "rejected") => Promise<boolean>;
  writeSkill: (name: string, lesson: string) => Promise<void>;
  undoSkill: (name: string, lesson: string) => Promise<void>;
};

function stateLabel(state: MemoryItem["state"]): string {
  if (state === "unreviewed") return "Unreviewed";
  if (state === "confirmed") return "Confirmed";
  return "Edited";
}

export function MemoryReview({ ports }: { ports: MemoryPorts }) {
  const [doc, setDoc] = useState<MemoryDoc | null>(null);
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
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

  async function decideImport(row: ImportRow, update: (doc: MemoryDoc) => MemoryDoc) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNote("");
    try {
      const result = await stampImport(portsRef.current.load, portsRef.current.save, portsRef.current.reviewImport, update, row.id);
      setDoc(result.doc);
      setFailed(false);
      if (!result.stamped) return;
      const decision = result.doc.imports[row.id];
      if (decision !== "confirmed" && decision !== "rejected") return;
      setImports((current) => current.map((item) => (item.id === row.id ? { ...item, status: decision } : item)));
    } catch {
      setNote("Memory could not be saved this time. It can be tried again.");
      void refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const items = doc ? searchMemory(doc.items, query) : [];
  const proposals = (doc ? imports : []).filter(
    (row) => row.status === "unreviewed" && !doc?.imports[row.id] && !mentionsSecret(row.markdown) && !mentionsSecret(row.project),
  );

  return (
    <section className="flex flex-col gap-4" aria-label="Memory">
      <label className="flex flex-col gap-1 text-sm">
        Search memory
        <input
          aria-label="Search memory"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="rounded-md border border-content/15 bg-transparent px-2 py-1"
        />
      </label>
      {failed && !doc ? (
        <div className="flex flex-col gap-2">
          <p>Memory could not be read this time.</p>
          <button type="button" className={BTN} onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      ) : null}
      {note ? <p>{note}</p> : null}
      {doc && items.length === 0 && proposals.length === 0 ? <p>No matches.</p> : null}
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.id} data-id={item.id} data-kind={item.action} data-skill={item.skill?.name} className="flex flex-col gap-1">
            <p>{item.text}</p>
            <p data-state>{item.action === "skill" && item.state === "confirmed" ? "Kept as a skill" : stateLabel(item.state)}</p>
            <p data-source>{item.source.label}</p>
            {item.by ? <p data-by>{`Written by ${engineName(item.by)}`}</p> : null}
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
                <button type="button" className={BTN} disabled={busy} onClick={() => void change((current) => deleteItem(current, item.id))}>
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
                  onClick={() => void decideImport(row, (current) => acceptImport(current, row, Date.now()))}
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
    </section>
  );
}
