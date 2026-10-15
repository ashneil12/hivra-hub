import { useMemo, useState } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { ArrowLeft, Check } from "../../../shared/ui/icons";
import { setHubSelection } from "../model/hubNav";
import { isSeated } from "../model/setupSouls";
import { applySetup, clearPendingSetup, pendingSetup, type SetupBot, type SetupFile } from "../model/setupFile";
import { TEMPLATES } from "../model/templates";

const PRIMARY = "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90";
const QUIET = "rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content";

/**
 * Restore preview: what a setup file brings, before anything is added.
 * As a hub page it reads the pending file; Settings passes one in.
 */
export function RestorePreview({ file: given, name: givenName, onBack, onDone, inline }: {
  file?: SetupFile; name?: string; onBack?: () => void; onDone?: () => void; inline?: boolean;
}) {
  const p = given ? { file: given, name: givenName ?? "setup file" } : pendingSetup();
  const back = onBack ?? (() => { clearPendingSetup(); setHubSelection({ project: "today", item: "inbox" }); });
  const body = !p ? (
    <div className="grid h-full place-items-center text-[13px] text-content/60">No setup file picked.</div>
  ) : (
    <Body file={p.file} name={p.name} onBack={back} onDone={onDone ?? (() => { clearPendingSetup(); setHubSelection({ project: "today", item: "inbox" }); })} />
  );
  if (inline) return body;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-hub-restore>
      <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region="deep">
        <button type="button" aria-label="Back" title="Back" onClick={back}
          className="grid size-6 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content">
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        </button>
        <span className="text-[13px] text-content">Restore setup</span>
        {IS_MAC ? null : <div className="ml-auto w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
}

function Body({ file, name, onBack, onDone }: { file: SetupFile; name: string; onBack: () => void; onDone: () => void }) {
  const bots = file.bots ?? [];
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(bots.map((b) => b.id)));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const projectName = (id: string) => file.projects.find((p) => p.id === id)?.name ?? id;
  const groups = useMemo(() => {
    const m = new Map<string, SetupBot[]>();
    for (const b of bots) {
      const k = `${b.projectId}|${b.team}`;
      m.set(k, [...(m.get(k) ?? []), b]);
    }
    return [...m.entries()];
  }, [bots]);
  const setMany = (ids: string[], on: boolean) => {
    const next = new Set(ticked);
    for (const id of ids) (on ? next.add(id) : next.delete(id));
    setTicked(next);
  };

  return (
    <div className="mx-auto flex max-w-[680px] flex-col gap-6 px-8 py-8" data-hub-restore-body>
      <p className="text-[13px] leading-5 text-content/75">
        Here's what {name} brings. Nothing is added until you press Restore.
      </p>

      <section className="flex flex-col gap-0.5">
        <h2 className="pb-1 text-xs text-content/60">Projects</h2>
        {file.projects.map((p) => (
          <div key={p.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-[13px]">
            <span className="min-w-0 flex-1 text-content">{p.name}</span>
            <span className="text-xs text-content/60">{TEMPLATES.find((t) => t.id === p.template)?.label}</span>
          </div>
        ))}
      </section>

      {bots.length ? <section className="flex flex-col gap-0.5">
        <h2 className="pb-1 text-xs text-content/60">Bots ({ticked.size} of {bots.length})</h2>
        {groups.map(([key, list]) => {
          const [pid, team] = key.split("|");
          const ids = list.map((b) => b.id);
          const on = ids.filter((id) => ticked.has(id)).length;
          const expanded = open.has(key);
          return (
            <div key={key} className="flex flex-col" data-hub-restore-group={key}>
              <div className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-content/5">
                <Tick on={on === ids.length} partial={on > 0 && on < ids.length} onClick={() => setMany(ids, on !== ids.length)} />
                <button type="button" data-hub-restore-expand={key} onClick={() => {
                  const n = new Set(open); (expanded ? n.delete(key) : n.add(key)); setOpen(n);
                }} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] text-content">
                  {projectName(pid)} · {team === "leadership" ? "Leadership team" : "Coding team"} · {list.length} bot{list.length === 1 ? "" : "s"}
                  <span className="text-xs text-content/60">{expanded ? "Hide" : "Show"}</span>
                </button>
                {on < ids.length ? <span className="text-xs text-content/60">{on} of {ids.length}</span> : null}
              </div>
              {expanded
                ? list.map((b) => (
                    <div key={b.id} className="flex items-center gap-3 rounded-lg py-1.5 pl-9 pr-2 hover:bg-content/5" data-hub-restore-bot={b.id}>
                      <Tick on={ticked.has(b.id)} onClick={() => setMany([b.id], !ticked.has(b.id))} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] text-content">{b.name}</span>
                        <span className="block text-[13px] text-content/60">{b.role}</span>
                      </span>
                      <span className="shrink-0 text-xs text-content/60">{b.skills} skill{b.skills === 1 ? "" : "s"}</span>
                    </div>
                  ))
                : null}
            </div>
          );
        })}
      </section> : null}

      {file.souls?.length ? (
        <section className="flex flex-col gap-0.5" data-restore-souls>
          <h2 className="pb-1 text-xs text-content/60">Souls</h2>
          {file.souls.map((x) => (
            <div key={x.monoId} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-[13px]">
              <span className="min-w-0 flex-1 truncate text-content">
                {x.name}
                <span className="ml-1.5 text-xs text-content/60">
                  {[x.role, x.memory ? "memory" : "", x.workflows ? "workflows" : "", x.skills.length ? `${x.skills.length} ${x.skills.length === 1 ? "skill" : "skills"}` : ""].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="shrink-0 text-xs text-content/60">{isSeated(x.monoId) ? "Already seated, keeps its own soul" : "Waiting for your OK"}</span>
            </div>
          ))}
          <p className="px-2 pt-1 text-[13px] text-content/60">No Mono is seated from a file. Each one waits for your OK in the Monos list.</p>
        </section>
      ) : null}

      {file.pages?.length ? (
        <section className="flex flex-col gap-0.5" data-restore-pages>
          <h2 className="pb-1 text-xs text-content/60">Pages</h2>
          {file.pages.map((pg) => (
            <div key={pg.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-[13px]">
              <span className="min-w-0 flex-1 truncate text-content">{pg.title}</span>
              <span className="text-xs text-content/60">
                {file.projects.find((x) => x.id === pg.projectId)?.name ?? (pg.projectId === "today" ? "Today" : pg.projectId)}
                {pg.spec.kind === "bespoke" && pg.spec.permissions.length ? " · asks again before it can do anything" : ""}
              </span>
            </div>
          ))}
        </section>
      ) : null}

      {file.connectors?.length ? (
        <section className="flex flex-col gap-0.5">
          <h2 className="pb-1 text-xs text-content/60">Connectors</h2>
          {file.connectors.map((c) => (
            <div key={c.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-[13px]">
              <span className="min-w-0 flex-1 text-content">{c.name}</span>
              <span className="text-xs text-content/60">Sign in after restore</span>
            </div>
          ))}
          <p className="px-2 pt-1 text-[13px] text-content/60">Passwords and keys never travel in the file.</p>
        </section>
      ) : null}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onBack} className={QUIET}>Back</button>
        <button type="button" data-hub-restore-apply onClick={() => { applySetup(file, ticked); onDone(); }} className={PRIMARY}>Restore</button>
      </div>
    </div>
  );
}

function Tick({ on, partial, onClick }: { on: boolean; partial?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={partial ? "mixed" : on} onClick={onClick}
      className={`grid size-4 shrink-0 place-items-center rounded-full ${on || partial ? "bg-content text-background-base" : "bg-content/10"}`}>
      {on ? <Check className="size-3" strokeWidth={2.5} /> : partial ? <span className="h-0.5 w-2 rounded bg-background-base" /> : null}
    </button>
  );
}
