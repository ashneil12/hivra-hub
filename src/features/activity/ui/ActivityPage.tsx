import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  filterEntries,
  kindLabel,
  newestFirst,
  readPage,
  sameWho,
  whenLabel,
  whoLabel,
  type ActivityCursor,
  type ActivityEntry,
} from "../model/activity";

type Props = {
  /** A seeded list. When given, the page does not ask the app. */
  entries?: ActivityEntry[];
  onOpenSession?: (sessionId: string) => void;
};

/**
 * Settings → Activity (WP-78). Newest first. A live page is the server's page:
 * this screen does not filter it again, or a later page of matches would vanish.
 */
export function ActivityPage({ entries, onOpenSession }: Props) {
  const seeded = entries !== undefined;
  const [project, setProject] = useState("");
  const [agent, setAgent] = useState("");
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");
  const [live, setLive] = useState<ActivityEntry[]>([]);
  const [next, setNext] = useState<ActivityCursor | null>(null);
  const generation = useRef(0);

  function queryOf(before?: ActivityCursor) {
    return {
      project: project.trim() || undefined,
      agent: agent.trim() || undefined,
      kind: kind.trim() || undefined,
      search: search.trim() || undefined,
      before,
    };
  }

  useEffect(() => {
    if (seeded) return;
    const mine = ++generation.current;
    setNext(null);
    let cancelled = false;
    void invoke("activity_list", { query: queryOf() })
      .then((page) => {
        if (cancelled || mine !== generation.current) return;
        const read = readPage(page);
        setLive(read.entries);
        setNext(read.next);
      })
      .catch(() => {
        // A timeout is not an empty log. Leave the rows already on screen.
        if (cancelled || mine !== generation.current) return;
      });
    return () => {
      cancelled = true;
    };
  }, [seeded, project, agent, kind, search]);

  async function showOlder() {
    const cursor = next;
    if (!cursor) return;
    const mine = generation.current;
    try {
      const page = await invoke("activity_list", { query: queryOf(cursor) });
      if (mine !== generation.current) return;
      const read = readPage(page);
      setLive((rows) => {
        const seen = new Set(rows.map((row) => row.id));
        return [...rows, ...read.entries.filter((row) => !seen.has(row.id))];
      });
      setNext(read.next);
    } catch {
      // A timeout is not an empty log. Leave the rows already on screen.
      if (mine !== generation.current) return;
    }
  }

  const shown = seeded ? filterEntries(entries, { project, agent, kind, search }).slice().sort(newestFirst) : live;
  const filtering = [project, agent, kind, search].some((value) => value.trim() !== "");

  return (
    <div className="flex flex-col gap-4" data-activity>
      <div className="flex flex-wrap gap-2">
        <Field label="Project" value={project} onChange={(value) => { setProject(value); setNext(null); }} />
        <Field label="Agent" value={agent} onChange={(value) => { setAgent(value); setNext(null); }} />
        <Field label="Kind" value={kind} onChange={(value) => { setKind(value); setNext(null); }} />
        <Field label="Search" value={search} onChange={(value) => { setSearch(value); setNext(null); }} />
      </div>
      {shown.length === 0 ? (
        <p className="px-3 text-[13px] text-content/60">
          {filtering ? "Nothing matches." : "Nothing has been recorded yet."}
        </p>
      ) : (
        <ul aria-label="Activity" className="flex flex-col gap-0.5">
          {shown.map((entry) => (
            <Row key={entry.id} entry={entry} onOpenSession={onOpenSession} />
          ))}
        </ul>
      )}
      {!seeded && next ? (
        <button type="button" className="self-start px-3 text-[13px] text-content/80" onClick={() => void showOlder()}>
          Show older
        </button>
      ) : null}
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex min-w-32 flex-1 flex-col gap-1 text-xs text-content/60">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md bg-content/5 px-2 py-1 text-[13px] text-content"
      />
    </label>
  );
}

function Row({ entry, onOpenSession }: { entry: ActivityEntry; onOpenSession?: (sessionId: string) => void }) {
  const asked = sameWho(entry.actor, entry.initiator) ? "" : `asked by ${whoLabel(entry.initiator)}`;
  const meta = [whoLabel(entry.actor), asked, entry.project, kindLabel(entry.kind), whenLabel(entry.at)]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="rounded-lg px-3 py-2.5 hover:bg-content/5" data-activity-row={entry.id}>
      <Line entry={entry} onOpenSession={onOpenSession} />
      <div className="text-xs text-content/60">{meta}</div>
    </li>
  );
}

function Line({ entry, onOpenSession }: { entry: ActivityEntry; onOpenSession?: (sessionId: string) => void }) {
  const session = entry.link.startsWith("session:") ? entry.link.slice("session:".length).trim() : "";
  if (session) {
    return (
      <button
        type="button"
        className="block text-left text-[13px] leading-5 text-content"
        onClick={() => onOpenSession?.(session)}
      >
        {entry.summary}
      </button>
    );
  }
  if (entry.link.startsWith("https://")) {
    return (
      <a href={entry.link} rel="noreferrer" className="block text-[13px] leading-5 text-content underline">
        {entry.summary}
      </a>
    );
  }
  return (
    <div className="text-[13px] leading-5 text-content">
      {entry.summary}
      {entry.link ? <span className="text-content/60"> {entry.link}</span> : null}
    </div>
  );
}
