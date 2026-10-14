import { useRef, useState } from "react";
import { Check } from "../../../shared/ui/icons";
import { parseSetup, setPendingSetup } from "../model/setupFile";
import { setHubSelection } from "../model/hubNav";
import { applyThemePreset, finishOnboarding, THEME_PRESETS, type ThemePresetId } from "../model/onboarding";

const PRIMARY = "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90";
const QUIET = "rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content";

/** First launch: welcome, roles & projects, theme, done. Skippable at every step. */
export function HubOnboarding({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [start, setStart] = useState<"fresh" | "restore">("fresh");
  const [restored, setRestored] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const file = parseSetup(await f.text());
      setPendingSetup(file, f.name);
      setRestored(`Picked ${f.name}: ${file.projects.length} projects, ${file.bots?.length ?? 0} bots. You'll see it all before anything is added.`);
    } catch (e) {
      setRestored(e instanceof Error ? e.message : "Couldn't read that file.");
    }
  };
  const [theme, setTheme] = useState<ThemePresetId>("monocode");
  const done = (next: "today" | "new-project" | "restore" = "today") => {
    finishOnboarding();
    setHubSelection({ project: "today", item: next === "today" ? "inbox" : next });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-background-base/75" data-hub-onboarding data-step={step}>
      <div className="flex w-[520px] flex-col gap-6 rounded-2xl bg-background-base p-8 shadow-2xl ring-0">
        <div className="flex items-center justify-between text-xs text-content/60">
          <span>Step {step + 1} of 4</span>
          {step < 3 ? (
            <button type="button" data-hub-onboarding-skip onClick={() => done()} className="rounded px-1.5 py-0.5 hover:bg-content/8 hover:text-content">
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
            <p className="text-[13px] leading-5 text-content/60">Two quick choices. You can change all of it later in Settings.</p>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="flex flex-col gap-4">
            <h1 className="text-[18px] text-content">How would you like to start?</h1>
            <Group label="Start">
              <Toggle on={start === "fresh"} onClick={() => setStart("fresh")} title="Start a new project" sub="Name it, pick a dashboard" />
              <Toggle on={start === "restore"} onClick={() => { setStart("restore"); fileRef.current?.click(); }} title="Restore a setup file" sub="Your projects come back" />
            </Group>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" data-hub-onboarding-file
              onChange={(e) => void onFile(e.target.files?.[0])} />
            {start === "restore" && restored ? <p className="text-[13px] text-content/75" data-hub-onboarding-restored>{restored}</p> : null}
            <p className="text-[13px] leading-5 text-content/60">
              Three dashboards come built in: Game studio, Product / SaaS and Org / ops.
            </p>
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
              The {THEME_PRESETS.find((t) => t.id === theme)?.label} look.{" "}
              {start === "fresh" ? "Next, your first project." : restored ? "Next, a look at what your setup file brings." : "Today opens next."}
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
            <button type="button" data-hub-onboarding-done onClick={() => done(start === "fresh" ? "new-project" : restored ? "restore" : "today")} className={PRIMARY}>
              {start === "fresh" ? "Create your first project" : restored ? "Review the setup file" : "Go to Today"}
            </button>
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
