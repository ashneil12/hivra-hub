import { useMemo, useState, type ReactNode } from "react";
import { Check } from "../../../shared/ui/icons";
import { TEMPLATES } from "../../hub/model/templates";
import { defaultChoices, planImport, type Choices, type ImportSummary, type PendingImport, type Plan, type SessionPreview } from "../model/importPlan";

const PRIMARY = "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-50";
const QUIET = "rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content";
const NOTE = "text-xs text-content/60";

export function Tick({ on, partial, onClick, disabled, label }: { on: boolean; partial?: boolean; onClick?: () => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={partial ? "mixed" : on} aria-label={label} disabled={disabled} onClick={onClick}
      className={`grid size-4 shrink-0 place-items-center rounded-full ${on || partial ? "bg-content text-background-base" : "bg-content/10"} ${disabled ? "opacity-60" : ""}`}>
      {on ? <Check className="size-3" strokeWidth={2.5} /> : partial ? <span className="h-0.5 w-2 rounded bg-background-base" /> : null}
    </button>
  );
}

function Section({ title, tick, children, testId }: { title: ReactNode; tick?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-0.5" data-portable-section={testId}>
      <h2 className="flex items-center gap-2 pb-1 text-xs text-content/60">{tick}{title}</h2>
      {children}
    </section>
  );
}

function Row({ tick, title, sub, right, testId }: { tick?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; testId?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md px-2 py-1.5 text-[13px] hover:bg-content/5" data-portable-row={testId}>
      {tick ? <span className="pt-0.5">{tick}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-content">{title}</span>
        {sub ? <span className="block text-[12px] leading-4 text-content/60">{sub}</span> : null}
      </span>
      {right ? <span className="shrink-0 text-xs text-content/60">{right}</span> : null}
    </div>
  );
}

function toggle(set: Set<string>, id: string, on?: boolean): Set<string> {
  const next = new Set(set);
  if (on ?? !next.has(id)) next.add(id);
  else next.delete(id);
  return next;
}

function count(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Setting keys by name, without the app's own prefix: `monocode.themeScheme` → themeScheme. */
function settingNames(keys: string[]): string {
  return keys.map((k) => k.replace(/^monocode[:.]/, "")).join(", ");
}

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/**
 * What an export brings, before anything changes: new things ticked, things already here left alone, every clash
 * named. Restore only adds; Ash's own things are replaced only where he ticks it here.
 */
export function ImportPreview({ pending, onBack, onRestore, inline }: {
  pending: PendingImport;
  onBack: () => void;
  onRestore: (plan: Plan, choices: Choices) => Promise<ImportSummary>;
  inline?: boolean;
}) {
  const plan = useMemo(() => planImport(pending), [pending]);
  const [choices, setChoices] = useState<Choices>(() => defaultChoices(plan));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ImportSummary | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const set = (change: (c: Choices) => Choices) => setChoices((c) => change(c));
  const manifest = pending.inspection?.manifest;
  const leftOut = pending.inspection?.leftOut ?? [];
  const when = manifest?.createdAt ? new Date(manifest.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : null;

  if (done) {
    return (
      <div className={`mx-auto flex max-w-[680px] flex-col gap-4 ${inline ? "" : "px-8 py-8"}`} data-portable-restored>
        <p className="text-[13px] text-content">Restored from {pending.name}.</p>
        <ul className="flex flex-col gap-1 text-[13px] text-content/75">{done.lines.map((l) => <li key={l}>{l}</li>)}</ul>
        {done.problems.length ? <ul className="flex flex-col gap-1 text-[13px] text-content/60">{done.problems.map((l) => <li key={l}>{l}</li>)}</ul> : null}
        <div><button type="button" onClick={onBack} className={QUIET}>Done</button></div>
      </div>
    );
  }

  const ws = plan.workspace;
  const sessionGroups = new Map<string, SessionPreview[]>();
  for (const s of ws?.sessions ?? []) if (s.status === "new") sessionGroups.set(s.cwd, [...(sessionGroups.get(s.cwd) ?? []), s]);
  const conflicts = (ws?.sessions ?? []).filter((s) => s.status === "differs");
  const same = (ws?.sessions ?? []).filter((s) => s.status === "same").length;
  const memoryOn = choices.memory.on;
  const workspaceOn = choices.workspace.on;
  const hasMemory = plan.memory.length > 0 || plan.monoMemory > 0;
  const hasWorkspace = !!ws || plan.teams.some((t) => t.newConversations > 0);

  const restore = async () => {
    setBusy(true);
    setFailed(null);
    try {
      setDone(await onRestore(plan, choices));
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Every project folder the file wants to register. Only one this Mac has and Rust doesn't refuse can be ticked.
  const folderRows = plan.projects.filter((x) => x.state === "new" && x.project.folder);
  const folderTickable = (x: (typeof folderRows)[number]) => x.folderHere === true && !x.folderRefused;
  const tickable = folderRows.filter((x) => folderTickable(x) && choices.projects.has(x.project.id));
  const allTicked = tickable.length > 0 && tickable.every((x) => choices.projectFolders.has(x.project.id));

  return (
    <div className={`mx-auto flex max-w-[720px] flex-col gap-6 ${inline ? "" : "px-8 py-8"}`} data-portable-preview>
      <div className="flex flex-col gap-1">
        <p className="text-[13px] leading-5 text-content/75">
          Here's what {pending.name} brings. Nothing changes until you press Restore, and nothing of yours is replaced unless you tick it.
        </p>
        <p className={NOTE}>
          {pending.fromV1 ? "An older setup file: it carries the setup only." : [when ? `Made ${when}` : null, manifest?.secretsRemoved ? `${count(manifest.secretsRemoved, "secret")} scrubbed when it was made` : null].filter(Boolean).join(" · ")}
        </p>
      </div>

      {plan.projects.length ? (
        <Section title="Projects" testId="projects">
          {plan.projects.map((x) => (
            <Row key={x.project.id} testId={`project-${x.project.id}`}
              tick={x.state === "new" ? <Tick on={choices.projects.has(x.project.id)} onClick={() => set((c) => ({ ...c, projects: toggle(c.projects, x.project.id) }))} label={x.project.name} /> : <Tick on disabled label={x.project.name} />}
              title={x.project.name}
              sub={[
                TEMPLATES.find((t) => t.id === x.project.template)?.label,
                x.state === "new" && x.project.folder ? (x.folderHere ? `adopts ${x.project.folder}` : `${x.project.folder} isn't on this Mac: added without a code folder`) : null,
                x.nameClash ? `A project called ${x.nameClash} is already here` : null,
              ].filter(Boolean).join(" · ")}
              right={x.state === "here" ? "Already here" : "New"} />
          ))}
        </Section>
      ) : null}

      {folderRows.length ? (
        <Section title="Project folders" testId="project-folders">
          <p className={NOTE}>
            These folders come from the file. A folder you tick becomes that project's code folder, and its chats keep their folder. Nothing is ticked for you: a project you leave unticked still comes in, without a folder, and its chats ask you to choose one.
          </p>
          {folderRows.some((x) => folderTickable(x)) ? (
            <div className="px-2 pb-1">
              <button
                type="button"
                data-project-folders-all=""
                className="rounded-md border border-stroke px-2 py-0.5 text-xs text-content hover:bg-content/5"
                onClick={() =>
                  set((c) => ({ ...c, projectFolders: allTicked ? new Set() : new Set(folderRows.filter((x) => folderTickable(x) && c.projects.has(x.project.id)).map((x) => x.project.id)) }))
                }
              >
                {allTicked ? "Untick all" : "Tick all"}
              </button>
            </div>
          ) : null}
          {folderRows.map((x) => (
            <Row key={x.project.id} testId={`project-folder-${x.project.id}`}
              tick={<Tick on={choices.projectFolders.has(x.project.id)} disabled={!folderTickable(x) || !choices.projects.has(x.project.id)} onClick={() => set((c) => ({ ...c, projectFolders: toggle(c.projectFolders, x.project.id) }))} label={`${x.project.name} folder`} />}
              title={x.project.folder}
              sub={`${x.project.name}: ${x.folderHere !== true ? "isn't on this Mac, so it comes in without a folder" : x.folderRefused ? `can't be adopted, because ${x.folderRefused}` : choices.projectFolders.has(x.project.id) ? "will be this project's folder" : "left out: the project comes in without a folder"}`} />
          ))}
        </Section>
      ) : null}

      {plan.monos.length ? (
        <Section title={`Monos (${plan.monos.filter((m) => choices.monos.has(m.mono.id)).length} of ${plan.monos.length})`} testId="monos">
          {plan.monos.map((m) => (
            <div key={m.mono.id} className="flex flex-col">
              <Row testId={`mono-${m.mono.id}`}
                tick={m.state === "waiting" ? <Tick on disabled label={m.mono.name} /> : <Tick on={choices.monos.has(m.mono.id)} onClick={() => set((c) => ({ ...c, monos: toggle(c.monos, m.mono.id) }))} label={m.mono.name} />}
                title={<>{m.mono.name}{m.mono.role ? <span className="ml-1.5 text-content/60">{m.mono.role}</span> : null}</>}
                sub={[
                  m.engineLabel,
                  m.mono.skills.length ? count(m.mono.skills.length, "skill") : null,
                  m.mono.files["MEMORY.md"]?.trim() ? "memory" : null,
                  m.skillsMissing.length ? `not on this Mac: ${m.skillsMissing.join(", ")}` : null,
                  // WP-182: an offered skill that is not installed here is kept, and said so.
                  m.offeredMissing.length ? `not installed here: ${m.offeredMissing.join(", ")}` : null,
                  m.missingFolders.length ? `folder not here: ${m.missingFolders.map(folderName).join(", ")}` : null,
                  m.nameClash ? `another Mono here is called ${m.nameClash}` : null,
                ].filter(Boolean).join(" · ")}
                right={m.state === "here" ? "Already here" : m.state === "waiting" ? "Already waiting" : "Waits for your OK"} />
              {m.state === "here" && choices.monos.has(m.mono.id) ? (
                <div className="flex items-center gap-2 py-0.5 pl-9 text-[12px] text-content/60" data-portable-replace={m.mono.id}>
                  <Tick on={choices.replaceSouls.has(m.mono.id)} onClick={() => set((c) => ({ ...c, replaceSouls: toggle(c.replaceSouls, m.mono.id) }))} label={`Use the file's soul for ${m.mono.name}`} />
                  Use the file's soul and habits instead of its own (otherwise it only gains what it lacks)
                </div>
              ) : null}
              {m.state === "here" && choices.monos.has(m.mono.id) && m.folders.length ? (
                <div className="flex items-center gap-2 py-0.5 pl-9 text-[12px] text-content/60" data-portable-mono-projects={m.mono.id}>
                  <Tick on={choices.monoProjects.has(m.mono.id)} onClick={() => set((c) => ({ ...c, monoProjects: toggle(c.monoProjects, m.mono.id) }))} label={`Add the projects the file lists for ${m.mono.name}`} />
                  Also add its projects ({m.folders.map(folderName).join(", ")}). Unticked, it keeps its own list.
                </div>
              ) : null}
            </div>
          ))}
          <p className="px-2 pt-1 text-[12px] text-content/60">No Mono is added from a file. Each new one waits for your OK in the Monos list.</p>
        </Section>
      ) : null}

      {plan.teams.length ? (
        <Section title="Teams" testId="teams">
          {plan.teams.map((t) => (
            <Row key={t.team.id} testId={`team-${t.team.id}`}
              tick={<Tick on={choices.teams.has(t.team.id)} onClick={() => set((c) => ({ ...c, teams: toggle(c.teams, t.team.id) }))} label={t.team.name} />}
              title={t.team.name}
              sub={[pending.doc.projects.find((p) => p.id === t.team.projectId)?.name ?? t.team.projectId, count(t.team.memberIds.length, "member"), t.newConversations ? `${count(t.newConversations, "conversation")} with the workspace` : null].filter(Boolean).join(" · ")}
              right={t.state === "here" ? "Already here" : "New"} />
          ))}
        </Section>
      ) : null}

      {plan.connectors.length ? (
        <Section title="Connectors" testId="connectors">
          {plan.connectors.map((x) => (
            <Row key={x.connector.id} testId={`connector-${x.connector.id}`}
              tick={x.state === "new" ? <Tick on={choices.connectors.has(x.connector.id)} onClick={() => set((c) => ({ ...c, connectors: toggle(c.connectors, x.connector.id) }))} label={x.connector.name} /> : <Tick on disabled label={x.connector.name} />}
              title={x.connector.name} sub={x.connector.loginLivesIn ? `Login lived in: ${x.connector.loginLivesIn}` : undefined}
              right={x.state === "here" ? "Already here" : "Sign in again after restore"} />
          ))}
          <p className="px-2 pt-1 text-[12px] text-content/60">Passwords, keys and logins never travel in an export.</p>
        </Section>
      ) : null}

      {plan.pages.length ? (
        <Section title="Pages" testId="pages">
          {plan.pages.map((x) => (
            <Row key={x.page.id} testId={`page-${x.page.id}`}
              tick={x.state === "new" ? <Tick on={choices.pages.has(x.page.id)} onClick={() => set((c) => ({ ...c, pages: toggle(c.pages, x.page.id) }))} label={x.page.title} /> : <Tick on disabled label={x.page.title} />}
              title={x.page.title}
              sub={[pending.doc.projects.find((p) => p.id === x.page.projectId)?.name ?? (x.page.projectId === "today" ? "Today" : x.page.projectId), x.asksAgain ? "asks again before it can do anything" : null].filter(Boolean).join(" · ")}
              right={x.state === "here" ? "Already here" : "New"} />
          ))}
        </Section>
      ) : null}

      {plan.customModels.length ? (
        <Section title="Your models" testId="models">
          {plan.customModels.map((x) => (
            <Row key={x.model.id}
              tick={x.state === "new" ? <Tick on={choices.customModels.has(x.model.id)} onClick={() => set((c) => ({ ...c, customModels: toggle(c.customModels, x.model.id) }))} label={x.model.name} /> : <Tick on disabled label={x.model.name} />}
              title={x.model.name} sub={[x.model.modelId, x.nameClash ? `another model here is called ${x.nameClash}` : null].filter(Boolean).join(" · ")}
              right={x.state === "here" ? "Already here" : "Enter its key again"} />
          ))}
        </Section>
      ) : null}

      {plan.settings.add.length || plan.settings.differ.length ? (
        <Section title="Settings and themes" testId="settings">
          {([
            ["missing", `Add the ${count(plan.settings.add.length, "setting")} you don't have`],
            ...(plan.settings.differ.length ? [["all", `Also use the file's for the ${count(plan.settings.differ.length, "setting")} set differently here`] as const] : []),
            ["none", "Leave my settings alone"],
          ] as const).map(([value, label]) => (
            <Row key={value} testId={`settings-${value}`} tick={<Tick on={choices.settings === value} onClick={() => set((c) => ({ ...c, settings: value }))} label={label} />} title={label} />
          ))}
          {/* By name, so Ash sees exactly what a file would write before he says yes. */}
          {plan.settings.add.length ? <p className="px-2 text-[12px] text-content/60" data-portable-settings-add>Not here yet: {settingNames(plan.settings.add)}</p> : null}
          {plan.settings.differ.length ? <p className="px-2 text-[12px] text-content/60" data-portable-settings-differ>Set differently here: {settingNames(plan.settings.differ)}</p> : null}
        </Section>
      ) : null}

      {hasMemory ? (
        <Section testId="memory"
          tick={<Tick on={memoryOn} onClick={() => set((c) => ({ ...c, memory: { ...c.memory, on: !c.memory.on } }))} label="Memory" />}
          title={`Memory${pending.inspection?.memoryTarget ? ` · goes to ${pending.inspection.memoryTarget}` : ""}`}>
          {memoryOn ? (
            <>
              {plan.memory.map((m) => {
                const n = (s: string) => m.files.filter((f) => f.status === s).length;
                return (
                  <Row key={m.name} testId={`memory-${m.name}`}
                    tick={<Tick on={choices.memory.projects.has(m.name)} onClick={() => set((c) => ({ ...c, memory: { ...c.memory, projects: toggle(c.memory.projects, m.name) } }))} label={m.name} />}
                    title={m.name === "ash" || m.name === "global" ? `${m.name} (every project reads it)` : m.name}
                    sub={[`${n("new")} new`, n("same") ? `${n("same")} already here` : null, n("differs") ? `${n("differs")} differ from yours` : null, m.history ? (m.targetExists ? "history only for a folder that isn't here" : "with its history") : null].filter(Boolean).join(" · ")}
                    right={m.targetExists ? "Folder here" : "New folder"} />
                );
              })}
              <Row tick={<Tick on={choices.memory.keepBoth} onClick={() => set((c) => ({ ...c, memory: { ...c.memory, keepBoth: !c.memory.keepBoth } }))} label="Keep both" />}
                title="When a file differs, add the file's beside yours" sub="As <name>.imported.md. Otherwise yours is kept and the file's is skipped." />
              {plan.memory.some((m) => m.history) ? (
                <Row tick={<Tick on={choices.memory.history} onClick={() => set((c) => ({ ...c, memory: { ...c.memory, history: !c.memory.history } }))} label="History" />} title="Bring back each folder's history" />
              ) : null}
              {plan.monoMemory ? (
                <Row tick={<Tick on={choices.memory.monoMemory} onClick={() => set((c) => ({ ...c, memory: { ...c.memory, monoMemory: !c.memory.monoMemory } }))} label="Monos' memory" />}
                  title={`Each Mono's own memory (${plan.monoMemory})`} />
              ) : null}
            </>
          ) : <p className="px-2 text-[12px] text-content/60">Left out: no memory is written.</p>}
        </Section>
      ) : null}

      {hasWorkspace ? (
        <Section testId="workspace"
          tick={<Tick on={workspaceOn} onClick={() => set((c) => ({ ...c, workspace: { ...c.workspace, on: !c.workspace.on } }))} label="Workspace" />}
          title="Workspace">
          {workspaceOn ? (
            <>
              {[...sessionGroups.entries()].map(([cwd, list]) => {
                const ids = list.map((s) => s.id);
                const on = ids.filter((id) => choices.workspace.sessions.has(id)).length;
                const key = `cwd:${cwd}`;
                return (
                  <div key={cwd} className="flex flex-col">
                    <Row testId={`chats-${folderName(cwd)}`}
                      tick={<Tick on={on === ids.length} partial={on > 0 && on < ids.length} onClick={() => set((c) => ({ ...c, workspace: { ...c.workspace, sessions: ids.reduce((s, id) => toggle(s, id, on !== ids.length), c.workspace.sessions) } }))} label={folderName(cwd)} />}
                      title={<>{folderName(cwd)} · {count(list.length, "chat")} <button type="button" onClick={() => setOpen((o) => toggle(o, key))} className="ml-1 text-xs text-content/60 hover:text-content">{open.has(key) ? "Hide" : "Show"}</button></>}
                      right={on < ids.length ? `${on} of ${ids.length}` : "New"} />
                    {open.has(key) ? list.slice(0, 200).map((s) => (
                      <div key={s.id} className="flex items-center gap-3 py-1 pl-9 pr-2 text-[13px]">
                        <Tick on={choices.workspace.sessions.has(s.id)} onClick={() => set((c) => ({ ...c, workspace: { ...c.workspace, sessions: toggle(c.workspace.sessions, s.id) } }))} label={s.title} />
                        <span className="min-w-0 flex-1 truncate text-content">{s.title}</span>
                        <span className="shrink-0 text-xs text-content/60">{s.harness}{s.archived ? " · archived" : ""}</span>
                      </div>
                    )) : null}
                  </div>
                );
              })}
              {same ? <Row title={`${count(same, "chat")} already here, the same`} right="Skipped" /> : null}
              {conflicts.map((s) => (
                <Row key={s.id} testId={`chat-conflict-${s.id}`}
                  tick={<Tick on={choices.workspace.sessionCopies.has(s.id)} onClick={() => set((c) => ({ ...c, workspace: { ...c.workspace, sessionCopies: toggle(c.workspace.sessionCopies, s.id) } }))} label={`Add ${s.title} as a copy`} />}
                  title={s.title} sub="Here already, and different. Yours is kept; tick to add the file's as a copy beside it." right="Keeps yours" />
              ))}
              {ws?.notes.length ? (
                <Row testId="notes" tick={<Tick on={ws.notes.some((n) => choices.workspace.notes.has(n.id))} onClick={() => set((c) => ({ ...c, workspace: { ...c.workspace, notes: ws.notes.some((n) => c.workspace.notes.has(n.id)) ? new Set() : new Set(ws.notes.filter((n) => n.status === "new").map((n) => n.id)) } }))} label="Notes" />}
                  title={`Notes and artifacts · ${ws.notes.filter((n) => n.status === "new").length} new`}
                  sub={ws.notes.some((n) => n.status === "differs") ? `${ws.notes.filter((n) => n.status === "differs").length} here already and different: yours are kept` : undefined} />
              ) : null}
              {ws?.automations.length ? (
                <Row testId="automations" tick={<Tick on={ws.automations.some((a) => choices.workspace.automations.has(a.id))} onClick={() => set((c) => ({ ...c, workspace: { ...c.workspace, automations: ws.automations.some((a) => c.workspace.automations.has(a.id)) ? new Set() : new Set(ws.automations.filter((a) => a.status === "new").map((a) => a.id)) } }))} label="Automations" />}
                  title={`Automations · ${ws.automations.filter((a) => a.status === "new").length} new`} sub="They come back paused: turn each on when you're ready." />
              ) : null}
              {ws?.reminders ? (
                <Row tick={<Tick on={choices.workspace.reminders} onClick={() => set((c) => ({ ...c, workspace: { ...c.workspace, reminders: !c.workspace.reminders } }))} label="Reminders" />}
                  title={`Reminders · ${ws.reminders}`} sub="One whose time has passed comes back done." />
              ) : null}
              {ws?.delegations.length ? (
                <Row tick={<Tick on={choices.workspace.delegations} onClick={() => set((c) => ({ ...c, workspace: { ...c.workspace, delegations: !c.workspace.delegations } }))} label="Delegation history" />}
                  title={`Delegation history · ${ws.delegations.length}`} sub="As history only: nothing restarts." />
              ) : null}
              {plan.teams.some((t) => t.newConversations > 0) ? (
                <Row tick={<Tick on={choices.workspace.groupChats} onClick={() => set((c) => ({ ...c, workspace: { ...c.workspace, groupChats: !c.workspace.groupChats } }))} label="Group conversations" />}
                  title={`Group conversations · ${plan.teams.reduce((n, t) => n + t.newConversations, 0)}`} />
              ) : null}
            </>
          ) : <p className="px-2 text-[12px] text-content/60">Left out: no chats, notes or automations are added.</p>}
        </Section>
      ) : null}

      {leftOut.length ? (
        <Section title={`${count(leftOut.length, "file was", "files were")} too big and will be left out`} testId="left-out">
          <ul className="flex flex-col gap-0.5 px-2 text-[12px] text-content/60">
            {leftOut.map((f) => <li key={f.path}><span className="text-content">{f.path}</span> {f.reason}</li>)}
          </ul>
        </Section>
      ) : null}

      {failed ? <p className="text-[13px] text-content" data-portable-error>{failed}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onBack} className={QUIET} disabled={busy}>Back</button>
        <button type="button" data-portable-restore onClick={() => void restore()} className={PRIMARY} disabled={busy}>{busy ? "Restoring…" : "Restore"}</button>
      </div>
    </div>
  );
}
