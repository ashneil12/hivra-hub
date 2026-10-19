import { useEffect, useRef, useState } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { Check, Plus } from "../../../shared/ui/icons";
import { addMockProject } from "../model/mockData";
import { liveHubStore } from "../model/hubData";
import { leadSpecFor } from "../model/hubLeads";
import { setHubSelection } from "../model/hubNav";
import { createProject, defaultProjectFolder, projectSlug } from "../model/projectActions";
import { clearProjectDraft, projectDraft, saveProjectDraft, type DraftCode } from "../model/projectDraft";
import { PROJECT_SHAPES, SHAPE_LABEL } from "../model/projectShapes";
import { setTemplate, TEMPLATES, type TemplateId } from "../model/templates";
import { plainName } from "../model/roleNames";
import { ADDON_OFFER, DEFAULT_TEAM } from "../model/builtInMonos";
import type { ProjectIconShape } from "../model/types";
import { SHAPES, StripButton } from "./ProjectStrip";

const PRIMARY = "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-40";
const QUIET = "rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content";
const COS = "Chief of Staff";

const QUESTIONS = [
  "What is it, in a sentence?",
  "Who is it for?",
  "What matters most first?",
];

type Line = { from: "cos" | "ash"; text: string };

/** Best guess at a template from the answers; Ash can change it on the card. */
function guessTemplate(text: string): TemplateId {
  const t = text.toLowerCase();
  if (/game|play|level|player/.test(t)) return "game-studio";
  if (/team|org|ops|hiring|office/.test(t)) return "org-ops";
  return "product-saas";
}

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
 * New project is chat-first: Ash types a name, then Chief of Staff asks a few
 * questions in chat. It ends on a preview card that says exactly what Create makes; nothing exists until Create.
 * Create goes to Ash OS (`ash-hub-project-create`): the project, its own memory, and (by default) its code folder at
 * ~/Projects/<id> as a local git repo with a README. Then its Lead Mono is seeded and it joins the strip.
 */
export function NewProjectView() {
  // Picks up where Ash left off: the sidebar draft keeps the interview.
  const [saved] = useState(projectDraft);
  const [name, setName] = useState(saved?.name ?? "");
  const [started, setStarted] = useState(saved?.started ?? false);
  const [lines, setLines] = useState<Line[]>(saved?.lines ?? []);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [answers, setAnswers] = useState<string[]>(saved?.answers ?? []);
  const [tpl, setTpl] = useState<TemplateId | null>(saved?.tpl ?? null);
  const [addon, setAddon] = useState(saved?.addon ?? false);
  const [shape, setShape] = useState<ProjectIconShape | undefined>(saved?.shape);
  const [code, setCode] = useState<DraftCode>(saved?.code ?? "new");
  const [folder, setFolder] = useState<string | undefined>(saved?.folder);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string>();
  const ended = useRef(false);
  useEffect(() => {
    if (!ended.current && started) saveProjectDraft({ name, started, lines, answers, tpl, addon, shape, code, folder });
  }, [name, started, lines, answers, tpl, addon, shape, code, folder]);
  const end = useRef<HTMLDivElement>(null);
  const n = name.trim();
  const done = answers.length >= QUESTIONS.length;

  const cosSays = (text: string, after?: () => void) => {
    setTyping(true);
    window.setTimeout(() => {
      setTyping(false);
      setLines((l) => [...l, { from: "cos", text }]);
      after?.();
    }, 900);
  };

  useEffect(() => {
    if (saved?.started && saved.lines[saved.lines.length - 1]?.from === "ash" && !saved.tpl) {
      const a = saved.answers;
      if (a.length < QUESTIONS.length) cosSays(QUESTIONS[a.length]);
      else cosSays("Thanks. Here's how it will look. Nothing is created until you press Create project.", () => setTpl(guessTemplate(a.join(" "))));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [lines.length, typing]);

  const start = () => {
    if (!n) return;
    setStarted(true);
    cosSays(`Let's set up ${n}. ${QUESTIONS[0]}`);
  };
  const answer = () => {
    const a = draft.trim();
    if (!a || typing || done) return;
    const next = [...answers, a];
    setAnswers(next);
    setDraft("");
    setLines((l) => [...l, { from: "ash", text: a }]);
    if (next.length < QUESTIONS.length) cosSays(QUESTIONS[next.length]);
    else cosSays("Thanks. Here's how it will look. Nothing is created until you press Create project.", () => setTpl(guessTemplate(next.join(" "))));
  };

  const id = projectSlug(n);
  const pickedShape: ProjectIconShape = shape ?? (tpl ? SHAPE_FOR[tpl] : "folder");
  const create = () => {
    if (!tpl || creating) return;
    if (code === "existing" && !folder) return setProblem("Choose the folder first, or pick another option.");
    const finish = (projectId: string) => {
      setTemplate(projectId, tpl);
      ended.current = true;
      clearProjectDraft();
      setHubSelection({ project: projectId, item: "inbox" });
    };
    if (!liveHubStore()) {
      // The example data: no Ash OS to make it, so it is kept on this Mac only.
      addMockProject({ id, name: n, shortName: n.split(" ")[0], iconShape: pickedShape, folder: code === "none" ? null : code === "existing" ? folder ?? null : defaultProjectFolder(id) });
      return finish(id);
    }
    setCreating(true);
    setProblem(undefined);
    void createProject({ name: n, oneLine: answers[0] ?? n, code: code !== "none", folder: code === "existing" ? folder : undefined, shape: pickedShape }).then(
      (made) => finish(made.project.id),
      (e: Error) => { setCreating(false); setProblem(e.message); },
    );
  };
  const cancel = () => {
    ended.current = true;
    clearProjectDraft();
    setHubSelection({ project: "today", item: "inbox" });
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
                  <div className="pb-0.5 text-xs text-content/60">{l.from === "cos" ? COS : "You"}</div>
                  <div className="text-[13px] text-content">{l.text}</div>
                </div>
              ))}
              {t ? (
                <div className="hub-fade-in flex flex-col gap-4 rounded-xl bg-content/5 p-5" data-hub-new-project-preview>
                  <div className="flex items-center gap-3">
                    <StripButton label={n.split(" ")[0]} title={n} selected onClick={() => {}} Icon={SHAPES[pickedShape]} />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-content">{n}</div>
                      <div className="text-xs text-content/60">{answers[0]}</div>
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
                      {[...DEFAULT_TEAM, ...(addon ? [ADDON_OFFER.name] : [])].map((m) => plainName(m).primary).join(", ")}, and {leadSpecFor({ id, name: n, shortName: n.split(" ")[0] }).name}, its own Lead
                    </div>
                  </div>
                  <label className="flex cursor-default items-center gap-2 text-[13px] text-content/85" data-hub-addon>
                    <button type="button" role="checkbox" aria-checked={addon} onClick={() => setAddon(!addon)}
                      className="grid size-4 place-items-center rounded bg-content/10 text-content">
                      {addon ? <Check className="size-3" strokeWidth={2} /> : null}
                    </button>
                    Also add {plainName(ADDON_OFFER.name).primary}: {ADDON_OFFER.what}
                  </label>
                  <div className="flex items-center gap-2">
                    <button type="button" className={PRIMARY} onClick={create} disabled={creating} data-hub-create-project>{creating ? "Creating…" : "Create project"}</button>
                    <button type="button" className={QUIET} onClick={cancel} disabled={creating}>Cancel</button>
                  </div>
                  {problem ? <p className="text-[13px] leading-5 text-content/70" role="alert" data-hub-new-project-problem>{problem}</p> : null}
                </div>
              ) : null}
              <div className="h-5 text-xs text-content/60" aria-live="polite">{typing ? `${COS} is typing…` : null}</div>
              <div ref={end} />
            </div>
          </div>
          {!done ? (
            <div className="mx-auto w-full max-w-[640px] shrink-0 px-8 pb-4">
              <input data-hub-new-project-answer autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") answer(); }} placeholder={`Reply to ${COS}`}
                className="w-full rounded-lg bg-content/5 px-3 py-2.5 text-[13px] text-content outline-none placeholder:text-content/45" />
            </div>
          ) : null}
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
