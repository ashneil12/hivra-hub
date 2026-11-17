// "You asked" as a board beside the one chat (Ash, 17 Nov: "a main chat in the center ... at the side something like
// sticky notes that pop up, grouped per project"). Every ask he made is one note under the project it is for
// (asks/model/askBoard.ts says how that is told): what is wanted, his own words, and where it stands. A note that waits
// on him opens that question's own card where it sits (the same NeedDetail the Inbox opens), so a dump is answered
// without leaving the chat. An ask no project claims waits under "Not sorted yet", where one tap places it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { projectKey } from "../../../shared/lib/paths";
import { Check, ChevronRight } from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import { openFromHome } from "../../home/model/opener";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import type { HubProject } from "../../hub/model/types";
import { ProjectGlyph } from "../../hub/ui/ProjectMenu";
import { CircleWord, NEEDS_YOU_RED, redRowProps } from "../../hub/ui/StatusMark";
import { useDelegationRows } from "../../monos/model/delegationStore";
import { findMono, listMonos } from "../../monos/model/mono";
import { answeredLine, useLastAnswered, type AnsweredNeed } from "../../needs/model/answeredNeeds";
import { useNeedsYou } from "../../needs/model/needsLive";
import type { NeedsItem } from "../../needs/model/needsYou";
import { AnsweredLine, NeedDetail } from "../../needs/ui/NeedDetail";
import { Reveal } from "../../needs/ui/Reveal";
import { askAnswered, askBoard, stackCount, UNSORTED, type BoardContext, type BoardNote, type BoardStack } from "../model/askBoard";
import { askStore } from "../model/askStore";
import { openBesideChief } from "../model/besideChat";
import { lensLookupFrom, lensLookupNow, setChiefLens, useChiefLens } from "../model/chiefLens";
import { quoteAsked } from "../model/quoteInChat";
import { useAsked } from "../model/useAsked";

const HINT = "px-2 py-2 text-[12px] leading-4 text-content/60";
const QUIET = "shrink-0 rounded-md px-1.5 py-0.5 text-[12px] leading-4 text-content/70 hover:bg-content/8 hover:text-content";

/** His words are short enough to be the whole note: longer, the one-line summary leads and his words sit under it. */
const WORDS_AS_TITLE = 110;

/** His words as a note's own line: no list mark in front, no full stop behind. */
function plainWords(words: string): string {
  return words
    .replace(/^[-*\d.)\s]+/, "")
    .replace(/[.,;:]+$/, "")
    .trim();
}

/** What the board reads, from the app's records: the filter's own lookup when the app lends it, else the projects alone. */
function useBoardContext(needs: readonly NeedsItem[]): BoardContext {
  const version = useHubDataVersion();
  const jobs = useDelegationRows();
  return useMemo(() => {
    const lookup =
      lensLookupNow() ??
      lensLookupFrom({ projects: hubData().listProjects(), monos: listMonos(), needs, chatFolder: () => undefined, key: projectKey });
    return {
      projects: lookup.projects,
      jobs,
      needs,
      chatProject: lookup.chatProject,
      mateProject: (mateId) => {
        const chat = findMono(mateId)?.sessionId;
        return chat ? lookup.chatProject?.(chat) : undefined;
      },
    };
    // The projects are read again when the hub's data moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, needs, version]);
}

/** Puts one ask under a project, from a menu of the projects. */
function PlaceMenu({ note, projects, label, lead = false }: { note: BoardNote; projects: readonly HubProject[]; label: string; /** The note's main action: drawn brighter. */ lead?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const place = (project: string | null) => {
    setOpen(false);
    const store = askStore();
    void store
      .place(note.id, project)
      .then(() => {
        // An ask that waited on him with no project was waiting to be placed: it goes back to open with where he put
        // it, so its first mate reads that beside his next message (asks/model/askNotes.ts) and picks it up.
        const name = projects.find((entry) => entry.id === project)?.name;
        if (name && !note.projectId && !note.needKey && note.status === "waiting")
          return store.change(note.id, { status: "heard", note: `You put it under ${name}.` }, "ash");
        return undefined;
      })
      .catch(() => undefined);
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-ask-place={note.id}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${note.title}`}
        className={`${QUIET} ${lead ? "text-content" : ""}`}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="bottom"
          align="start"
          width={220}
          constrainHeight={false}
          role="menu"
          aria-label="Which project is this for?"
          onDismiss={() => setOpen(false)}
          className="solid-panel-glass p-1 font-sans"
          data-ask-place-menu
        >
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              role="menuitemradio"
              aria-checked={note.projectId === project.id}
              data-ask-place-in={project.id}
              onClick={() => place(project.id)}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-content hover:bg-content/8"
            >
              <span aria-hidden className="grid size-4 shrink-0 place-items-center text-content/70">
                <ProjectGlyph project={project} size={13} />
              </span>
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {note.projectId === project.id ? <Check aria-hidden className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} /> : null}
            </button>
          ))}
          {note.project ? (
            <>
              <div role="separator" className="my-1 h-px bg-content/10" />
              <button
                type="button"
                role="menuitem"
                data-ask-place-in=""
                onClick={() => place(null)}
                className="flex h-8 w-full items-center rounded-md px-2 text-left text-[13px] text-content/70 hover:bg-content/8 hover:text-content"
              >
                Let the app place it
              </button>
            </>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}

type NoteProps = {
  note: BoardNote;
  need?: NeedsItem;
  /** What he just answered from this note's card, while the app still shows it. */
  answered?: AnsweredNeed;
  shown: boolean;
  onShow: () => void;
  busy: boolean;
  onChange: (note: BoardNote, status: "done" | "dropped" | "heard") => void;
  onQuote?: (text: string) => void;
  /** Opens the chat of the job that took it on. */
  onOpenJob?: () => void;
  projects: readonly HubProject[];
  /** Under "Finished": the note says which project it was for, since no stack does. */
  projectName?: string;
  placeable: boolean;
};

function Note({ note, need, answered, shown, onShow, busy, onChange, onQuote, onOpenJob, projects, projectName, placeable }: NoteProps) {
  // A note that waits on something its first mate did not put in words says what the Needs you item says.
  const stands = need && note.status !== "waiting" ? (need.detail ?? need.sentence) : note.note;
  const word = need && note.status !== "waiting" ? "Needs you" : note.word;
  const short = note.words.length <= WORDS_AS_TITLE;
  const text = (
    <>
      <span data-asked-title className={`line-clamp-3 text-[13px] leading-[18px] ${note.open ? "text-content" : "text-content/60"}`}>
        {short ? plainWords(note.words) || note.title : note.title}
      </span>
      {short ? null : (
        <span data-asked-words title={note.words} className="line-clamp-2 text-[12px] leading-[17px] text-content/60">
          “{note.words}”
        </span>
      )}
      <span className="text-[11px] leading-4 text-content/60">
        <span style={note.red && note.open ? { color: NEEDS_YOU_RED } : undefined}>{word}</span>
        {projectName ? ` · ${projectName}` : ""}
        {note.said ? ` · said ${note.said} times` : ""}
        {stands ? ` · ${stands}` : ""}
      </span>
    </>
  );
  const unplaced = placeable && note.open && !note.projectId;
  return (
    <li
      data-asked={note.open ? "open" : "handled"}
      data-asked-status={note.status}
      data-ask-note={note.id}
      data-ask-needs={need ? need.key : undefined}
      className="group relative flex flex-col rounded-lg border border-content/10 bg-content/[0.04]"
      {...redRowProps(note.red && note.open)}
    >
      <div className="relative flex items-start gap-2 px-2.5 py-2">
        <button
          type="button"
          disabled={busy}
          aria-label={`${note.open ? "Mark done" : "Reopen"}: ${note.title}`}
          className="mt-0.5 shrink-0 rounded focus-visible:outline focus-visible:outline-2"
          onClick={() => onChange(note, note.open ? "done" : "heard")}
        >
          {note.open ? (
            <CircleWord circle={note.red ? "red" : "grey"} word={word} ringOnly />
          ) : (
            <Check aria-hidden className="size-3.5 text-content/60" strokeWidth={1.75} />
          )}
        </button>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {need ? (
            <button
              type="button"
              data-ask-answer={need.key}
              aria-expanded={shown}
              onClick={onShow}
              className="flex min-w-0 flex-col gap-0.5 rounded text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-content/40"
            >
              {text}
            </button>
          ) : (
            text
          )}
          {need || unplaced || note.status === "maybe" ? (
            <span className="-ml-1.5 flex flex-wrap gap-x-1">
              {need ? (
                <button type="button" aria-expanded={shown} onClick={onShow} className={`${QUIET} flex items-center gap-1 text-content`}>
                  {shown ? "Close" : need.answer ? "Answer here" : "See why"}
                  <ChevronRight aria-hidden className={`size-3 transition-transform ${shown ? "rotate-90" : ""}`} strokeWidth={1.75} />
                </button>
              ) : null}
              {note.status === "maybe" ? (
                <>
                  <button type="button" disabled={busy} aria-label={`It is an ask: ${note.title}`} className={`${QUIET} text-content`} onClick={() => onChange(note, "heard")}>
                    It is an ask
                  </button>
                  <button type="button" disabled={busy} aria-label={`Not an ask: ${note.title}`} className={QUIET} onClick={() => onChange(note, "dropped")}>
                    Not an ask
                  </button>
                </>
              ) : null}
              {unplaced ? <PlaceMenu note={note} projects={projects} label="Place in a project" lead={note.status !== "maybe"} /> : null}
            </span>
          ) : null}
        </span>
        {/* The rest of what a note can do, over the end of its last line while the pointer or the keyboard is on it. */}
        <div
          data-ask-tools
          className="absolute bottom-1 right-1.5 flex items-center rounded-md border border-content/10 bg-background-base leading-4 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
        >
          {onOpenJob ? (
            <button type="button" data-ask-open-job aria-label={`Open the work on: ${note.title}`} className={QUIET} onClick={onOpenJob}>
              Open
            </button>
          ) : null}
          {onQuote ? (
            <button
              type="button"
              data-quote-asked={note.id}
              aria-label={`Quote in the chat: ${note.title}`}
              className={QUIET}
              onClick={() =>
                onQuote(
                  quoteAsked({ title: note.title, status: note.word, note: note.note, said: note.said, words: note.words, id: note.id, chatId: note.chatId, blockId: note.blockId }),
                )
              }
            >
              Quote
            </button>
          ) : null}
          {placeable && note.open && note.projectId ? <PlaceMenu note={note} projects={projects} label="Move" /> : null}
          {note.open && note.status !== "maybe" ? (
            <button type="button" disabled={busy} aria-label={`Not an ask: ${note.title}`} className={QUIET} onClick={() => onChange(note, "dropped")}>
              Not an ask
            </button>
          ) : null}
        </div>
      </div>
      {need && shown ? (
        <Reveal>
          <div data-ask-card={need.key} className="border-t border-content/10 px-1 pb-1">
            <NeedDetail item={need} compact />
          </div>
        </Reveal>
      ) : answered ? (
        <AnsweredLine entry={answered} className="border-t border-content/10 px-2.5 py-2" />
      ) : null}
    </li>
  );
}

/** Everything the owner asked for, as notes stacked per project: what needs him first, then the newest. */
export function AskBoard({ onQuote }: { onQuote?: (text: string) => void } = {}) {
  const asked = useAsked();
  const needs = useNeedsYou();
  const context = useBoardContext(needs);
  const lens = useChiefLens();
  const jobs = useDelegationRows();
  const board = useMemo(() => askBoard(asked, context), [asked, context]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const projects = hubData().listProjects();
  // The Needs you item each note last waited on. An item leaves the list the moment it is answered, and its note still
  // has to say so: the ask goes back to open with his answer on it (askBoard.ts askAnswered), once per answer.
  const answered = useLastAnswered();
  const waitedOn = useRef(new Map<string, string>());
  const settled = useRef(0);
  useEffect(() => {
    for (const stack of board.stacks) for (const item of stack.notes) if (item.needKey) waitedOn.current.set(item.id, item.needKey);
  }, [board]);
  useEffect(() => {
    if (!answered || settled.current === answered.at) return;
    settled.current = answered.at;
    for (const [id, key] of waitedOn.current) {
      if (key !== answered.key) continue;
      const row = asked.find((entry) => entry.id === id);
      const next = row ? askAnswered(row, answered) : undefined;
      if (next) void askStore().change(id, next, "ash").catch(() => undefined);
    }
    // Only a new answer runs it; the asks it reads are the ones on screen when he answered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered]);
  // The line under a note for what he just answered there, unless the note's own line already says it.
  const answeredOn = (item: BoardNote) =>
    answered && item.note !== answeredLine(answered) && (item.needKey ?? waitedOn.current.get(item.id)) === answered.key ? answered : undefined;
  const change = async (note: BoardNote, status: "done" | "dropped" | "heard") => {
    setBusy(note.id);
    setProblem(null);
    try {
      const result = await askStore().change(
        note.id,
        { status, ...(status === "done" ? { proof: "Marked done by you." } : status === "heard" ? { proof: "", note: "" } : {}) },
        "ash",
      );
      if ("problem" in result) setProblem(result.problem);
    } catch {
      setProblem("Couldn't save the change. Please try again.");
    } finally {
      setBusy(null);
    }
  };
  // The chat of a note's newest job: beside the Chief of Staff's when that is on screen, else in its own place.
  const jobOpener = (item: BoardNote) => {
    const row = jobs.find((entry) => entry.id === [...(item.jobs ?? [])].pop());
    if (!row) return undefined;
    return () => {
      if (!openBesideChief(row.childSession)) openFromHome({ kind: "chat", id: row.childSession, projectId: row.project ?? "" });
    };
  };
  if (asked.length === 0) return <p className={HINT}>What you ask for shows here, so nothing gets lost in a long chat.</p>;
  const picked = lens && board.byProject ? projects.find((project) => project.id === lens) : undefined;
  const stacks = picked ? board.stacks.filter((stack) => stack.id === picked.id) : board.stacks;
  const finished = picked ? board.finished.filter((note) => note.projectId === picked.id) : board.finished;
  const nameOf = (id: string | undefined) => (id ? projects.find((project) => project.id === id)?.name : undefined);
  const note = (item: BoardNote, projectName?: string) => (
    <Note
      key={item.id}
      note={item}
      need={item.needKey ? needs.find((need) => need.key === item.needKey) : undefined}
      answered={answeredOn(item)}
      shown={shown === item.id}
      onShow={() => setShown(shown === item.id ? null : item.id)}
      busy={busy !== null}
      onChange={(target, status) => void change(target, status)}
      onQuote={onQuote}
      onOpenJob={jobOpener(item)}
      projects={projects}
      projectName={projectName}
      placeable={board.byProject}
    />
  );
  return (
    <div data-ask-board={picked ? picked.id : "all"} className="flex flex-col gap-3">
      {problem ? (
        <p role="alert" className={HINT}>
          {problem}
        </p>
      ) : null}
      {picked ? (
        <p data-ask-board-lens className="flex items-center gap-2 px-2 text-[12px] leading-5 text-content/60">
          <span className="min-w-0 flex-1">Only what you asked for {picked.name}.</span>
          <button type="button" className={QUIET} onClick={() => setChiefLens(null)}>
            Show everything
          </button>
        </p>
      ) : null}
      {stacks.length ? stacks.map((stack) => <Stack key={stack.id} stack={stack} named={board.byProject} project={projects.find((p) => p.id === stack.id)} lead={context.projects.find((p) => p.id === stack.id)?.mates?.[0]} note={note} />) : <p className={HINT}>Nothing left open.</p>}
      {finished.length ? (
        <details data-asked-finished className="border-t border-stroke">
          <summary className={`${HINT} cursor-pointer`}>Finished ({finished.length})</summary>
          <ul data-chief-asked className="flex flex-col gap-1.5 pb-1">
            {finished.map((item) => note(item, board.byProject && !picked ? nameOf(item.projectId) : undefined))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function Stack({
  stack,
  named,
  project,
  lead,
  note,
}: {
  stack: BoardStack;
  named: boolean;
  project?: HubProject;
  /** The project's first mate, by name. */
  lead?: string;
  note: (item: BoardNote) => ReactNode;
}) {
  return (
    <section aria-label={stack.name || "You asked"} data-ask-stack={stack.id} className="flex flex-col">
      {named ? (
        <h3 className="flex items-center gap-1.5 px-2 pb-1.5 text-[12px] leading-5">
          {project ? (
            <span aria-hidden className="grid size-4 shrink-0 place-items-center text-content/70">
              <ProjectGlyph project={project} size={13} />
            </span>
          ) : null}
          <span className="font-medium text-content">{stack.name}</span>
          <span className="min-w-0 truncate text-content/60">
            {lead ? `${lead} · ` : ""}
            {stackCount(stack)}
            {stack.needs ? (
              <>
                {" · "}
                <span data-ask-stack-needs={stack.needs} style={{ color: NEEDS_YOU_RED }}>
                  {stack.needs} {stack.needs === 1 ? "needs you" : "need you"}
                </span>
              </>
            ) : null}
          </span>
        </h3>
      ) : null}
      {stack.id === UNSORTED && named ? (
        <p className="px-2 pb-1.5 text-[11px] leading-4 text-content/60">The Chief of Staff puts these under a project. You can place one yourself.</p>
      ) : null}
      <ul data-chief-asked className="flex flex-col gap-1.5">
        {stack.notes.map((item) => note(item))}
      </ul>
    </section>
  );
}
