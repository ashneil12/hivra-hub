import { useEffect, useState, type ReactNode } from "react";
import { hubData, useHubDataVersion } from "../model/hubData";
import { useHubSelection } from "../model/hubNav";
import { stripProjects } from "../model/hubProjects";
import { OPEN_HUB_EVENT } from "../model/hubTeams";
import { projectAsks, projectDecisions, type DecisionAsk, type ProjectDecisions } from "../model/decisions";

const OPEN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12";

/**
 * Settings → Decisions (scorecard D2): one place per project for what is still open and what is already decided.
 * It shows the inbox's open asks and Ash OS's own memory primer, and nothing else: answering happens in the Inbox
 * (the "Open" button goes there), and the memory is a read of what Ash OS composes for a fresh session.
 * Given a projectId (each project's own Decisions, PM r57), it shows that project only, with no project picker.
 */
export function DecisionsPage({ projectId }: { projectId?: string } = {}) {
  useHubDataVersion();
  const all = stripProjects(hubData().listProjects());
  const projects = projectId ? all.filter((p) => p.id === projectId) : all;
  const selection = useHubSelection();
  const [picked, setPicked] = useState(projectId ?? selection.project);
  const project = projects.find((p) => p.id === picked) ?? projects[0];

  const [loaded, setLoaded] = useState<{ project: string; decisions?: ProjectDecisions }>();
  const id = project?.id;
  useEffect(() => {
    if (!id) return;
    let live = true;
    void projectDecisions(id).then((decisions) => {
      if (live) setLoaded({ project: id, ...(decisions ? { decisions } : {}) });
    });
    return () => {
      live = false;
    };
  }, [id]);

  if (!project) return <p className="text-[13px] text-content/60">No projects yet.</p>;
  const asks = projectAsks(project.id);
  const decisions = loaded?.project === project.id ? loaded.decisions : undefined;
  const reading = loaded?.project !== project.id;

  const goToInbox = () => {
    window.dispatchEvent(new CustomEvent(OPEN_HUB_EVENT, { detail: { project: project.id, item: "inbox" } }));
  };

  return (
    <div className="flex flex-col gap-6" data-hub-decisions>
      {projects.length > 1 ? (
        <div className="flex flex-wrap gap-1" data-hub-decisions-projects>
          {projects.map((p) => (
            <button key={p.id} type="button" data-hub-decisions-project={p.id} onClick={() => setPicked(p.id)}
              className={`rounded-md px-2.5 py-1 text-xs ${p.id === project.id ? "bg-content/10 text-content" : "text-content/60 hover:text-content"}`}>
              {p.name}
            </button>
          ))}
        </div>
      ) : null}

      <Section title="Waiting on you" note={asks.length ? `${asks.length}` : undefined}>
        {asks.length ? (
          asks.map((a) => <AskLine key={a.id} ask={a} onOpen={goToInbox} />)
        ) : (
          <Empty>Nothing is waiting on you in {project.name}.</Empty>
        )}
      </Section>

      {reading ? (
        <Empty>Reading {project.name}&apos;s memory…</Empty>
      ) : decisions === undefined ? (
        <Empty>
          Ash OS didn&apos;t answer, so past decisions can&apos;t be shown right now. They are in decisions.md and never.md in
          ~/agent-memory/{project.id}, and Ash&apos;s own in ~/agent-memory/ash.
        </Empty>
      ) : decisions.empty ? (
        <Empty>Nothing is in {project.name}&apos;s memory yet.</Empty>
      ) : (
        <>
          <Section title="Decided" note="newest first">
            {decisions.lines.filter((l) => l.kind === "decision").map((l, i) => <MemoryRow key={`d${i}`} text={l.text} when={l.when} global={l.global} />)}
            {decisions.lines.some((l) => l.kind === "decision") ? null : <Empty>No decisions are recorded for {project.name} yet.</Empty>}
          </Section>

          <Section title="Never do">
            {decisions.lines.filter((l) => l.kind === "never").map((l, i) => <MemoryRow key={`n${i}`} text={l.text} when={l.when} global={l.global} />)}
            {decisions.lines.some((l) => l.kind === "never") ? null : <Empty>No rules are recorded for {project.name}.</Empty>}
          </Section>

          {decisions.more > 0 ? (
            <p className="px-3 text-xs text-content/60" data-hub-decisions-more>
              {decisions.more} more current {decisions.more === 1 ? "line" : "lines"} didn&apos;t fit here. They are in decisions.md and
              never.md in {decisions.memoryDir ?? `~/agent-memory/${project.id}`} and {decisions.globalDir ?? "~/agent-memory/ash"}.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5">
      <h3 className="px-3 pb-1 text-xs text-content/60">
        {title}
        {note ? <span className="text-content/40"> · {note}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 text-[13px] text-content/60">{children}</p>;
}

/** One open ask. Settings lists it. Answering happens in the Inbox or the project's chat, not on this page. */
function AskLine({ ask, onOpen }: { ask: DecisionAsk; onOpen: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-content/5" data-hub-decision-ask={ask.id}>
      <div className="min-w-0 flex-1">
        <div className="break-words text-[13px] leading-5 text-content">{ask.title}</div>
        <div className="break-words text-[13px] leading-5 text-content/60">{ask.why}</div>
      </div>
      {ask.later ? <span className="shrink-0 self-center text-xs text-content/60">Later</span> : null}
      <button type="button" className={OPEN} onClick={onOpen}>
        Open
      </button>
    </div>
  );
}

/** One decided line or never-do rule: its text, then the quiet line saying whose layer it is and the day it was saved. */
function MemoryRow({ text, when, global }: { text: string; when?: string; global: boolean }) {
  const meta = [global ? "Every project" : undefined, when].filter(Boolean).join(" · ");
  return (
    <div className="rounded-lg px-3 py-2.5 hover:bg-content/5" data-hub-decision-line>
      <div className="break-words text-[13px] leading-5 text-content">{text}</div>
      {meta ? <div className="text-xs text-content/60">{meta}</div> : null}
    </div>
  );
}
