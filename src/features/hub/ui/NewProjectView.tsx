import { useEffect, useRef, useState } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { Check, Plus } from "../../../shared/ui/icons";
import { addMockProject } from "../model/mockData";
import { liveHubStore } from "../model/hubData";
import { leadSpecFor } from "../model/hubLeads";
import { openCodingTeam, projectHasCodeFolder, projectHomeSelection, setHubSelection, showProjectToday } from "../model/hubNav";
import { createProject, defaultProjectFolder, projectSlug } from "../model/projectActions";
import { clearProjectDraft, projectDraft, saveProjectDraft, type DraftCode } from "../model/projectDraft";
import { PROJECT_SHAPES, SHAPE_LABEL } from "../model/projectShapes";
import { setTemplate, TEMPLATES, type TemplateId } from "../model/templates";
import { joinShownStripGroup } from "../model/stripGroups";
import { askChiefOfStaff, NoInterviewRuntime, type InterviewLine, type InterviewReply } from "../model/projectInterview";
import type { HubProject, ProjectIconShape } from "../model/types";
import { SHAPES, StripButton } from "./ProjectStrip";
import { AgentMarkdown } from "../../sessions/ui/AgentMarkdown";

const PRIMARY = "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-40";
const QUIET = "rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content";
type Line = InterviewLine;

/** A first shape from the template (Ash changes it on the card): never the ghost. */
const SHAPE_FOR: Record<TemplateId, ProjectIconShape> = { "game-studio": "gamepad", "product-saas": "rocket", "org-ops": "briefcase" };

/** Ask for a folder Ash already has (the native folder dialog). Null when he cancels or there is no dialog. */
async function pickFolder(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title: "Choose the project's folder" });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}

/**
 * New project is chat-first: Ash types a name, then the interview talks it through (projectInterview.ts: the
 * first mate contract, asking what it needs). It ends on a preview card from its proposal that says exactly what
 * Create makes; nothing exists until Create.
 * Create goes to Ash OS (`project-create`): the project, its own memory, and (by default) its code folder at
 * ~/Projects/<id> as a local git repo with a README. Then its Lead Mono is seeded and it joins the strip.
 */
export function NewProjectView() {
  // Picks up where Ash left off: the sidebar draft keeps the interview.
  const [saved] = useState(projectDraft);
  const [name, setName] = useState(saved?.name ?? "");
  const [started, setStarted] = useState(saved?.started ?? false);
  const [lines, setLines] = useState<Line[]>(saved?.lines ?? []);
  const [typing, setTyping] = useState(false);
  const [stuck, setStuck] = useState<string>();
  const [draft, setDraft] = useState("");
  const [oneLine, setOneLine] = useState(saved?.oneLine ?? "");
  const [tpl, setTpl] = useState<TemplateId | null>(saved?.tpl ?? null);
  const [addon, setAddon] = useState(saved?.addon ?? false);
  const [shape, setShape] = useState<ProjectIconShape | undefined>(saved?.shape);
  const [code, setCode] = useState<DraftCode>(saved?.code ?? "new");
  const [folder, setFolder] = useState<string | undefined>(saved?.folder);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string>();
  const ended = useRef(false);
  useEffect(() => {
    if (!ended.current && started) saveProjectDraft({ name, started, lines, oneLine, tpl, addon, shape, code, folder });
  }, [name, started, lines, oneLine, tpl, addon, shape, code, folder]);
  const end = useRef<HTMLDivElement>(null);
  const n = name.trim();

  // One turn in flight at a time; leaving drops it, and the draft (ending on Ash's line) asks again on return.
  const turn = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => turn.current?.abort(), []);
  const cosTurn = (forName: string, chat: Line[]) => {
    turn.current?.abort();
    const controller = new AbortController();
    turn.current = controller;
    setTyping(true);
    setStuck(undefined);
    askChiefOfStaff(forName, chat, controller.signal).then(
      (reply) => { if (!controller.signal.aborted) took(reply); },
      (e: Error) => { if (!controller.signal.aborted) setStuck(e instanceof NoInterviewRuntime ? e.message : `The interview couldn't answer: ${e.message}`); },
    ).finally(() => { if (turn.current === controller) setTyping(false); });
  };
  const took = ({ text, proposal }: InterviewReply) => {
    if (text) setLines((l) => [...l, { from: "cos", text }]);
    if (!proposal) return;
    if (proposal.name) setName(proposal.name);
    setOneLine(proposal.oneLine);
    setTpl(proposal.template);
    setCode(proposal.code);
    if (proposal.folder) setFolder(proposal.folder);
    setAddon(proposal.addon);
  };

  useEffect(() => {
    // Back to a draft whose last word is Ash's (or that never got a first reply): Chief of Staff answers it now.
    if (saved?.started && saved.lines[saved.lines.length - 1]?.from !== "cos") cosTurn(saved.name.trim(), saved.lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [lines.length, typing, stuck]);

  const start = () => {
    if (!n) return;
    setStarted(true);
    cosTurn(n, []);
  };
  const answer = () => {
    const a = draft.trim();
    if (!a || typing) return;
    const next = [...lines, { from: "ash" as const, text: a }];
    setDraft("");
    setLines(next);
    cosTurn(n, next);
  };

  const id = projectSlug(n);
  const pickedShape: ProjectIconShape = shape ?? (tpl ? SHAPE_FOR[tpl] : "folder");
  const create = () => {
    if (!tpl || creating) return;
    if (code === "existing" && !folder) return setProblem("Choose the folder first, or pick another option.");
    const finish = (project: HubProject) => {
      setTemplate(project.id, tpl);
      // WP-137: made while this window shows only one group, it joins that group, so it shows on the strip.
      joinShownStripGroup(project.id);
      ended.current = true;
      clearProjectDraft();
      // WP-20: a project with code opens on its coding team. WP-06: one without is the no-code page, not Today.
      if (projectHasCodeFolder(project.folder)) openCodingTeam(project.id);
      else setHubSelection(projectHomeSelection(project));
    };
    if (!liveHubStore()) {
      // The example data: no Ash OS to make it, so it is kept on this Mac only.
      const project = { id, name: n, shortName: n.split(" ")[0], iconShape: pickedShape, folder: code === "none" ? null : code === "existing" ? folder ?? null : defaultProjectFolder(id) };
      addMockProject(project);
      return finish(project);
    }
    setCreating(true);
    setProblem(undefined);
    void createProject({ name: n, oneLine: oneLine || n, code: code !== "none", folder: code === "existing" ? folder : undefined, shape: pickedShape }).then(
      (made) => finish(made.project),
      (e: Error) => { setCreating(false); setProblem(e.message); },
    );
  };
  const cancel = () => {
    ended.current = true;
    clearProjectDraft();
    showProjectToday();
  };
  const t = tpl ? TEMPLATES.find((x) => x.id === tpl)! : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-hub-new-project data-step={!started ? 0 : t ? 2 : 1}>
      <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region="deep">
        <Plus className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
        <span className="text-[13px] text-content">{started ? `New project: ${n}` : "New project"}</span>
        {IS_MAC ? null : <div className="ml-auto w-[120px]" />}
      </div>
      {!started ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[640px] flex-col gap-6 px-8 py-10">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-content/60">Name</span>
              <input data-hub-new-project-name autoFocus value={name} onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") start(); }} placeholder="Example: Moonrise"
                className="rounded-md bg-content/5 px-2.5 py-2 text-[13px] text-content outline-none placeholder:text-content/45" />
            </label>
            <div className="flex gap-2">
              <button type="button" className={PRIMARY} disabled={!n} onClick={start}>Continue</button>
              <button type="button" className={QUIET} onClick={cancel}>Cancel</button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-[640px] flex-col gap-4 px-8 py-8" data-hub-new-project-chat>
              {lines.map((l, i) => (
                <div key={i} className="hub-fade-in">
                  <div className="pb-0.5 text-xs text-content/60">{l.from === "cos" ? "Setup" : "You"}</div>
                  {l.from === "cos" ? (
                    // r65 (PM's r63 run): CoS writes markdown ("**A product families use**"); it renders, never shows raw.
                    <AgentMarkdown text={l.text} className="agent-chat-bubble-md text-[13px] text-content" />
                  ) : (
                    <div className="whitespace-pre-wrap text-[13px] text-content">{l.text}</div>
                  )}
                </div>
              ))}
              {t ? (
                <div className="hub-fade-in flex flex-col gap-4 rounded-xl bg-content/5 p-5" data-hub-new-project-preview>
                  <div className="flex items-center gap-3">
                    <StripButton label={n.split(" ")[0]} title={n} selected onClick={() => {}} Icon={SHAPES[pickedShape]} />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-content">{n}</div>
                      <div className="text-xs text-content/60">{oneLine}</div>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5" data-hub-new-project-shapes>
                    <span className="text-xs text-content/60">Icon</span>
                    <div className="flex flex-wrap gap-1">
                      {PROJECT_SHAPES.map((sh) => {
                        const Icon = SHAPES[sh];
                        const on = sh === pickedShape;
                        return (
                          <button key={sh} type="button" aria-label={`Icon ${SHAPE_LABEL[sh]}`} aria-pressed={on} title={SHAPE_LABEL[sh]} data-hub-new-project-shape={sh}
                            onClick={() => setShape(sh)}
                            className={`grid size-8 place-items-center rounded-md ${on ? "bg-content/12 text-content" : "text-content/60 hover:bg-content/8 hover:text-content"}`}>
                            <Icon className="size-4" strokeWidth={1.75} />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Code folder" data-hub-new-project-code={code}>
                    <span className="text-xs text-content/60">Code</span>
                    {([
                      ["new", `A new folder at ${defaultProjectFolder(id)}: a git repo with a README, never pushed`],
                      ["existing", folder ? `My folder: ${folder}` : "A folder I already have…"],
                      ["none", "No code, just the project and its memory"],
                    ] as const).map(([value, label]) => (
                      <label key={value} className="flex cursor-default items-center gap-2 text-[13px] text-content/85">
                        <input type="radio" name="code" checked={code === value} data-hub-new-project-code-choice={value}
                          onChange={() => {
                            setCode(value);
                            setProblem(undefined);
                            if (value === "existing" && !folder) void pickFolder().then((f) => f && setFolder(f));
                          }} />
                        <span className="min-w-0 break-all">{label}</span>
                        {value === "existing" && code === "existing" ? (
                          <button type="button" className="shrink-0 rounded-md px-2 py-0.5 text-xs text-content/70 hover:bg-content/8 hover:text-content" data-hub-new-project-pick-folder
                            onClick={() => void pickFolder().then((f) => f && setFolder(f))}>{folder ? "Change…" : "Choose…"}</button>
                        ) : null}
                      </label>
                    ))}
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-content/60">Memory</span>
                    <div className="text-[13px] text-content">Its own memory. Nothing from your other projects comes with it.</div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-content/60">Starts as</span>
                    <TemplatePicker value={t.id} onChange={setTpl} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-content/60">Team</span>
                    <div className="text-[13px] text-content" data-hub-new-project-team>
                      {leadSpecFor({ id, name: n, shortName: n.split(" ")[0] }).name}, its own lead
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" className={PRIMARY} onClick={create} disabled={creating} data-hub-create-project>{creating ? "Creating…" : "Create project"}</button>
                    <button type="button" className={QUIET} onClick={cancel} disabled={creating}>Cancel</button>
                  </div>
                  {problem ? <p className="text-[13px] leading-5 text-content/70" role="alert" data-hub-new-project-problem>{problem}</p> : null}
                </div>
              ) : null}
              {stuck ? (
                <div className="flex items-center gap-2 text-[13px] text-content/70" role="alert" data-hub-new-project-stuck>
                  <span>{stuck}</span>
                  <button type="button" className={QUIET} onClick={() => cosTurn(n, lines)}>Try again</button>
                </div>
              ) : null}
              <div className="h-5 text-xs text-content/60" aria-live="polite">{typing ? "Typing…" : null}</div>
              <div ref={end} />
            </div>
          </div>
          <div className="mx-auto w-full max-w-[640px] shrink-0 px-8 pb-4">
            <input data-hub-new-project-answer autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") answer(); }} placeholder="Your reply"
              className="w-full rounded-lg bg-content/5 px-3 py-2.5 text-[13px] text-content outline-none placeholder:text-content/45" />
          </div>
        </>
      )}
    </div>
  );
}

export function TemplatePicker({ value, onChange }: { value: TemplateId; onChange: (t: TemplateId) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-content/60">Dashboard</span>
      {TEMPLATES.map((t) => {
        const on = t.id === value;
        return (
          <button key={t.id} type="button" data-hub-template={t.id} onClick={() => onChange(t.id)}
            className={`flex items-start gap-3 rounded-lg px-3 py-2.5 text-left ${on ? "bg-content/12" : "hover:bg-content/5"}`}>
            <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full ${on ? "bg-content text-background-base" : "bg-content/10"}`}>
              {on ? <Check className="size-3" strokeWidth={2.5} /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-[13px] text-content ${on ? "font-medium" : ""}`}>{t.label}</span>
              <span className="block text-[13px] text-content/60">{t.blurb}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
