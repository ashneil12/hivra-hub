import { useRef, useState } from "react";
import { Check } from "../../../shared/ui/icons";
import { pickExportForRestore, readImportText, setPendingImport } from "../../portable/model/portable";
import type { PendingImport } from "../../portable/model/importPlan";
import { CLI_ORDER, cliLabel } from "../../crew/model/clis";
import { openCodingTeam, showAppItem, showProjectToday } from "../model/hubNav";
import { addMockProject } from "../model/mockData";
import { liveHubStore } from "../model/hubData";
import { createChat } from "../model/hubChats";
import { createProject, defaultProjectFolder, projectSlug } from "../model/projectActions";
import { beginFirstProject, firstLaunchChoice, saveChosenClis } from "../model/codingTeamHome";
import { addStarterMono, starterOffers } from "../model/starterMonos";
import { setUserName } from "../model/userName";
import { applyThemePreset, finishOnboarding, needsOnboarding, THEME_PRESETS, type ThemePresetId } from "../model/onboarding";
import { setupProved, snoozeSetupCard } from "../model/setupProof";
import { DISPLAY_NAME } from "../../../app/model/displayName";
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
  // Dropwave: the one that reads every project (the Chief of Staff) leads the list and is marked Recommended, since
  // Home and the top of the sidebar are built around it. Still unticked: none are added unless ticked.
  const offers = [...starterOffers()].sort((a, b) => Number(!!b.everyProject) - Number(!!a.everyProject));
  const [ticked, setTicked] = useState<string[]>([]);
  // WP-20: the CLIs on this Mac, a project, and a group. All optional. A project lands in its coding team.
  // A setup that already proved Claude Code (installed, signed in, one real reply) starts with it ticked: a fact, not a guess.
  const [clis, setClis] = useState<string[]>(() => (setupProved() ? ["claude"] : []));
  const [projectName, setProjectName] = useState("");
  const [group, setGroup] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const finishing = useRef(false);
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
    if (finishing.current) return;
    const choice = firstLaunchChoice({ projectName, group, clis });
    // WP-20: a chosen project opens on its coding team. Onboarding finishes only after that project exists.
    // A failed create stays on this card, with the name, CLIs and group still filled in.
    if (choice.projectName && start === "fresh") {
      // Saved before the project opens: the coding team is planned from these ticks, not after the card closes.
      saveChosenClis(choice.clis);
      finishing.current = true;
      setProjectError(null);
      void beginFirstProject(
        { projectName: choice.projectName, group: choice.group },
        {
          create: async (named) => {
            if (!liveHubStore()) {
              const id = projectSlug(named);
              const made = {
                id,
                name: named,
                shortName: named.split(/\s+/)[0]?.slice(0, 16) || id,
                iconShape: "folder" as const,
                folder: defaultProjectFolder(id),
              };
              addMockProject(made);
              return { id, folder: made.folder };
            }
            const made = await createProject({ name: named, oneLine: named, code: true });
            return { id: made.project.id, folder: made.project.folder };
          },
          addGroup: (projectId) => {
            createChat(projectId, "Group", []);
          },
          open: (projectId) => openCodingTeam(projectId),
        },
      ).then((result) => {
        finishing.current = false;
        if (result !== "opened") {
          setProjectError("That project could not be made. Nothing was lost. Try again.");
          setStep(steps.indexOf("start"));
          return;
        }
        finishOnboarding();
        if (name.trim()) setUserName(name);
        for (const id of ticked) addStarterMono(id);
        onClose();
      });
      return;
    }
    saveChosenClis(choice.clis);
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
          {/* One step needs no count. */}
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
            <h1 className="text-[18px] text-content">Welcome to {DISPLAY_NAME}</h1>
            <p className="text-[13px] leading-5 text-content/75">
              You own the work and your first mates do it. Each first mate runs one line of work with its own crew, and comes to you only when something needs your say.
            </p>
            <label className="mt-2 flex flex-col gap-1">
              <span className="text-xs text-content/60">What should your team call you?</span>
              <input data-hub-onboarding-name value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (optional)" maxLength={40}
                className="rounded-md bg-content/6 px-3 py-1.5 text-[13px] text-content outline-none placeholder:text-content/40 focus:bg-content/10" />
            </label>
            <p className="text-[13px] leading-5 text-content/60">Two quick choices next. You can change all of it later in Settings.</p>
          </div>
        ) : null}

        {kind === "start" ? (
          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
            <h1 className="text-[18px] text-content">How would you like to start?</h1>
            <Group label="Start">
              <Toggle on={start === "fresh"} onClick={() => setStart("fresh")} title="Start a new project" sub="Name it below" />
              <Toggle on={start === "restore"} onClick={() => { setStart("restore"); void pick(); }} title="Restore from an export" sub="Your setup comes back" />
            </Group>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" data-hub-onboarding-file
              onChange={(e) => void onFile(e.target.files?.[0])} />
            {start === "fresh" ? (
              <>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-content/60">Your first project</span>
                <input data-hub-onboarding-project value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="A name, like My app (optional)" maxLength={80}
                  className="rounded-md bg-content/6 px-3 py-1.5 text-[13px] text-content outline-none placeholder:text-content/40 focus:bg-content/10" />
                <span className="text-xs leading-5 text-content/55">It gets its own home, first mates and pages. Add more with the + on the left.</span>
              </label>
              {projectError ? <p className="text-[13px] leading-5 text-content/75" data-hub-onboarding-error>{projectError}</p> : null}
              <Group label="Your team">
                <p className="px-3 pb-1 text-[13px] text-content/75" data-hub-onboarding-team>A first mate runs a line of work for you. None are added unless you tick them.</p>
                {offers.map((offer) => (
                  <Check2 key={offer.id} id={offer.id} on={ticked.includes(offer.id)}
                    onClick={() => setTicked((cur) => cur.includes(offer.id) ? cur.filter((x) => x !== offer.id) : [...cur, offer.id])}
                    title={offer.name} sub={offer.role} tag={offer.everyProject ? "Recommended" : undefined} />
                ))}
              </Group>
              <Check2 id="group" dataAttr="data-hub-onboarding-group" on={group} onClick={() => setGroup((on) => !on)}
                title="Add a team chat" sub="A group chat with your first mates" />
              <Group label="Coding tools on this Mac">
                <p className="px-3 pb-1 text-[13px] text-content/75">Tick the ones you have installed. Claude Code alone is enough to start.</p>
                <div className="grid grid-cols-2 gap-x-2">
                  {CLI_ORDER.map((cli) => (
                    <Check2 key={cli} id={cli} dataAttr="data-hub-onboarding-cli" on={clis.includes(cli)}
                      onClick={() => setClis((cur) => (cur.includes(cli) ? cur.filter((item) => item !== cli) : [...cur, cli]))}
                      title={cliLabel(cli)} />
                  ))}
                </div>
              </Group>
              </>
            ) : null}
            {start === "restore" && restored ? <p className="text-[13px] text-content/75" data-hub-onboarding-restored>{restored}</p> : null}
            <p className="whitespace-nowrap text-[13px] leading-5 text-content/60" data-hub-onboarding-dashboards>
              Comes with ready-made pages: Game studio, Product / SaaS, Org / ops.
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
              {start === "fresh"
                ? projectName.trim()
                  ? `Next, ${projectName.trim()} opens with its lead ready to talk.`
                  : "Next, your first project."
                : restored ? "Next, a look at what your export brings." : "That is everything. Your projects are on the left."}
            </p>
            {/* Dropwave: the three places a new person needs, in one glance, before the card closes. */}
            <ul className="mt-1 flex flex-col gap-1.5 text-[13px] leading-5 text-content/75" data-hub-onboarding-tour>
              <li><span className="text-content">Home</span> shows what needs you, what is being worked on and what got done.</li>
              <li>
                <span className="text-content">Chief of Staff</span>, at the top of the sidebar, is who you ask for anything.
                {start === "fresh" && !offers.some((offer) => offer.everyProject && ticked.includes(offer.id)) ? " You didn't add one: Home offers it whenever you want." : ""}
              </li>
              <li><span className="text-content">Inbox</span> collects every question and decision waiting for you.</li>
            </ul>
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
                  // The checks just proved Claude Code, so it starts ticked among the coding tools.
                  setClis((cur) => (cur.includes("claude") ? cur : ["claude", ...cur]));
                  if (!last) return setStep(step + 1);
                  // Passed and closed: remembered, so the card never opens on its own again.
                  snoozeSetupCard();
                  onClose();
                }}
                className={`${PRIMARY} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {last ? `Start using ${DISPLAY_NAME}` : "Continue"}
              </button>
            </>
          ) : last ? (
            <button type="button" data-hub-onboarding-done onClick={() => done(start === "fresh" ? "new-project" : restored ? "restore" : "today")} className={PRIMARY}>
              {start === "fresh" ? (projectName.trim() ? `Open ${projectName.trim()}` : "Create your first project") : restored ? "Review the export" : `Start using ${DISPLAY_NAME}`}
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
function Check2({ on, onClick, title, sub, tag, id, dataAttr = "data-hub-onboarding-starter" }: { on: boolean; onClick: () => void; title: string; sub?: string; tag?: string; id: string; dataAttr?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} onClick={onClick} {...{ [dataAttr]: id }}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-content/5">
      <span className={`grid size-4 shrink-0 place-items-center rounded ${on ? "bg-content text-background-base" : "bg-content/10"}`}>
        {on ? <Check className="size-3" strokeWidth={2.5} /> : null}
      </span>
      {/* The name never gives way: a long role line is what shortens. */}
      <span className="shrink-0 text-[13px] text-content">{title}</span>
      {tag ? <span className="shrink-0 rounded border border-stroke px-1.5 text-[11px] leading-4 text-content/70" data-hub-onboarding-tag>{tag}</span> : null}
      {sub ? <span className="min-w-0 flex-1 truncate text-right text-xs text-content/60" title={sub}>{sub}</span> : <span className="flex-1" />}
    </button>
  );
}
