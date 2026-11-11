import { useMemo, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, MessageMultiple, Plus } from "../../../shared/ui/icons";
import { projectKey } from "../../../shared/lib/paths";
import { isHarnessAvailable } from "../../../integrations/harness/core/availability";
import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import { listMonos, monoLook, monosSnapshot, subscribeMonos, type Mono } from "../../monos/model/mono";
import { hubData, useHubDataVersion } from "../model/hubData";
import { listChats, useHubChatsVersion } from "../model/hubChats";
import { CATALOG, connectorDenied, useConnectorsView, type ConnectorsView } from "../model/hubConnectors";
import {
  addNamedMono,
  approveProposal,
  createTeam,
  declineProposal,
  engineTitle,
  getTeam,
  listTeams,
  monoEngine,
  openTeamRoom,
  pendingMonoProposals,
  soulFromBrief,
  useHubTeamsVersion,
  type MonoProposal,
  type MonoSpec,
  type Team,
} from "../model/hubTeams";
import { dismissTeamDraft, useWaitingTeamDrafts, type TeamDraft } from "../../selfBuild/model/teamMake";

const buttonClass =
  "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";
const inputClass =
  "h-7.5 w-full min-w-0 rounded-md bg-content/6 px-2 text-[13px] text-content outline-none placeholder:text-content/35 focus:bg-content/10";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "That didn't work.";
}

function useMonos(): Mono[] {
  const snap = useSyncExternalStore(subscribeMonos, monosSnapshot, monosSnapshot);
  return useMemo(() => listMonos(), [snap]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The hub's projects that have a folder: what a team (and its Monos) can work on. */
function teamProjects(): { id: string; name: string; folder: string }[] {
  return hubData()
    .listProjects()
    .flatMap((p) => (p.folder ? [{ id: p.id, name: p.name, folder: p.folder }] : []));
}

/**
 * Settings → Teams: teams of named Monos Ash works with (Marketing, …). Making one here is Ash's own okay; a Mono an
 * agent proposes waits at the top until he approves it.
 */
export function TeamsPage() {
  useHubDataVersion();
  useHubTeamsVersion();
  const monos = useMonos();
  const connectors = useConnectorsView();
  const [creating, setCreating] = useState(false);
  const teams = listTeams();
  const proposals = pendingMonoProposals();
  const teamDrafts = useWaitingTeamDrafts();
  return (
    <div className="flex flex-col gap-7" data-hub-teams>
      <p className="text-[13px] leading-5 text-content/70">
        A team is a group chat with a few first mates. Every project starts with a Leadership team, and you can add
        more. You talk to a team from Teams in its project's sidebar. To make a new first mate, ask any first mate in
        its chat: it drafts it with you, and it's made when you say yes.
      </p>

      {/* Dropwave (Ash, 11 Nov: "how does teams in settings really work when you have different projects?"): every
          project's team chats, and who is in each. */}
      <ProjectTeams monos={monos} />

      {teamDrafts.length ? (
        <section data-hub-team-drafts>
          <h3 className="mb-1 px-3 text-xs text-content/60">Waiting for your okay</h3>
          <div className="flex flex-col gap-2">
            {teamDrafts.map((d) => (
              <DraftTeamCard key={d.id} draft={d} />
            ))}
          </div>
        </section>
      ) : null}

      {proposals.length ? (
        <section data-hub-mono-proposals>
          <h3 className="mb-1 px-3 text-xs text-content/60">Waiting for your okay</h3>
          <div className="flex flex-col gap-2">
            {proposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex items-center px-3">
          <h3 className="flex-1 text-xs text-content/60">Teams you set up here</h3>
          {!creating ? (
            <button type="button" className={`${buttonClass} inline-flex items-center gap-1`} data-hub-new-team onClick={() => setCreating(true)}>
              <Plus className="size-3" strokeWidth={2} /> New team
            </button>
          ) : null}
        </div>
        {creating ? <NewTeamForm monos={monos} connectors={connectors} onDone={() => setCreating(false)} /> : null}
        {teams.length ? (
          teams.map((team) => <TeamCard key={team.id} team={team} monos={monos} connectors={connectors} />)
        ) : !creating ? (
          <p className="px-3 text-[13px] text-content/60">No teams yet. Start one for marketing, sales or anything you run.</p>
        ) : null}
      </section>
    </div>
  );
}

/** Every project's team chats with their members, so Settings shows which teams exist where. */
function ProjectTeams({ monos }: { monos: Mono[] }) {
  useHubChatsVersion();
  const projects = hubData().listProjects();
  const rows = projects.flatMap((project) => listChats(project.id).map((chat) => ({ project, chat })));
  if (!rows.length) return null;
  return (
    <section className="flex flex-col gap-2" data-hub-project-teams>
      <h3 className="px-3 text-xs text-content/60">In your projects</h3>
      <div className="flex flex-col rounded-lg border border-stroke">
        {rows.map(({ project, chat }, index) => {
          const members = chat.memberIds.map((id) => monos.find((mono) => mono.id === id)).filter((mono): mono is Mono => !!mono);
          return (
            <div key={chat.id} className={`flex items-center gap-3 px-3 py-2.5 ${index ? "border-t border-stroke" : ""}`} data-hub-project-team={chat.id}>
              <MessageMultiple className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] text-content">{project.name} · {chat.name}</span>
                <span className="truncate text-[12px] text-content/60">
                  {members.length ? `You, ${members.map((mono) => monoLook(mono).name).join(", ")}` : "Only you so far"}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** A team a Mono drafted in chat (A6): the yes is Ash's in that chat; here he can wave it off. */
function DraftTeamCard({ draft }: { draft: TeamDraft }) {
  const projects = teamProjects();
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-stroke px-3 py-3" data-hub-team-draft={draft.id}>
      <div className="text-[13px] text-content">
        {draft.by.name} drafted <span className="font-medium">{draft.name}</span>
      </div>
      <p className="text-[13px] leading-5 text-content/70">{draft.brief}</p>
      <p className="text-xs text-content/55">
        {draft.projects.map((id) => projects.find((p) => p.id === id)?.name ?? id).join(", ")} ·{" "}
        {draft.members.length ? draft.members.map((m) => m.name).join(", ") : "no Monos yet"}
      </p>
      <div className="flex gap-2">
        <span className="flex-1 self-center text-xs text-content/55">Nothing is made yet. Say yes in the chat to make it; this card only turns it down.</span>
        <button type="button" className={buttonClass} data-hub-team-draft-dismiss onClick={() => dismissTeamDraft(draft.id)}>
          Not this one
        </button>
      </div>
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: MonoProposal }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [showSoul, setShowSoul] = useState(false);
  const team = proposal.teamId ? getTeam(proposal.teamId) : undefined;
  const teamName = team?.name ?? proposal.teamName;
  const soul = proposal.spec.soul?.trim() ? proposal.spec.soul : soulFromBrief(proposal.spec, teamName);
  const projects = teamProjects();
  const hubIds = projects.filter((p) => proposal.spec.projects.some((f) => projectKey(f) === projectKey(p.folder))).map((p) => p.id);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-stroke px-3 py-3" data-hub-mono-proposal={proposal.id}>
      <div className="text-[13px] text-content">
        {proposal.proposedBy.name} proposes <span className="font-medium">{proposal.spec.name}</span>
        {teamName ? ` for the ${teamName} team${team ? "" : " (a new team)"}` : ""}
      </div>
      {proposal.spec.brief ? <p className="text-[13px] leading-5 text-content/70">{proposal.spec.brief}</p> : null}
      <p className="text-xs text-content/55">
        {engineTitle(proposal.spec.engine)} · {proposal.spec.projects.map(folderLabel).join(", ") || "no project"} ·{" "}
        {proposal.spec.connectors.length
          ? proposal.spec.connectors.map((id) => CATALOG.find((c) => c.id === id)?.name ?? id).join(", ")
          : "no connectors"}
      </p>
      <button type="button" onClick={() => setShowSoul(!showSoul)} className="inline-flex w-fit items-center gap-1 text-xs text-content/60 hover:text-content">
        {showSoul ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} Its soul
      </button>
      {showSoul ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-content/5 p-2 text-xs text-content/75">{soul}</pre> : null}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          className={buttonClass}
          data-hub-approve-mono
          onClick={() => {
            setBusy(true);
            void approveProposal(proposal.id, hubIds)
              .catch((e) => setProblem(errorText(e)))
              .finally(() => setBusy(false));
          }}
        >
          Approve
        </button>
        <button type="button" disabled={busy} className={buttonClass} data-hub-decline-mono onClick={() => declineProposal(proposal.id)}>
          Not now
        </button>
      </div>
      {problem ? <p className="text-xs text-amber-500">{problem}</p> : null}
    </div>
  );
}

function folderLabel(folder: string): string {
  return teamProjects().find((p) => projectKey(p.folder) === projectKey(folder))?.name ?? folder.split("/").pop() ?? folder;
}

function TeamCard({ team, monos, connectors }: { team: Team; monos: Mono[]; connectors: ConnectorsView | null }) {
  const [adding, setAdding] = useState(false);
  const members = team.memberIds.map((id) => monos.find((m) => m.id === id)).filter((m): m is Mono => !!m);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-stroke px-3 py-3" data-hub-team={team.id}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-content">{team.name}</span>
        {team.roomChatId ? (
          <button type="button" className={`${buttonClass} inline-flex items-center gap-1`} data-hub-team-room onClick={() => openTeamRoom(team)}>
            <MessageMultiple className="size-3" strokeWidth={1.75} /> Team room
          </button>
        ) : null}
      </div>
      {team.brief ? <p className="text-[13px] leading-5 text-content/70">{team.brief}</p> : null}
      <p className="text-xs text-content/55">
        {team.projects.map((id) => hubData().listProjects().find((p) => p.id === id)?.name ?? id).join(", ")}
      </p>
      <div className="flex flex-col gap-1">
        {members.map((mono) => (
          <div key={mono.id} className="flex items-center gap-2 text-[13px]" data-hub-team-member={mono.id}>
            <span className="min-w-0 flex-1 truncate text-content/85">{monoLook(mono).name}</span>
            <span className="shrink-0 text-xs text-content/50">{engineTitle(monoEngine(mono.id) ?? "claude")}</span>
          </div>
        ))}
        {!members.length ? <span className="text-xs text-content/50">No Monos yet.</span> : null}
      </div>
      {adding ? (
        <MonoDraft
          team={team}
          connectors={connectors}
          onCancel={() => setAdding(false)}
          onMake={async (spec) => {
            await addNamedMono(team.id, spec);
            setAdding(false);
          }}
        />
      ) : (
        <button type="button" className={`${buttonClass} w-fit`} data-hub-add-mono onClick={() => setAdding(true)}>
          Add a Mono
        </button>
      )}
    </div>
  );
}

function NewTeamForm({ connectors, onDone }: { monos: Mono[]; connectors: ConnectorsView | null; onDone: () => void }) {
  const projects = teamProjects();
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [problem, setProblem] = useState<string>();
  const [team, setTeam] = useState<Team | null>(null);
  if (team)
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-stroke px-3 py-3" data-hub-team-created={team.id}>
        <p className="text-[13px] text-content">
          {team.name} team is made, with its room. Add its first Mono:
        </p>
        <MonoDraft
          team={team}
          connectors={connectors}
          onCancel={onDone}
          onMake={async (spec) => {
            await addNamedMono(team.id, spec);
            onDone();
          }}
        />
      </div>
    );
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-stroke px-3 py-3" data-hub-new-team-form>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-content/60">Team name</span>
        <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Marketing" className={inputClass} data-hub-team-name />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-content/60">What the team is for</span>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.currentTarget.value)}
          rows={2}
          placeholder="Grow Hivra and Nibbii: posts, launches, emails."
          className={`${inputClass} h-auto py-1.5`}
          data-hub-team-brief
        />
      </label>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs text-content/60">Projects (its room lives in the first)</legend>
        {projects.map((p) => (
          <label key={p.id} className="flex items-center gap-2 text-[13px] text-content/80">
            <input
              type="checkbox"
              checked={picked.includes(p.id)}
              onChange={(e) => setPicked(e.currentTarget.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))}
              data-hub-team-project={p.id}
            />
            {p.name}
          </label>
        ))}
        {!projects.length ? <span className="text-xs text-content/50">No projects with a folder yet.</span> : null}
      </fieldset>
      <div className="flex gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={!name.trim() || !picked.length}
          data-hub-create-team
          onClick={() => {
            try {
              setTeam(createTeam({ name, brief, projects: picked }));
            } catch (e) {
              setProblem(errorText(e));
            }
          }}
        >
          Make team
        </button>
        <button type="button" className={buttonClass} onClick={onDone}>
          Cancel
        </button>
      </div>
      {problem ? <p className="text-xs text-amber-500">{problem}</p> : null}
    </div>
  );
}

/** One named Mono to make: name, brief (its lane), engine, projects and connectors; the soul previewed from the brief. */
function MonoDraft({
  team,
  connectors,
  onMake,
  onCancel,
}: {
  team: Team;
  connectors: ConnectorsView | null;
  onMake: (spec: MonoSpec) => Promise<void>;
  onCancel: () => void;
}) {
  const folders = teamProjects().filter((p) => team.projects.includes(p.id));
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [engine, setEngine] = useState<HarnessId>("claude");
  const [projects, setProjects] = useState<string[]>(folders.map((p) => p.folder));
  const [picked, setPicked] = useState<string[]>([]);
  const [soul, setSoul] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const keys = projects.map(projectKey);
  const signedIn = CATALOG.filter((c) => connectors?.settings.connectors[c.id]?.signedIn);
  const preview = soulFromBrief({ name: name.trim() || "This Mono", brief, connectors: picked }, team.name);
  return (
    <div className="flex flex-col gap-3 rounded-md bg-content/4 p-3" data-hub-mono-draft>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-content/60">Name</span>
          <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Maya" className={inputClass} data-hub-mono-name />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-content/60">Engine</span>
          <select
            value={engine}
            onChange={(e) => setEngine(e.currentTarget.value as HarnessId)}
            className={`${inputClass} w-auto pr-6`}
            data-hub-mono-engine
          >
            {HARNESSES.map((h) => (
              <option key={h} value={h} disabled={h !== "claude" && !isHarnessAvailable(h)}>
                {engineTitle(h)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-content/60">Its lane, in a line or two</span>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.currentTarget.value)}
          rows={2}
          placeholder="Writes and schedules our social posts, and reports what worked each Friday."
          className={`${inputClass} h-auto py-1.5`}
          data-hub-mono-brief
        />
      </label>
      {folders.length > 1 ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs text-content/60">Projects</legend>
          {folders.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-[13px] text-content/80">
              <input
                type="checkbox"
                checked={projects.includes(p.folder)}
                onChange={(e) => setProjects(e.currentTarget.checked ? [...projects, p.folder] : projects.filter((x) => x !== p.folder))}
              />
              {p.name}
            </label>
          ))}
        </fieldset>
      ) : null}
      <fieldset className="flex flex-col gap-1" data-hub-mono-connectors>
        <legend className="mb-1 text-xs text-content/60">Connectors</legend>
        {signedIn.map((c) => {
          // What its projects allow, before this Mono's own choice (a new Mono has none yet).
          const denied = connectors ? connectorDenied({ ...connectors.settings, monos: {} }, c, "new", keys) : undefined;
          return (
            <label key={c.id} className="flex items-center gap-2 text-[13px] text-content/80">
              <input
                type="checkbox"
                checked={picked.includes(c.id)}
                onChange={(e) => setPicked(e.currentTarget.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))}
                data-hub-mono-connector={c.id}
              />
              <span className="flex-1">{c.name}</span>
              {denied ? <span className="text-xs text-content/45">not allowed in its projects yet</span> : null}
            </label>
          );
        })}
        {!signedIn.length ? <span className="text-xs text-content/50">No connectors signed in yet (Settings → Connectors).</span> : null}
      </fieldset>
      <div className="flex flex-col gap-1">
        <button type="button" onClick={() => setSoul(soul === null ? preview : null)} className="inline-flex w-fit items-center gap-1 text-xs text-content/60 hover:text-content">
          {soul === null ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />} Its soul {soul === null ? "(written from the lane)" : "(edit freely)"}
        </button>
        {soul !== null ? (
          <textarea value={soul} onChange={(e) => setSoul(e.currentTarget.value)} rows={12} className={`${inputClass} h-auto py-1.5 font-mono text-xs`} data-hub-mono-soul />
        ) : null}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || !name.trim()}
          className={buttonClass}
          data-hub-make-mono
          onClick={() => {
            setBusy(true);
            setProblem(undefined);
            void onMake({ name, brief, engine, projects, connectors: picked, ...(soul !== null ? { soul } : {}) })
              .catch((e) => setProblem(errorText(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Making…" : `Make ${name.trim() || "Mono"}`}
        </button>
        <button type="button" className={buttonClass} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {problem ? <p className="text-xs text-amber-500">{problem}</p> : null}
    </div>
  );
}
