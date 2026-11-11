// Dropwave preview: the new captain-first shell (Home is just a project, every project opens on its Chief of Staff
// chat, first mates and teams in the sidebar, Git and worktrees out of sight). Example data and example replies;
// nothing here reaches a CLI, a folder or the network. See docs/hivra/ux/DROPWAVE.md.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  CREW_COLORS,
  HOME_ID,
  initialProjects,
  initialQuestions,
  replyTo,
  type Go,
  type Mate,
  type Msg,
  type Project,
  type Question,
} from "./data";
import "./dropwave.css";

type View =
  | { screen: "welcome" }
  | { screen: "project"; project: string }
  | { screen: "mate"; project: string; mate: string }
  | { screen: "team"; project: string; team: string }
  | { screen: "place"; project: string; place: string }
  | { screen: "settings"; project: string }
  | { screen: "questions" }
  | { screen: "agents" };

const HANDS_ON = [
  "Tell me about everything",
  "Only the big calls",
  "Just show me results",
];
const ENGINES = ["Claude Code", "Codex", "Grok", "DeepSeek", "OpenRouter"];
const PERSONALITIES = [
  "Warm and brief",
  "Straight to the point",
  "Chatty and curious",
  "Formal",
];

function useTyping() {
  const [typing, setTyping] = useState<string | null>(null);
  return { typing, setTyping };
}

export function DropwaveApp() {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [questions, setQuestions] = useState<Question[]>(initialQuestions);
  const [view, setView] = useState<View>({ screen: "welcome" });
  const [cosName, setCosName] = useState("Chief of Staff");
  const [personality, setPersonality] = useState(PERSONALITIES[0]);
  const [engine, setEngine] = useState(ENGINES[0]);
  const [handsOn, setHandsOn] = useState(1);
  const [sideOpen, setSideOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [newTeamFor, setNewTeamFor] = useState<string | null>(null);
  const { typing, setTyping } = useTyping();

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(id);
  }, [toast]);

  const projectOf = (id: string) => projects.find((p) => p.id === id)!;
  const currentProjectId =
    view.screen === "welcome" ||
    view.screen === "questions" ||
    view.screen === "agents"
      ? HOME_ID
      : view.project;
  const current = projectOf(currentProjectId);

  const go = (g: Go) => {
    setSideOpen(false);
    if (g.to === "project") setView({ screen: "project", project: g.project });
    else if (g.to === "mate")
      setView({ screen: "mate", project: g.project, mate: g.mate });
    else if (g.to === "team")
      setView({ screen: "team", project: g.project, team: g.team });
    else if (g.to === "place")
      setView({ screen: "place", project: g.project, place: g.place });
    else if (g.to === "settings")
      setView({ screen: "settings", project: g.project });
    else if (g.to === "questions") setView({ screen: "questions" });
    else setView({ screen: "agents" });
  };

  const updateProject = (id: string, change: (p: Project) => Project) =>
    setProjects((all) => all.map((p) => (p.id === id ? change(p) : p)));

  const nameOf = (who: string, project: Project) => {
    if (who === "cos") return cosName;
    if (who === "you") return "You";
    return project.mates.find((m) => m.id === who)?.name ?? who;
  };

  /** Add the person's message to a chat, then an example reply after a short pause. */
  const send = (
    where: { project: string; mate?: string; team?: string },
    text: string,
  ) => {
    const project = projectOf(where.project);
    const mine: Msg = { from: "you", text };
    let speaker = where.mate ?? "cos";
    if (where.team) {
      const team = project.teams.find((t) => t.id === where.team)!;
      const at = /@(\w+)/.exec(text)?.[1]?.toLowerCase();
      const named = team.members.find(
        (m) => m !== "cos" && nameOf(m, project).toLowerCase() === at,
      );
      speaker = named ?? "cos";
    }
    const append = (p: Project, msg: Msg): Project => {
      if (where.team)
        return {
          ...p,
          teams: p.teams.map((t) =>
            t.id === where.team ? { ...t, chat: [...t.chat, msg] } : t,
          ),
        };
      if (where.mate)
        return {
          ...p,
          mates: p.mates.map((m) =>
            m.id === where.mate ? { ...m, chat: [...m.chat, msg] } : m,
          ),
        };
      return { ...p, chat: [...p.chat, msg] };
    };
    updateProject(where.project, (p) => append(p, mine));
    const key = `${where.project}/${where.mate ?? ""}/${where.team ?? ""}`;
    setTyping(key);
    window.setTimeout(() => {
      const reply = replyTo(text, speaker, project.name);
      const handedOff =
        !/\?$/.test(text.trim()) &&
        !/\b(status|update|how'?s|going|overnight|today|stop|pause|hold)\b/i.test(
          text,
        );
      updateProject(where.project, (p) => {
        let next = append(p, { from: speaker, text: reply });
        if (handedOff) {
          const task = text.length > 54 ? `${text.slice(0, 52).trim()}…` : text;
          const doer = where.mate ?? next.mates[0]?.id;
          const doerName =
            next.mates.find((m) => m.id === doer)?.name ?? "Coding";
          next = {
            ...next,
            building: [
              { what: task, who: doerName, mins: 0 },
              ...next.building,
            ],
            mates: next.mates.map((m) =>
              m.id === doer
                ? {
                    ...m,
                    status: m.status === "idle" ? "working" : m.status,
                    crew: [{ task, pct: 5, mins: 0 }, ...m.crew],
                  }
                : m,
            ),
          };
        }
        return next;
      });
      setTyping(null);
    }, 1100);
  };

  const answer = (q: Question, option: number) => {
    setQuestions((all) => all.filter((x) => x.id !== q.id));
    updateProject(q.project, (p) => ({
      ...p,
      decided: [
        {
          what: `You picked "${q.options[option]}" for: ${q.ask}`,
          who: "You",
          when: "now",
        },
        ...p.decided,
      ],
      chat: [
        ...p.chat,
        { from: "you", text: `${q.ask} ${q.options[option]}.` },
        {
          from: "cos",
          text: `Thanks. "${q.options[option]}" it is. I've told the crew and everything goes ahead as planned.`,
        },
      ],
      mates: p.mates.map((m) =>
        m.status === "needs" ? { ...m, status: "working" } : m,
      ),
    }));
  };

  const totalOpen = questions.length;
  const openFor = (id: string) =>
    id === HOME_ID
      ? totalOpen
      : questions.filter((q) => q.project === id).length;

  if (view.screen === "welcome")
    return (
      <div className="dw">
        <Rail
          projects={projects.filter((p) => p.id === HOME_ID)}
          active={HOME_ID}
          openFor={() => 0}
          go={go}
        />
        <Welcome
          cosName={cosName}
          engine={engine}
          handsOn={handsOn}
          onPick={(i) => {
            setHandsOn(i);
            go({ to: "project", project: HOME_ID });
            setToast(
              `Got it: "${HANDS_ON[i]}". You can change this in Settings.`,
            );
          }}
          onSay={(text) => {
            updateProject(HOME_ID, (p) => ({
              ...p,
              chat: [...p.chat, { from: "you", text }],
            }));
            go({ to: "project", project: HOME_ID });
            window.setTimeout(
              () =>
                updateProject(HOME_ID, (p) => ({
                  ...p,
                  chat: [
                    ...p.chat,
                    {
                      from: "cos",
                      text: "Lovely. I'll set up a project for that and pick the first mates it needs. You'll see it in the rail on the left.",
                    },
                  ],
                })),
              900,
            );
          }}
        />
      </div>
    );

  return (
    <div className={`dw${sideOpen ? " dw-side-open" : ""}`}>
      <Rail
        projects={projects}
        active={
          view.screen === "questions" || view.screen === "agents"
            ? ""
            : currentProjectId
        }
        openFor={openFor}
        go={go}
        onNew={() => setView({ screen: "welcome" })}
      />
      <Sidebar
        project={current}
        view={view}
        cosName={cosName}
        go={go}
        onNewTeam={() => setNewTeamFor(current.id)}
        onToggleAutopilot={() => {
          updateProject(current.id, (p) => ({ ...p, autopilot: !p.autopilot }));
          setToast(
            current.autopilot
              ? `Autopilot off for ${current.name}. The crew finishes what it's on, then waits for you.`
              : `Autopilot on for ${current.name}. The ${cosName} keeps work moving.`,
          );
        }}
      />
      <button
        type="button"
        className="dw-menu"
        aria-label="Show the sidebar"
        onClick={() => setSideOpen((v) => !v)}
      >
        ☰
      </button>
      <div className="dw-scrim" onClick={() => setSideOpen(false)} />
      <main className="dw-main">
        {view.screen === "project" && (
          <ProjectHome
            project={current}
            projects={projects}
            questions={questions}
            cosName={cosName}
            nameOf={(w) => nameOf(w, current)}
            typing={typing === `${current.id}//`}
            onSend={(t) => send({ project: current.id }, t)}
            onUndo={(i) => {
              const what = current.decided[i].what;
              updateProject(current.id, (p) => ({
                ...p,
                decided: p.decided.filter((_, j) => j !== i),
              }));
              setToast(`Undone: ${what}. The crew has been told.`);
            }}
            go={go}
          />
        )}
        {view.screen === "mate" && (
          <MateView
            project={current}
            mate={current.mates.find((m) => m.id === view.mate)!}
            cosName={cosName}
            typing={typing === `${current.id}/${view.mate}/`}
            onSend={(t) => send({ project: current.id, mate: view.mate }, t)}
            go={go}
            onUndo={(i) => {
              updateProject(current.id, (p) => ({
                ...p,
                mates: p.mates.map((m) =>
                  m.id === view.mate
                    ? { ...m, decided: m.decided.filter((_, j) => j !== i) }
                    : m,
                ),
              }));
              setToast("Undone. The crew has been told.");
            }}
          />
        )}
        {view.screen === "team" && (
          <TeamView
            project={current}
            teamId={view.team}
            nameOf={(w) => nameOf(w, current)}
            typing={typing === `${current.id}//${view.team}`}
            onSend={(t) => send({ project: current.id, team: view.team }, t)}
            onAdd={(mateId) => {
              updateProject(current.id, (p) => ({
                ...p,
                teams: p.teams.map((t) =>
                  t.id === view.team && !t.members.includes(mateId)
                    ? { ...t, members: [...t.members, mateId] }
                    : t,
                ),
              }));
            }}
          />
        )}
        {view.screen === "place" && (
          <PlaceView project={current} placeId={view.place} />
        )}
        {view.screen === "settings" && (
          <SettingsView
            project={current}
            cosName={cosName}
            setCosName={setCosName}
            personality={personality}
            setPersonality={setPersonality}
            engine={engine}
            setEngine={setEngine}
            handsOn={handsOn}
            setHandsOn={setHandsOn}
            onToggleAutopilot={() =>
              updateProject(current.id, (p) => ({
                ...p,
                autopilot: !p.autopilot,
              }))
            }
          />
        )}
        {view.screen === "questions" && (
          <QuestionsView
            questions={questions}
            projects={projects}
            onAnswer={answer}
            go={go}
            onAllDone={() =>
              setToast(
                "Sent. Everything that was waiting on you is moving again.",
              )
            }
          />
        )}
        {view.screen === "agents" && (
          <AgentsView
            projects={projects}
            cosName={cosName}
            openFor={openFor}
            go={go}
          />
        )}
      </main>
      {newTeamFor && (
        <NewTeam
          project={projectOf(newTeamFor)}
          onClose={() => setNewTeamFor(null)}
          onCreate={(name, members) => {
            const id = `team-${Date.now()}`;
            updateProject(newTeamFor, (p) => ({
              ...p,
              teams: [
                ...p.teams,
                {
                  id,
                  name,
                  members: ["cos", ...members],
                  chat: [
                    {
                      from: "cos",
                      text: `Welcome to ${name}. Everyone here can see this chat. Say something to all of us, or @ one of us.`,
                    },
                  ],
                },
              ],
            }));
            setNewTeamFor(null);
            go({ to: "team", project: newTeamFor, team: id });
          }}
        />
      )}
      {toast && (
        <div className="dw-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

/* ---------- shell ---------- */

function Rail(props: {
  projects: Project[];
  active: string;
  openFor: (id: string) => number;
  go: (g: Go) => void;
  onNew?: () => void;
}) {
  return (
    <nav className="dw-rail" aria-label="Projects">
      <div className="dw-logo" aria-hidden="true">
        D
      </div>
      {props.projects.map((p) => {
        const n = props.openFor(p.id);
        return (
          <button
            key={p.id}
            type="button"
            className={`dw-rail-item${props.active === p.id ? " on" : ""}`}
            aria-current={props.active === p.id ? "page" : undefined}
            onClick={() => props.go({ to: "project", project: p.id })}
          >
            <span className="dw-ricon">{p.short}</span>
            <span className="dw-rname">{p.name}</span>
            {n > 0 && <span className="dw-badge">{n}</span>}
          </button>
        );
      })}
      {props.onNew && (
        <button
          type="button"
          className="dw-rail-item"
          aria-label="New project"
          onClick={props.onNew}
        >
          <span className="dw-ricon dashed">+</span>
        </button>
      )}
    </nav>
  );
}

function Avatar({
  who,
  color,
  letter,
  size = 26,
}: {
  who?: string;
  color: string;
  letter: string;
  size?: number;
}) {
  return (
    <span
      className="dw-av"
      style={{
        background: color,
        width: size,
        height: size,
        fontSize: size * 0.42,
      }}
      aria-hidden={who ? undefined : true}
      title={who}
    >
      {letter}
    </span>
  );
}

const DOT = {
  working: "#3FA7C9",
  needs: "#E5484D",
  idle: "transparent",
} as const;

function Sidebar(props: {
  project: Project;
  view: View;
  cosName: string;
  go: (g: Go) => void;
  onNewTeam: () => void;
  onToggleAutopilot: () => void;
}) {
  const { project: p, view, go } = props;
  const isHere = (screen: string, id?: string) =>
    view.screen === screen &&
    (id === undefined ||
      ("mate" in view && view.mate === id) ||
      ("team" in view && view.team === id) ||
      ("place" in view && view.place === id));
  return (
    <aside className="dw-side">
      <div className="dw-side-head">
        <div className="dw-side-title">{p.name}</div>
        <button
          type="button"
          className={`dw-chip${p.autopilot ? " on" : ""}`}
          onClick={props.onToggleAutopilot}
          title="Autopilot is a mode: on, the Chief of Staff keeps work moving without you"
        >
          Autopilot {p.autopilot ? "on" : "off"}
        </button>
      </div>
      <a
        className={isHere("project") ? "on" : ""}
        onClick={() => go({ to: "project", project: p.id })}
      >
        <Avatar color={CREW_COLORS.cos} letter="CS" />
        {props.cosName}
      </a>
      <div className="dw-lbl">First mates</div>
      {p.mates.map((m) => (
        <a
          key={m.id}
          className={isHere("mate", m.id) ? "on" : ""}
          onClick={() => go({ to: "mate", project: p.id, mate: m.id })}
        >
          <Avatar color={m.color} letter={m.letter} />
          {m.name}
          <span className="dw-dot" style={{ background: DOT[m.status] }} />
        </a>
      ))}
      <div className="dw-lbl">Teams</div>
      {p.teams.map((t) => (
        <a
          key={t.id}
          className={isHere("team", t.id) ? "on" : ""}
          onClick={() => go({ to: "team", project: p.id, team: t.id })}
        >
          <Avatar color="#2A2E34" letter="#" />
          {t.name}
        </a>
      ))}
      <a className="muted" onClick={props.onNewTeam}>
        + New team
      </a>
      {p.places.length > 0 && <div className="dw-lbl">Places</div>}
      {p.places.map((pl) => (
        <a
          key={pl.id}
          className={isHere("place", pl.id) ? "on" : ""}
          onClick={() => go({ to: "place", project: p.id, place: pl.id })}
        >
          {pl.name}
        </a>
      ))}
      <div className="dw-side-foot">
        <a
          className={view.screen === "agents" ? "on" : ""}
          onClick={() => go({ to: "agents" })}
        >
          Agents board
        </a>
        <a
          className={isHere("settings") ? "on" : ""}
          onClick={() => go({ to: "settings", project: p.id })}
        >
          Settings
        </a>
      </div>
    </aside>
  );
}

/* ---------- chat ---------- */

function Chat(props: {
  messages: Msg[];
  nameOf: (who: string) => string;
  colorOf: (who: string) => string;
  letterOf: (who: string) => string;
  typing: boolean;
  typingWho: string;
  placeholder: string;
  onSend: (text: string) => void;
  go?: (g: Go) => void;
  big?: boolean;
  showNames?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [props.messages.length, props.typing]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    props.onSend(text);
    setDraft("");
  };
  return (
    <div className={`dw-chat${props.big ? " big" : ""}`}>
      <div className="dw-msgs">
        {props.messages.map((m, i) =>
          m.from === "you" ? (
            <div key={i} className="dw-me">
              {m.text}
            </div>
          ) : (
            <div key={i} className="dw-them">
              <Avatar
                color={props.colorOf(m.from)}
                letter={props.letterOf(m.from)}
              />
              <div style={{ minWidth: 0 }}>
                {props.showNames && (
                  <div className="dw-who">{props.nameOf(m.from)}</div>
                )}
                <div className="dw-text">{m.text}</div>
                {m.card && (
                  <button
                    type="button"
                    className="dw-card-link"
                    onClick={() => m.card?.go && props.go?.(m.card.go)}
                  >
                    <strong>{m.card.title}</strong>
                    <span>{m.card.body}</span>
                  </button>
                )}
              </div>
            </div>
          ),
        )}
        {props.typing && (
          <div className="dw-them">
            <Avatar
              color={props.colorOf(props.typingWho)}
              letter={props.letterOf(props.typingWho)}
            />
            <div className="dw-typing" aria-label="Typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
        <div ref={end} />
      </div>
      <form className="dw-compose" onSubmit={submit}>
        <input
          aria-label={props.placeholder}
          placeholder={props.placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" aria-label="Send">
          ↑
        </button>
      </form>
    </div>
  );
}

/* ---------- project home (Home is one of these) ---------- */

function Card(props: {
  title: ReactNode;
  count?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  tone?: "red";
}) {
  return (
    <section className={`dw-card${props.tone === "red" ? " red" : ""}`}>
      <div className="dw-card-h">
        {props.title}
        {props.count !== undefined && (
          <span className="dw-count">{props.count}</span>
        )}
        {props.action && <span className="dw-card-act">{props.action}</span>}
      </div>
      {props.children}
    </section>
  );
}

function ProjectHome(props: {
  project: Project;
  projects: Project[];
  questions: Question[];
  cosName: string;
  nameOf: (w: string) => string;
  typing: boolean;
  onSend: (t: string) => void;
  onUndo: (i: number) => void;
  go: (g: Go) => void;
}) {
  const { project: p, go } = props;
  const isHome = p.id === HOME_ID;
  const mine = isHome
    ? props.questions
    : props.questions.filter((q) => q.project === p.id);
  const mateColor = (w: string) =>
    w === "cos"
      ? CREW_COLORS.cos
      : (p.mates.find((m) => m.id === w)?.color ?? "#888");
  const pages = p.places.find((x) => x.kind === "pages");
  const autos = p.places.find((x) => x.kind === "automations");
  const others = props.projects.filter((x) => x.id !== HOME_ID);
  return (
    <div className="dw-page">
      <div className="dw-hero">
        <div className="dw-hero-h">
          <Avatar color={CREW_COLORS.cos} letter="CS" size={30} />
          <div>
            <div className="dw-hero-name">{props.cosName}</div>
            <div className="dw-sub">
              {isHome
                ? "Runs everything for you, across all your projects"
                : `Captain of ${p.name} · ${p.blurb}`}
            </div>
          </div>
        </div>
        <Chat
          big
          messages={p.chat}
          nameOf={props.nameOf}
          colorOf={mateColor}
          letterOf={(w) => (w === "cos" ? "CS" : props.nameOf(w)[0])}
          typing={props.typing}
          typingWho="cos"
          placeholder={`Ask the ${props.cosName} anything, or hand over work`}
          onSend={props.onSend}
          go={go}
        />
      </div>

      <div className="dw-glance">
        <Card
          tone={mine.length ? "red" : undefined}
          title={mine.length ? "Needs you" : "Nothing needs you"}
          count={mine.length || undefined}
          action={
            mine.length ? (
              <a onClick={() => go({ to: "questions" })}>
                Answer {mine.length === 1 ? "it" : "them"}
              </a>
            ) : undefined
          }
        >
          {mine.length === 0 ? (
            <p className="dw-sub">
              All decisions are being made for you. Next batch of questions, if
              any, at 17:00.
            </p>
          ) : (
            mine.map((q) => (
              <div
                key={q.id}
                className="dw-row"
                onClick={() => go({ to: "questions" })}
              >
                <span className="dw-num">{mine.indexOf(q) + 1}</span>
                <span className="grow">{q.ask}</span>
                {isHome && (
                  <span className="dw-tag">
                    {props.projects.find((x) => x.id === q.project)?.name}
                  </span>
                )}
              </div>
            ))
          )}
        </Card>

        {isHome && (
          <Card title="Your projects" count={others.length}>
            {others.map((o) => (
              <div
                key={o.id}
                className="dw-row"
                onClick={() => go({ to: "project", project: o.id })}
              >
                <span className="dw-pico" style={{ background: o.color }}>
                  {o.short}
                </span>
                <span className="grow">
                  {o.name}
                  <span className="dw-sub">
                    {" "}
                    ·{" "}
                    {o.autopilot
                      ? `${o.building.length} being built`
                      : "resting, Autopilot off"}
                  </span>
                </span>
                {props.questions.some((q) => q.project === o.id) && (
                  <span className="dw-pill red">Needs you</span>
                )}
              </div>
            ))}
          </Card>
        )}

        <Card
          title="Being built"
          count={p.building.length}
          action={<a onClick={() => go({ to: "agents" })}>Agents board</a>}
        >
          {p.building.length === 0 ? (
            <p className="dw-sub">Nothing right now.</p>
          ) : (
            p.building.slice(0, 4).map((b, i) => (
              <div key={i} className="dw-row">
                <span className="dw-spin" />
                <span className="grow">{b.what}</span>
                <span className="dw-sub">{b.who}</span>
              </div>
            ))
          )}
        </Card>

        <Card
          title="Decided for you"
          count={`${p.decidedToday + p.decided.filter((d) => d.when === "now").length} today`}
        >
          {p.decided.length === 0 ? (
            <p className="dw-sub">No decisions yet today.</p>
          ) : (
            p.decided.slice(0, 4).map((d, i) => (
              <div key={i} className="dw-row">
                <span className="grow">
                  {d.what}
                  <span className="dw-sub"> · {d.who}</span>
                </span>
                {d.who !== "You" && (
                  <button
                    type="button"
                    className="dw-link"
                    onClick={() => props.onUndo(i)}
                  >
                    Undo
                  </button>
                )}
              </div>
            ))
          )}
        </Card>

        {pages && (
          <Card
            title="Pinned pages"
            count={pages.items.length}
            action={
              <a
                onClick={() =>
                  go({ to: "place", project: p.id, place: pages.id })
                }
              >
                All pages
              </a>
            }
          >
            <div className="dw-tiles">
              {pages.items.map((it) => (
                <button
                  key={it.title}
                  type="button"
                  className="dw-tile"
                  onClick={() =>
                    go({ to: "place", project: p.id, place: pages.id })
                  }
                >
                  <span className="dw-tile-img" />
                  <strong>{it.title}</strong>
                  <span className="dw-sub">{it.sub}</span>
                </button>
              ))}
            </div>
          </Card>
        )}

        {autos && (
          <Card
            title="Automations"
            count={autos.items.length}
            action={
              <a
                onClick={() =>
                  go({ to: "place", project: p.id, place: autos.id })
                }
              >
                Manage
              </a>
            }
          >
            {autos.items.map((it) => (
              <div key={it.title} className="dw-row">
                <span className="dw-clock">◷</span>
                <span className="grow">{it.title}</span>
                <span className="dw-sub">{it.sub}</span>
              </div>
            ))}
          </Card>
        )}

        {p.done.length > 0 && (
          <Card title="Done today" count={p.done.length}>
            {p.done.map((d, i) => (
              <div key={i} className="dw-row">
                <span className="dw-tick">✓</span>
                <span className="grow">{d.what}</span>
                <span className="dw-sub">{d.when}</span>
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}

/* ---------- first mate ---------- */

function MateView(props: {
  project: Project;
  mate: Mate;
  cosName: string;
  typing: boolean;
  onSend: (t: string) => void;
  go: (g: Go) => void;
  onUndo: (i: number) => void;
}) {
  const { mate: m } = props;
  return (
    <div className="dw-page narrow">
      <section className="dw-card flush">
        <div className="dw-chat-head">
          <Avatar color={m.color} letter={m.letter} />
          <strong>{m.name}</strong>
          <span className="dw-sub">
            first mate · reports to the {props.cosName}
          </span>
          <span className="dw-tag right">{props.cosName} sees this chat</span>
        </div>
        <Chat
          messages={
            m.chat.length
              ? m.chat
              : [
                  {
                    from: m.id,
                    text: `Hi, I lead ${m.name} on ${props.project.name}. Ask me anything, or hand me work directly. The ${props.cosName} sees what we agree.`,
                  },
                ]
          }
          nameOf={() => m.name}
          colorOf={() => m.color}
          letterOf={() => m.letter}
          typing={props.typing}
          typingWho={m.id}
          placeholder={`Message ${m.name}`}
          onSend={props.onSend}
        />
      </section>
      <Card
        title={
          <>
            <span className="dw-live" />
            Crew working
          </>
        }
        count={m.crew.length}
        action={
          <a onClick={() => props.go({ to: "agents" })}>See on Agents board</a>
        }
      >
        {m.crew.length === 0 ? (
          <p className="dw-sub">No crew out right now.</p>
        ) : (
          m.crew.map((c, i) => (
            <div key={i} className="dw-row">
              <span className="grow">{c.task}</span>
              <span
                className="dw-bar"
                role="img"
                aria-label={`About ${c.pct} percent done`}
              >
                <span style={{ width: `${c.pct}%` }} />
              </span>
              <span className="dw-sub w52">
                {c.mins ? `${c.mins} min` : "just now"}
              </span>
            </div>
          ))
        )}
      </Card>
      <Card title={`Decided by ${m.name}`} count={`${m.decided.length} today`}>
        {m.decided.length === 0 ? (
          <p className="dw-sub">Nothing yet today.</p>
        ) : (
          m.decided.map((d, i) => (
            <div key={i} className="dw-row">
              <span className="grow">
                {d.what}
                {d.why && <span className="dw-sub"> · {d.why}</span>}
              </span>
              <button
                type="button"
                className="dw-link"
                onClick={() => props.onUndo(i)}
              >
                Undo
              </button>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

/* ---------- team ---------- */

function TeamView(props: {
  project: Project;
  teamId: string;
  nameOf: (w: string) => string;
  typing: boolean;
  onSend: (t: string) => void;
  onAdd: (mate: string) => void;
}) {
  const { project: p } = props;
  const team = p.teams.find((t) => t.id === props.teamId)!;
  const [adding, setAdding] = useState(false);
  const colorOf = (w: string) =>
    w === "cos"
      ? CREW_COLORS.cos
      : (p.mates.find((m) => m.id === w)?.color ?? "#888");
  const letterOf = (w: string) => (w === "cos" ? "CS" : props.nameOf(w)[0]);
  const outside = p.mates.filter((m) => !team.members.includes(m.id));
  return (
    <div className="dw-page narrow">
      <section className="dw-card flush">
        <div className="dw-chat-head">
          <strong># {team.name}</strong>
          <span className="dw-stack">
            {team.members.map((w) => (
              <Avatar key={w} color={colorOf(w)} letter={letterOf(w)} />
            ))}
          </span>
          <span className="dw-sub">
            {team.members.map(props.nameOf).join(", ")}
          </span>
          <span className="right dw-pop">
            <button
              type="button"
              className="dw-btn"
              onClick={() => setAdding((v) => !v)}
            >
              Add someone
            </button>
            {adding && (
              <span className="dw-menu-pop">
                {outside.length === 0 && (
                  <span className="dw-sub">Everyone is already here.</span>
                )}
                {outside.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      props.onAdd(m.id);
                      setAdding(false);
                    }}
                  >
                    <Avatar color={m.color} letter={m.letter} size={20} />{" "}
                    {m.name}
                  </button>
                ))}
              </span>
            )}
          </span>
        </div>
        <Chat
          big
          showNames
          messages={team.chat}
          nameOf={props.nameOf}
          colorOf={colorOf}
          letterOf={letterOf}
          typing={props.typing}
          typingWho="cos"
          placeholder="Message everyone, or @ one of them"
          onSend={props.onSend}
        />
      </section>
    </div>
  );
}

function NewTeam(props: {
  project: Project;
  onClose: () => void;
  onCreate: (name: string, members: string[]) => void;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <div
      className="dw-modal"
      role="dialog"
      aria-label="New team"
      onClick={props.onClose}
    >
      <form
        className="dw-card dw-modal-box"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) props.onCreate(name.trim(), picked);
        }}
      >
        <h2>New team</h2>
        <p className="dw-sub">
          A group chat with the {props.project.name} first mates you pick. The
          Chief of Staff is always in it. Teams are optional.
        </p>
        <input
          autoFocus
          className="dw-input"
          placeholder="Name it, like Launch room"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="dw-checks">
          {props.project.mates.map((m) => (
            <label key={m.id}>
              <input
                type="checkbox"
                checked={picked.includes(m.id)}
                onChange={() =>
                  setPicked((x) =>
                    x.includes(m.id)
                      ? x.filter((y) => y !== m.id)
                      : [...x, m.id],
                  )
                }
              />
              <Avatar color={m.color} letter={m.letter} size={22} /> {m.name}
            </label>
          ))}
        </div>
        <div className="dw-modal-act">
          <button type="button" className="dw-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="dw-btn primary"
            disabled={!name.trim()}
          >
            Create team
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------- places ---------- */

function PlaceView({
  project,
  placeId,
}: {
  project: Project;
  placeId: string;
}) {
  const place = project.places.find((x) => x.id === placeId)!;
  const [items, setItems] = useState(place.items);
  useEffect(() => {
    setItems(place.items);
  }, [place]);
  return (
    <div className="dw-page narrow">
      <h1 className="dw-h1">{place.name}</h1>
      <p className="dw-sub">
        {place.kind === "pages" &&
          "Pages your crew made for you: plans, previews and reports. Pin the ones you want on the project home."}
        {place.kind === "notes" &&
          "Notes you or the crew kept. The Chief of Staff reads these before it decides."}
        {place.kind === "automations" &&
          "Things that happen by themselves. Ask the Chief of Staff in chat to add one, like “every Monday, send me signups”."}
        {place.kind === "list" && "Kept up to date by the crew."}
      </p>
      <section className={place.kind === "pages" ? "dw-tiles big" : "dw-card"}>
        {items.map((it, i) =>
          place.kind === "pages" ? (
            <div key={it.title} className="dw-tile">
              <span className="dw-tile-img tall" />
              <strong>{it.title}</strong>
              <span className="dw-sub">{it.sub}</span>
            </div>
          ) : (
            <div key={it.title} className="dw-row">
              <span className="grow">{it.title}</span>
              <span className="dw-sub">{it.sub}</span>
              {place.kind === "automations" && (
                <button
                  type="button"
                  className="dw-link"
                  onClick={() =>
                    setItems((x) =>
                      x.map((y, j) =>
                        j === i
                          ? {
                              ...y,
                              sub: y.sub.startsWith("Paused")
                                ? y.sub.replace("Paused · ", "")
                                : `Paused · ${y.sub}`,
                            }
                          : y,
                      ),
                    )
                  }
                >
                  {it.sub.startsWith("Paused") ? "Resume" : "Pause"}
                </button>
              )}
            </div>
          ),
        )}
      </section>
    </div>
  );
}

/* ---------- questions ---------- */

function QuestionsView(props: {
  questions: Question[];
  projects: Project[];
  onAnswer: (q: Question, i: number) => void;
  go: (g: Go) => void;
  onAllDone: () => void;
}) {
  const [chosen, setChosen] = useState<Record<string, number>>(() =>
    Object.fromEntries(props.questions.map((q) => [q.id, q.pick])),
  );
  const line = useMemo(
    () =>
      props.questions
        .map(
          (q, i) =>
            `${i + 1}${String.fromCharCode(97 + (chosen[q.id] ?? q.pick))}`,
        )
        .join(" "),
    [props.questions, chosen],
  );
  const [typed, setTyped] = useState<string | null>(null);
  const shown = typed ?? line;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const picks = new Map<number, number>();
    for (const m of shown.toLowerCase().matchAll(/(\d+)\s*([a-z])/g))
      picks.set(Number(m[1]) - 1, m[2].charCodeAt(0) - 97);
    const qs = [...props.questions];
    qs.forEach((q, i) => {
      const o = picks.get(i);
      if (o !== undefined && o >= 0 && o < q.options.length)
        props.onAnswer(q, o);
    });
    setTyped(null);
    props.onAllDone();
    props.go({ to: "project", project: HOME_ID });
  };
  if (props.questions.length === 0)
    return (
      <div className="dw-page narrow center">
        <div className="dw-done-big">✓</div>
        <h1 className="dw-h1">Nothing needs you</h1>
        <p className="dw-sub">
          Everything else is being decided for you. Next batch at 17:00, if
          anything comes up.
        </p>
        <button
          type="button"
          className="dw-btn primary"
          onClick={() => props.go({ to: "project", project: HOME_ID })}
        >
          Back to Home
        </button>
      </div>
    );
  return (
    <div className="dw-page narrow">
      <a
        className="dw-back"
        onClick={() => props.go({ to: "project", project: HOME_ID })}
      >
        ← Home
      </a>
      <div>
        <h1 className="dw-h1">
          {props.questions.length} question
          {props.questions.length === 1 ? "" : "s"} for you
        </h1>
        <p className="dw-sub">
          Out of 340 decisions since this morning. Tap an answer, or type them
          all at once below. My pick is marked.
        </p>
      </div>
      {props.questions.map((q, i) => (
        <section
          key={q.id}
          className="dw-card"
          aria-label={`Question ${i + 1}`}
        >
          <div className="dw-q">
            <span className="dw-num">{i + 1}</span>
            <div className="grow">
              <span className="dw-tag">
                {props.projects.find((p) => p.id === q.project)?.name}
              </span>
              <div className="dw-q-ask">{q.ask}</div>
              <div className="dw-sub">{q.why}</div>
              <div className="dw-opts">
                {q.options.map((o, j) => (
                  <button
                    key={o}
                    type="button"
                    className={`dw-opt${(chosen[q.id] ?? q.pick) === j ? " on" : ""}`}
                    onClick={() => {
                      setChosen((c) => ({ ...c, [q.id]: j }));
                      setTyped(null);
                    }}
                    onDoubleClick={() => props.onAnswer(q, j)}
                  >
                    <span className="dw-letter">
                      {String.fromCharCode(97 + j)}
                    </span>
                    {o}
                    {q.pick === j && <span className="dw-rec">my pick</span>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>
      ))}
      <form className="dw-card dw-quick" onSubmit={submit}>
        <input
          aria-label="Answer in one line"
          value={shown}
          onChange={(e) => setTyped(e.target.value)}
        />
        <button type="submit" className="dw-btn primary">
          Send answers
        </button>
      </form>
      <p className="dw-sub center">
        Next batch at 17:00. Change the times in Settings.
      </p>
    </div>
  );
}

/* ---------- agents board ---------- */

function AgentsView(props: {
  projects: Project[];
  cosName: string;
  openFor: (id: string) => number;
  go: (g: Go) => void;
}) {
  const [filter, setFilter] = useState<"all" | "needs" | "working" | "done">(
    "all",
  );
  const working = props.projects.reduce(
    (n, p) => n + p.mates.reduce((k, m) => k + m.crew.length, 0),
    0,
  );
  const needs = props.projects.filter(
    (p) => p.id !== HOME_ID && props.openFor(p.id) > 0,
  ).length;
  const done = props.projects.reduce((n, p) => n + p.done.length, 0);
  const shown = props.projects.filter((p) => {
    if (filter === "needs") return p.id !== HOME_ID && props.openFor(p.id) > 0;
    if (filter === "working") return p.mates.some((m) => m.crew.length);
    if (filter === "done") return p.done.length > 0;
    return (
      p.mates.some((m) => m.crew.length) ||
      p.done.length > 0 ||
      (p.id !== HOME_ID && props.openFor(p.id) > 0)
    );
  });
  const st = (s: "working" | "needs" | "idle" | "done") => (
    <span className={`dw-st ${s}`}>
      {
        { working: "Working", needs: "Needs you", idle: "Idle", done: "Done" }[
          s
        ]
      }
    </span>
  );
  return (
    <div className="dw-page wide">
      <div className="dw-toolbar">
        <h1 className="dw-h1">Agents board</h1>
        {(
          [
            ["all", "All projects"],
            ["needs", `Needs you ${needs}`],
            ["working", `Working ${working}`],
            ["done", `Done today ${done}`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`dw-filter${filter === k ? " on" : ""}`}
            onClick={() => setFilter(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="dw-sub">
        Who is doing what, down to each crew member. For tracking only: you
        never need to come here to keep work moving.
      </p>
      {shown.map((p) => {
        const projNeeds = p.id !== HOME_ID && props.openFor(p.id) > 0;
        return (
          <section key={p.id} className="dw-card flush" aria-label={p.name}>
            <div
              className="dw-tr head"
              onClick={() => props.go({ to: "project", project: p.id })}
            >
              <Avatar color={CREW_COLORS.cos} letter="CS" size={24} />
              <span className="grow strong">
                {props.cosName} · {p.name}
              </span>
              {st(
                projNeeds
                  ? "needs"
                  : p.mates.some((m) => m.crew.length)
                    ? "working"
                    : "idle",
              )}
            </div>
            {p.mates
              .filter((m) => filter !== "needs" || m.status === "needs")
              .map((m) => (
                <div key={m.id}>
                  <div
                    className="dw-tr l1"
                    onClick={() =>
                      props.go({ to: "mate", project: p.id, mate: m.id })
                    }
                  >
                    <Avatar color={m.color} letter={m.letter} size={24} />
                    <span className="grow">{m.name}</span>
                    {st(
                      m.status === "needs" && projNeeds
                        ? "needs"
                        : m.crew.length
                          ? "working"
                          : "idle",
                    )}
                  </div>
                  {filter !== "done" &&
                    m.crew.map((c, i) => (
                      <div key={i} className="dw-tr l2">
                        <span className="grow">{c.task}</span>
                        {st("working")}
                        <span className="dw-t">
                          {c.mins ? `${c.mins} min` : "now"}
                        </span>
                      </div>
                    ))}
                  {(filter === "done" || filter === "all") &&
                    p.done
                      .filter((d) => d.who === m.name)
                      .map((d, i) => (
                        <div key={`d${i}`} className="dw-tr l2">
                          <span className="grow">{d.what}</span>
                          {st("done")}
                          <span className="dw-t">{d.when}</span>
                        </div>
                      ))}
                </div>
              ))}
          </section>
        );
      })}
    </div>
  );
}

/* ---------- settings ---------- */

function Toggle({
  on,
  onClick,
  label,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`dw-switch${on ? " on" : ""}`}
      onClick={onClick}
    />
  );
}

function SettingsView(props: {
  project: Project;
  cosName: string;
  setCosName: (s: string) => void;
  personality: string;
  setPersonality: (s: string) => void;
  engine: string;
  setEngine: (s: string) => void;
  handsOn: number;
  setHandsOn: (n: number) => void;
  onToggleAutopilot: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [adv, setAdv] = useState({
    git: true,
    worktrees: true,
    diffs: false,
    board: true,
  });
  const [limit, setLimit] = useState(20);
  const p = props.project;
  return (
    <div className="dw-page narrow">
      <h1 className="dw-h1">Settings</h1>
      <Card title={`${p.name}`}>
        <div className="dw-set">
          <div className="grow">
            <strong>Autopilot</strong>
            <div className="dw-sub">
              On: the {props.cosName} keeps {p.name} moving and only asks you
              the big calls. Off: the crew finishes what it's on, then waits for
              you. Work never moves to another project.
            </div>
          </div>
          <Toggle
            on={p.autopilot}
            onClick={props.onToggleAutopilot}
            label="Autopilot"
          />
        </div>
        <div className="dw-set">
          <div className="grow">
            <strong>Spend without asking</strong>
            <div className="dw-sub">
              Anything over this a month comes to you as a question.
            </div>
          </div>
          <select
            className="dw-select"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            {[0, 20, 50, 100].map((n) => (
              <option key={n} value={n}>
                ${n} a month
              </option>
            ))}
          </select>
        </div>
      </Card>
      <Card title="Your Chief of Staff">
        <div className="dw-set">
          <div className="grow">
            <strong>Name</strong>
          </div>
          <input
            className="dw-input small"
            value={props.cosName}
            onChange={(e) =>
              props.setCosName(e.target.value || "Chief of Staff")
            }
          />
        </div>
        <div className="dw-set">
          <div className="grow">
            <strong>Personality</strong>
            <div className="dw-sub">
              It also learns from how you talk to it.
            </div>
          </div>
          <select
            className="dw-select"
            value={props.personality}
            onChange={(e) => props.setPersonality(e.target.value)}
          >
            {PERSONALITIES.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>
        <div className="dw-set">
          <div className="grow">
            <strong>Engine</strong>
            <div className="dw-sub">
              What it runs on. First mates use the same unless you change
              theirs.
            </div>
          </div>
          <select
            className="dw-select"
            value={props.engine}
            onChange={(e) => props.setEngine(e.target.value)}
          >
            {ENGINES.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>
        <div className="dw-set col">
          <strong>How hands-on</strong>
          <div className="dw-seg">
            {HANDS_ON.map((h, i) => (
              <button
                key={h}
                type="button"
                className={props.handsOn === i ? "on" : ""}
                onClick={() => props.setHandsOn(i)}
              >
                {h}
              </button>
            ))}
          </div>
        </div>
        <div className="dw-set">
          <div className="grow">
            <strong>Question times</strong>
            <div className="dw-sub">
              Questions wait and come together, unless something is urgent.
            </div>
          </div>
          <span className="dw-tag">12:00 and 17:00</span>
        </div>
      </Card>
      <section className="dw-card">
        <button
          type="button"
          className="dw-adv"
          aria-expanded={advanced}
          onClick={() => setAdvanced((v) => !v)}
        >
          Advanced <span className="dw-sub">for developers</span>
          <span className="right">{advanced ? "▴" : "▾"}</span>
        </button>
        {advanced && (
          <>
            {(
              [
                [
                  "git",
                  "Use Git for this project",
                  "Save every change as a commit the crew can undo.",
                ],
                [
                  "worktrees",
                  "Separate copies for each crew member",
                  "Git worktrees, so crew don't step on each other.",
                ],
                [
                  "diffs",
                  "Show code changes in chats",
                  "Diffs under each first mate's replies.",
                ],
                [
                  "board",
                  "Agents board",
                  "Show the Agents board in the sidebar.",
                ],
              ] as const
            ).map(([k, t, d]) => (
              <div key={k} className="dw-set">
                <div className="grow">
                  <strong>{t}</strong>
                  <div className="dw-sub">{d}</div>
                </div>
                <Toggle
                  on={adv[k]}
                  onClick={() => setAdv((a) => ({ ...a, [k]: !a[k] }))}
                  label={t}
                />
              </div>
            ))}
            <div className="dw-set">
              <div className="grow">
                <strong>Folder on disk</strong>
              </div>
              <span className="dw-tag mono">~/Projects/{p.id}</span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/* ---------- first open ---------- */

function Welcome(props: {
  cosName: string;
  engine: string;
  handsOn: number;
  onPick: (i: number) => void;
  onSay: (t: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <main className="dw-main dw-welcome">
      <div className="dw-welcome-box">
        <div className="dw-welcome-top">
          <div className="dw-logo big" aria-hidden="true">
            D
          </div>
          <h1 className="dw-h1">Welcome aboard</h1>
        </div>
        <div className="dw-them">
          <Avatar color={CREW_COLORS.cos} letter="CS" size={30} />
          <div className="dw-text">
            Hi, I'm your {props.cosName}. I run things for you: I hand work to
            the right people, keep it moving, and only ask you what really needs
            you. First, how hands-on do you want to be?
          </div>
        </div>
        <div className="dw-opts indent">
          {HANDS_ON.map((h, i) => (
            <button
              key={h}
              type="button"
              className={`dw-opt${i === 1 ? " on" : ""}`}
              onClick={() => props.onPick(i)}
            >
              <span className="dw-letter">{String.fromCharCode(97 + i)}</span>
              {h}
              {i === 1 && <span className="dw-rec">most people pick this</span>}
            </button>
          ))}
        </div>
        <form
          className="dw-compose"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) props.onSay(draft.trim());
          }}
        >
          <input
            aria-label="Message the Chief of Staff"
            placeholder="Or tell me what you're working on"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" aria-label="Send">
            ↑
          </button>
        </form>
        <p className="dw-sub center">
          Running on {props.engine}. You can rename me, change my personality or
          my engine any time.
        </p>
      </div>
    </main>
  );
}
