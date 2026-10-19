import { useEffect, useRef, useState } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { Check, Plus } from "../../../shared/ui/icons";
import { addMockProject } from "../model/mockData";
import { setHubSelection } from "../model/hubNav";
import { clearProjectDraft, projectDraft, saveProjectDraft } from "../model/projectDraft";
import { setTemplate, TEMPLATES, type TemplateId } from "../model/templates";
import { plainName } from "../model/roleNames";
import { ADDON_OFFER, DEFAULT_TEAM } from "../model/builtInMonos";
import { addTeamAddon } from "../model/hubTeam";
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

/**
 * New project is chat-first: Ash types a name, then Chief of Staff asks a few
 * questions in chat. It ends on a preview card; nothing exists until Create.
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
  const ended = useRef(false);
  useEffect(() => {
    if (!ended.current && started) saveProjectDraft({ name, started, lines, answers, tpl, addon });
  }, [name, started, lines, answers, tpl, addon]);
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

  const create = () => {
    if (!tpl) return;
    const t = TEMPLATES.find((x) => x.id === tpl)!;
    const id = n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    const project = { id, name: n, shortName: n.split(" ")[0], iconShape: t.icon, folder: `/Users/ash/harness/${id}` };
    addMockProject(project);
    setTemplate(id, tpl);
    // Ticking the add-on is Ash's yes: Critiquito joins with its soul and sits in this project's Leadership team.
    if (addon) addTeamAddon(ADDON_OFFER.id, [project]);
    ended.current = true;
    clearProjectDraft();
    setHubSelection({ project: id, item: "inbox" });
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
                    <StripButton label={n.split(" ")[0]} title={n} selected onClick={() => {}} Icon={SHAPES[t.icon]} />
                    <div>
                      <div className="text-[13px] font-medium text-content">{n}</div>
                      <div className="text-xs text-content/60">{answers[0]}</div>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-content/60">Starts as</span>
                    <TemplatePicker value={t.id} onChange={setTpl} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-content/60">Team</span>
                    <div className="text-[13px] text-content">{[...DEFAULT_TEAM, ...(addon ? [ADDON_OFFER.name] : [])].map((m) => plainName(m).primary).join(", ")}</div>
                  </div>
                  <label className="flex cursor-default items-center gap-2 text-[13px] text-content/85" data-hub-addon>
                    <button type="button" role="checkbox" aria-checked={addon} onClick={() => setAddon(!addon)}
                      className="grid size-4 place-items-center rounded bg-content/10 text-content">
                      {addon ? <Check className="size-3" strokeWidth={2} /> : null}
                    </button>
                    Also add {plainName(ADDON_OFFER.name).primary}: {ADDON_OFFER.what}
                  </label>
                  <div className="flex gap-2">
                    <button type="button" className={PRIMARY} onClick={create} data-hub-create-project>Create project</button>
                    <button type="button" className={QUIET} onClick={cancel}>Cancel</button>
                  </div>
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
