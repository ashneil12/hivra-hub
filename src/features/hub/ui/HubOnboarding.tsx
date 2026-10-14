import { useState } from "react";
import { Check } from "../../../shared/ui/icons";
import { hubData } from "../model/hubData";
import { setHubSelection } from "../model/hubNav";
import { applyThemePreset, finishOnboarding, THEME_PRESETS, type ThemePresetId } from "../model/onboarding";
import { templateOf } from "../model/templates";

const ROLES = ["Example: founder", "Example: game designer", "Example: product lead", "Example: runs operations"];
const PRIMARY = "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90";
const QUIET = "rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content";

/** First launch: welcome, roles & projects, theme, done. Skippable at every step. */
export function HubOnboarding({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [roles, setRoles] = useState<string[]>([ROLES[0]]);
  const projects = hubData().listProjects();
  const [picked, setPicked] = useState<string[]>(projects.map((p) => p.id));
  const [theme, setTheme] = useState<ThemePresetId>("monocode");
  const done = () => {
    finishOnboarding();
    setHubSelection({ project: "today", item: "inbox" });
    onClose();
  };
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-background-base/75" data-hub-onboarding data-step={step}>
      <div className="flex w-[520px] flex-col gap-6 rounded-2xl bg-background-base p-8 shadow-2xl ring-0">
        <div className="flex items-center justify-between text-xs text-content/60">
          <span>Step {step + 1} of 4</span>
          {step < 3 ? (
            <button type="button" data-hub-onboarding-skip onClick={done} className="rounded px-1.5 py-0.5 hover:bg-content/8 hover:text-content">
              Skip
            </button>
          ) : null}
        </div>

        {step === 0 ? (
          <div className="flex flex-col gap-2">
            <h1 className="text-[18px] text-content">Welcome</h1>
            <p className="text-[13px] leading-5 text-content/75">
              This is where your projects, your Monos and the coding team live. Each morning, Today shows what changed and what's waiting on you. Nothing more.
            </p>
            <p className="text-[13px] leading-5 text-content/60">Three quick questions. You can change all of it later in Settings.</p>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="flex flex-col gap-4">
            <h1 className="text-[18px] text-content">What do you do, and on what?</h1>
            <Group label="Your roles">
              {ROLES.map((r) => (
                <Toggle key={r} on={roles.includes(r)} onClick={() => setRoles(toggle(roles, r))} title={r} />
              ))}
            </Group>
            <Group label="Your projects">
              {projects.map((p) => (
                <Toggle key={p.id} on={picked.includes(p.id)} onClick={() => setPicked(toggle(picked, p.id))}
                  title={`Example: ${p.name}`} sub={templateOf(p.id).label} />
              ))}
            </Group>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="flex flex-col gap-4">
            <h1 className="text-[18px] text-content">Pick a look</h1>
            <Group label="Theme">
              {THEME_PRESETS.map((t) => (
                <Toggle key={t.id} on={theme === t.id} title={t.label} sub={t.blurb}
                  onClick={() => {
                    setTheme(t.id);
                    applyThemePreset(t.id);
                  }} />
              ))}
            </Group>
            <p className="text-[13px] text-content/60">Both keep the Mac's glass. Fine-tune it in Settings → Appearance.</p>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="flex flex-col gap-2">
            <h1 className="text-[18px] text-content">You're set</h1>
            <p className="text-[13px] leading-5 text-content/75">
              {picked.length} project{picked.length === 1 ? "" : "s"}, the {THEME_PRESETS.find((t) => t.id === theme)?.label} look. Today opens next.
            </p>
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          {step > 0 && step < 3 ? (
            <button type="button" onClick={() => setStep(step - 1)} className={QUIET}>Back</button>
          ) : null}
          {step < 3 ? (
            <button type="button" data-hub-onboarding-next onClick={() => setStep(step + 1)} className={PRIMARY}>
              {step === 0 ? "Get started" : "Continue"}
            </button>
          ) : (
            <button type="button" data-hub-onboarding-done onClick={done} className={PRIMARY}>Go to Today</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="pb-1 text-xs text-content/60">{label}</span>
      {children}
    </div>
  );
}

function Toggle({ on, onClick, title, sub }: { on: boolean; onClick: () => void; title: string; sub?: string }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-left ${on ? "bg-content/12" : "hover:bg-content/5"}`}>
      <span className={`grid size-4 shrink-0 place-items-center rounded-full ${on ? "bg-content text-background-base" : "bg-content/10"}`}>
        {on ? <Check className="size-3" strokeWidth={2.5} /> : null}
      </span>
      <span className={`min-w-0 flex-1 text-[13px] text-content ${on ? "font-medium" : ""}`}>{title}</span>
      {sub ? <span className="shrink-0 text-xs text-content/60">{sub}</span> : null}
    </button>
  );
}
