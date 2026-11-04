import { useRef, useState } from "react";
import { Check } from "../../../shared/ui/icons";
import { pickExportForRestore, readImportText, setPendingImport } from "../../portable/model/portable";
import type { PendingImport } from "../../portable/model/importPlan";
import { showAppItem, showProjectToday } from "../model/hubNav";
import { addStarterMono, starterOffers } from "../model/starterMonos";
import { setUserName } from "../model/userName";
import { applyThemePreset, finishOnboarding, needsOnboarding, THEME_PRESETS, type ThemePresetId } from "../model/onboarding";
import { setupProved, snoozeSetupCard } from "../model/setupProof";
import { HubOnboardingSetup } from "./HubOnboardingSetup";

const PRIMARY = "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90";
const QUIET = "rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content";

type Step = "setup" | "welcome" | "start" | "theme" | "done";
const CHOICES: Step[] = ["welcome", "start", "theme", "done"];

/**
 * First launch: the four setup checks (when they are not proved yet), then welcome, roles & projects, theme, done.
 * The choices are skippable; the setup is not, because a chat cannot work without it — its "Not now" closes the card
 * without proving anything. r61: that "Not now" is remembered, so the card does not come back on the next launch.
 */
export function HubOnboarding({ onClose }: { onClose: () => void }) {
  // Fixed when the card opens: proving a check mid-flow must not reshuffle the steps under the person's feet.
  const [steps] = useState<Step[]>(() => {
    const setup: Step[] = setupProved() ? [] : ["setup"];
    const choices = needsOnboarding() ? CHOICES : [];
    return setup.length || choices.length ? [...setup, ...choices] : CHOICES;
  });
  const [step, setStep] = useState(0);
  const [setupOk, setSetupOk] = useState(false);
  const [start, setStart] = useState<"fresh" | "restore">("fresh");
  const [restored, setRestored] = useState<string | null>(null);
  const [name, setName] = useState("");
  // WP-05: starter Monos are offered unticked. Ticking one makes an ordinary Mono. None are added otherwise.
  const offers = starterOffers();
  const [ticked, setTicked] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const picked = (p: PendingImport) => {
    setPendingImport(p);
    setRestored(`Picked ${p.name}: ${p.doc.projects.length} projects, ${p.doc.monos.length} Monos. You'll see it all before anything is added.`);
  };
  const pick = async () => {
    try {
      const p = await pickExportForRestore();
      if (p === "browser") fileRef.current?.click();
      else if (p) picked(p);
    } catch (e) {
      setRestored(e instanceof Error ? e.message : "Couldn't read that export.");
    }
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      picked(readImportText(f.name, await f.text()));
    } catch (e) {
      setRestored(e instanceof Error ? e.message : "Couldn't read that file.");
    }
  };
  const [theme, setTheme] = useState<ThemePresetId>("monocode");
  const done = (next: "today" | "new-project" | "restore" = "today") => {
    finishOnboarding();
    if (name.trim()) setUserName(name);
    if (start === "fresh") for (const id of ticked) addStarterMono(id);
    // A project is the unit of the hub (G1): the hub opens a project's own Today, or the first one; an app view
    // (New project, Restore) opens over it.
    if (next === "today") showProjectToday();
    else showAppItem(next);
    onClose();
  };

  const kind = steps[step];
  const last = step === steps.length - 1;

  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-background-base/75" data-hub-onboarding data-step={kind}>
      <div className="flex w-[520px] flex-col gap-6 rounded-2xl border border-content/7 dialog-glass p-8 shadow-2xl ring-0">
        <div className="flex items-center justify-between text-xs text-content/60">
          {/* One step needs no count (Critiquito, 0.16.3: "Step 1 of 1"). */}
          {steps.length > 1 ? <span data-hub-onboarding-count>Step {step + 1} of {steps.length}</span> : <span />}
          {!last && kind !== "setup" ? (
            <button type="button" data-hub-onboarding-skip onClick={() => done()} className="rounded px-1.5 py-0.5 hover:bg-content/8 hover:text-content">
              Skip
            </button>
          ) : null}
        </div>

        {kind === "setup" ? (
          <HubOnboardingSetup onProvedChange={setSetupOk} />
        ) : null}

        {kind === "welcome" ? (
          <div className="flex flex-col gap-2">
            <h1 className="text-[18px] text-content">Welcome</h1>
            <p className="text-[13px] leading-5 text-content/75">
              This is where your projects, your Monos and the coding team live. Each project has its own Today, Pages and work that needs your attention.
            </p>
            <label className="mt-2 flex flex-col gap-1">
              <span className="text-xs text-content/60">What should your team call you?</span>
              <input data-hub-onboarding-name value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (optional)" maxLength={40}
                className="rounded-md bg-content/6 px-3 py-1.5 text-[13px] text-content outline-none placeholder:text-content/40 focus:bg-content/10" />
            </label>
            <p className="text-[13px] leading-5 text-content/60">A few quick choices. You can change all of it later in Settings.</p>
          </div>
        ) : null}

        {kind === "start" ? (
          <div className="flex flex-col gap-4">
            <h1 className="text-[18px] text-content">How would you like to start?</h1>
            <Group label="Start">
              <Toggle on={start === "fresh"} onClick={() => setStart("fresh")} title="Start a new project" sub="Name it, pick a dashboard" />
              <Toggle on={start === "restore"} onClick={() => { setStart("restore"); void pick(); }} title="Restore from an export" sub="Your setup comes back" />
            </Group>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" data-hub-onboarding-file
              onChange={(e) => void onFile(e.target.files?.[0])} />
            {start === "fresh" ? (
              <Group label="Your team">
                <p className="px-3 pb-1 text-[13px] text-content/75" data-hub-onboarding-team>Add any of these. Each one is an ordinary Mono. None are added unless you tick them.</p>
                {offers.map((offer) => (
                  <Check2 key={offer.id} id={offer.id} on={ticked.includes(offer.id)}
                    onClick={() => setTicked((cur) => cur.includes(offer.id) ? cur.filter((x) => x !== offer.id) : [...cur, offer.id])}
                    title={offer.name} sub={offer.role} />
                ))}
              </Group>
            ) : null}
            {start === "restore" && restored ? <p className="text-[13px] text-content/75" data-hub-onboarding-restored>{restored}</p> : null}
            <p className="whitespace-nowrap text-[13px] leading-5 text-content/60" data-hub-onboarding-dashboards>
              Built-in dashboards: Game studio, Product / SaaS, Org / ops.
            </p>
          </div>
        ) : null}

        {kind === "theme" ? (
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

        {kind === "done" ? (
          <div className="flex flex-col gap-2">
            <h1 className="text-[18px] text-content">You're set</h1>
            <p className="text-[13px] leading-5 text-content/75">
              The {THEME_PRESETS.find((t) => t.id === theme)?.label} look.{" "}
              {start === "fresh" ? "Next, your first project." : restored ? "Next, a look at what your export brings." : "That is everything. Your projects are on the left."}
            </p>
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          {step > 0 && !last ? (
            <button type="button" onClick={() => setStep(step - 1)} className={QUIET}>Back</button>
          ) : null}
          {kind === "setup" ? (
            <>
              <button type="button" data-hub-onboarding-not-now onClick={() => { snoozeSetupCard(); onClose(); }} className={QUIET}>Not now</button>
              <button
                type="button"
                data-hub-onboarding-next
                disabled={!setupOk}
                onClick={() => {
                  if (!last) return setStep(step + 1);
                  // Passed and closed: remembered, so the card never opens on its own again.
                  snoozeSetupCard();
                  onClose();
                }}
                className={`${PRIMARY} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {last ? "Start using MonoCode" : "Continue"}
              </button>
            </>
          ) : last ? (
            <button type="button" data-hub-onboarding-done onClick={() => done(start === "fresh" ? "new-project" : restored ? "restore" : "today")} className={PRIMARY}>
              {start === "fresh" ? "Create your first project" : restored ? "Review the export" : "Start using MonoCode"}
            </button>
          ) : (
            <button type="button" data-hub-onboarding-next onClick={() => setStep(step + 1)} className={PRIMARY}>
              {kind === "welcome" ? "Get started" : "Continue"}
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

/** A tick box for an optional extra (square, so it doesn't read as one of a set of choices). */
function Check2({ on, onClick, title, sub, id }: { on: boolean; onClick: () => void; title: string; sub?: string; id: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} onClick={onClick} data-hub-onboarding-starter={id}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-content/5">
      <span className={`grid size-4 shrink-0 place-items-center rounded ${on ? "bg-content text-background-base" : "bg-content/10"}`}>
        {on ? <Check className="size-3" strokeWidth={2.5} /> : null}
      </span>
      <span className="min-w-0 flex-1 text-[13px] text-content">{title}</span>
      {sub ? <span className="shrink-0 text-xs text-content/60">{sub}</span> : null}
    </button>
  );
}
