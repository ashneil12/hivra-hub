import { pastChanges, undoProposal, useProposalsVersion } from "../model/proposals";
import { useEffect, useRef, useState } from "react";
import { openMonoChatWith } from "../../monos/model/monoPrefill";
import { hubData, useHubDataVersion } from "../model/hubData";
import { botChangeRows, redoBotChange, undoAllFrom, undoBotChange, undoneLine, useBotChangesVersion, type BotChangeRow } from "../model/botChanges";

const UNDO = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12";

/** Settings → Changes: project changes, plus a quiet Bot changes filter. */
export function ChangesPage() {
  const [filter, setFilter] = useState<"all" | "bots">("all");
  const tab = (id: "all" | "bots", label: string) => (
    <button type="button" data-hub-changes-filter={id} onClick={() => setFilter(id)}
      className={`rounded-md px-2.5 py-1 text-xs ${filter === id ? "bg-content/10 text-content" : "text-content/60 hover:text-content"}`}>{label}</button>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1">{tab("all", "Project changes")}{tab("bots", "Bot changes")}</div>
      {filter === "all" ? <ProjectChanges /> : <BotChanges />}
    </div>
  );
}

function BotChanges() {
  useBotChangesVersion();
  const rows = botChangeRows();
  if (!rows.length) return <p className="text-[13px] text-content/60">No bot changes yet. When a bot changes how it works, it shows up here with Undo.</p>;
  let day = "";
  return (
    <div className="flex flex-col gap-0.5" data-hub-bot-changes>
      <UndoAllFrom rows={rows} />
      {rows.map((r) => {
        const d = r.kind === "one" ? r.change.day : r.day;
        const head = d !== day ? <div className="px-3 pb-1 pt-3 text-xs text-content/60 first:pt-0">{(day = d)}</div> : null;
        return <div key={r.kind === "one" ? r.change.id : r.id}>{head}<BotChangeLine row={r} /></div>;
      })}
    </div>
  );
}

/** One "Undo all from…" button; its menu names each Mono with changes still standing. */
function UndoAllFrom({ rows }: { rows: BotChangeRow[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const standing = rows.flatMap((r) => (r.kind === "one" ? [r.change] : r.items)).filter((c) => !c.undone && !c.note);
  const bots = [...new Set(standing.map((c) => c.bot))];
  if (!bots.length) return null;
  return (
    <div ref={box} className="relative px-3 pb-2" data-undo-all-from>
      <button type="button" className={UNDO} aria-haspopup="menu" aria-expanded={open} data-undo-all-from-button onClick={() => setOpen(!open)}>
        Undo all from…
      </button>
      {open ? (
        <div role="menu" className="absolute left-3 top-full z-10 mt-1 flex min-w-44 flex-col rounded-lg border border-content/10 bg-background-base p-1 shadow-lg" data-undo-all-from-menu>
          {bots.map((b) => (
            <button key={b} type="button" role="menuitem" data-undo-all-from-item={b}
              className="rounded-md px-2.5 py-1.5 text-left text-[13px] text-content/85 hover:bg-content/8"
              onClick={() => {
                setOpen(false);
                void undoAllFrom(b);
              }}>{b}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A line ending "(and N more)" shows that part as the way into the rest (the row opens on the full list). */
function LineText({ line }: { line: string }) {
  const m = line.match(/^(.*) \(and (\d+) more\)$/s);
  if (!m) return <>{line}</>;
  return <>{m[1]} <span className="text-content/60 underline decoration-content/30 underline-offset-2" data-hub-bot-change-more>and {m[2]} more</span></>;
}

function BotChangeLine({ row }: { row: BotChangeRow }) {
  const [open, setOpen] = useState(false);
  const items = row.kind === "one" ? [row.change] : row.items;
  const line = row.kind === "one" ? row.change.line : row.line;
  const undone = items.every((c) => c.undone);
  return (
    <div className="rounded-lg px-3 py-2.5 hover:bg-content/5" data-hub-bot-change>
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} data-hub-bot-change-line
          className={`min-w-0 flex-1 break-words text-left text-[13px] leading-5 ${undone ? "text-content/60" : "text-content"}`}><LineText line={line} /></button>
        {undone ? (
          <span className="flex shrink-0 items-center gap-2 text-xs text-content/60" data-hub-bot-change-undone>
            <span>{row.kind === "one" ? undoneLine(row.change) : "Undone"}</span>
            <button type="button" data-hub-bot-change-redo onClick={() => void redoBotChange(items.map((c) => c.id))}
              className="rounded-md px-1.5 py-0.5 text-xs text-content/60 hover:bg-content/5 hover:text-content">Redo</button>
          </span>
        ) : items.every((c) => c.note) ? (
          items[0]?.ask ? (
            <button type="button" className={UNDO} data-hub-bot-change-ask={items[0].ask.monoId}
              onClick={() => openMonoChatWith(items[0]!.ask!.monoId, items[0]!.ask!.text)}>{items[0].ask.label}</button>
          ) : null
        ) : (
          <button type="button" className={UNDO} onClick={() => void undoBotChange(items.map((c) => c.id))}>Undo</button>
        )}
      </div>
      {items.find((c) => c.problem) ? <div className="mt-1 text-xs text-content/60" data-hub-bot-change-problem>{items.find((c) => c.problem)!.problem}</div> : null}
      {open ? (
        <div className="hub-fade-in mt-2 flex flex-col gap-2 text-[13px]">
          {items.map((c) => (
            <div key={c.id} className="flex flex-col gap-0.5">
              {row.kind === "bundle" ? <div className="text-content/85">{c.line}</div> : null}
              <div className="grid grid-cols-[48px_1fr] gap-x-2 text-content/85">
                <span className="text-content/60">Now</span><span>{c.now}</span>
                <span className="text-content/60">After</span><span>{c.after}</span>
              </div>
              {c.details?.length ? (
                <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-content/85" data-hub-bot-change-details>
                  {c.details.map((d) => <li key={d}>{d}</li>)}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProjectChanges() {
  useHubDataVersion();
  useProposalsVersion();
  const ids = new Set(hubData().listProjects().map((p) => p.id));
  const list = pastChanges().filter((p) => ids.has(p.projectId));
  const name = (id: string) => hubData().listProjects().find((p) => p.id === id)?.name ?? id;
  if (!list.length) return <p className="text-[13px] text-content/60">No changes yet. When you apply a proposed change, it shows up here with Undo.</p>;
  return (
    <div className="flex flex-col gap-0.5" data-hub-changes>
      {list.map((p) => (
        <div key={p.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-content/5">
          <div className="min-w-0 flex-1">
            <div className={`truncate text-[13px] ${p.status === "applied" ? "text-content" : "text-content/60"}`}>{p.title}</div>
            {p.status === "rejected" && p.blocked ? (
              <div className="text-[13px] leading-5 text-content/60" data-hub-change-rejected>
                Turned down automatically: breaks “{p.blocked.rule}”. {p.blocked.reason}
              </div>
            ) : null}
            <div className="truncate text-[13px] text-content/60">
              {name(p.projectId)} · by {p.by} · {p.appliedAt}
            </div>
          </div>
          {p.status === "rejected" ? null : p.status === "undone" ? (
            <span className="text-xs text-content/60">Undone</span>
          ) : (
            <button type="button" data-hub-change-undo={p.id} onClick={() => undoProposal(p.id)} className={UNDO}>
              Undo
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
