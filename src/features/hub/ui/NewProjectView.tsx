import { useState } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { ArrowLeft, Bot, Check, Plus } from "../../../shared/ui/icons";
import { addMockProject } from "../model/mockData";
import { setHubSelection } from "../model/hubNav";
import { setTemplate, TEMPLATES, type TemplateId } from "../model/templates";
import { SHAPES, StripButton } from "./ProjectStrip";

const PRIMARY = "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-40";
const QUIET = "rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content";

const QUESTIONS = [
  { q: "What is it, in a sentence?", example: "Example: a cosy farming game for phones." },
  { q: "Who is it for?", example: "Example: people who play a little every evening." },
  { q: "What matters most first?", example: "Example: a first playable build to try with friends." },
];

/**
 * New project (onboarding skill): name and template, a few plain questions,
 * then a preview of the project as it will look. Nothing is created until Create.
 */
export function NewProjectView() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [tpl, setTpl] = useState<TemplateId>("game-studio");
  const [answers, setAnswers] = useState<string[]>(QUESTIONS.map(() => ""));
  const t = TEMPLATES.find((x) => x.id === tpl)!;
  const n = name.trim();

  const create = () => {
    const id = n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    addMockProject({ id, name: n, shortName: n.split(" ")[0], iconShape: t.icon, folder: `/Users/ash/harness/${id}` });
    setTemplate(id, tpl);
    setHubSelection({ project: id, item: "inbox" });
  };
  const cancel = () => setHubSelection({ project: "today", item: "inbox" });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-hub-new-project data-step={step}>
      <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region="deep">
        {step > 0 ? (
          <button type="button" aria-label="Back" title="Back" onClick={() => setStep(step - 1)}
            className="grid size-6 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content">
            <ArrowLeft className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : (
          <Plus className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
        )}
        <span className="text-[13px] text-content">{step === 2 ? `New project: ${n}` : "New project"}</span>
        {IS_MAC ? null : <div className="ml-auto w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[640px] flex-col gap-6 px-8 py-10">
          {step === 0 ? (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-content/60">Name</span>
                <input data-hub-new-project-name value={name} onChange={(e) => setName(e.target.value)} placeholder="Example: Moonrise"
                  className="rounded-md bg-content/5 px-2.5 py-2 text-[13px] text-content outline-none placeholder:text-content/45" />
              </label>
              <TemplatePicker value={tpl} onChange={setTpl} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={cancel} className={QUIET}>Cancel</button>
                <button type="button" data-hub-np-next disabled={!n} onClick={() => setStep(1)} className={PRIMARY}>Continue</button>
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div className="flex flex-col gap-5" data-hub-np-questions>
                {QUESTIONS.map((x, i) => (
                  <div key={x.q} className="flex flex-col gap-2">
                    <div className="flex items-center gap-1.5 text-xs text-content/60"><Bot className="size-3" strokeWidth={1.75} />Lead</div>
                    <div className="text-[13px] leading-5 text-content">{x.q}</div>
                    <div className="flex justify-end">
                      <input
                        data-hub-np-answer={i}
                        value={answers[i]}
                        onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
                        placeholder={x.example}
                        className="agent-chat-user-bubble w-[80%] rounded-2xl bg-content/10 px-3 py-1.5 text-[13px] text-content outline-none placeholder:text-content/50"
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setStep(0)} className={QUIET}>Back</button>
                <button type="button" data-hub-np-next onClick={() => setStep(2)} className={PRIMARY}>See the project</button>
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <p className="text-[13px] leading-5 text-content/75">
                Here's {n} as it will look. Nothing is made until you press Create project.
              </p>
              <div className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-6" data-hub-np-preview>
                <Label>In the strip</Label>
                <div className="pointer-events-none -ml-2">
                  <StripButton label={n.split(" ")[0]} title={n} selected onClick={() => {}} Icon={SHAPES[t.icon]} />
                </div>
                <Label>Sidebar</Label>
                <List items={["Coding team", "Leadership team", ...t.sections.map((s) => s.title), "Being built"]} />
                <Label>Leadership team</Label>
                <List items={t.leadership} />
                <Label>Coding team</Label>
                <List items={t.coding} />
                <Label>Today</Label>
                <List items={t.todayCards.slice(1, 4)} />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" data-hub-np-back onClick={() => setStep(1)} className={QUIET}>Back</button>
                <button type="button" data-hub-create-project onClick={create} className={PRIMARY}>Create project</button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="pt-1 text-xs text-content/60">{children}</div>;
}
function List({ items }: { items: string[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((x) => (
        <div key={x} className="rounded-md px-2 py-1 text-[13px] text-content/85">{x}</div>
      ))}
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
