// Home, wired to the chief's chat, the needs list, running workers and what finished today.
// A late load is dropped. A failed load keeps the last one. Home does not file tasks.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readPage, type ActivityEntry } from "../../activity/model/activity";
import { useDelegationRows } from "../../monos/model/delegationStore";
import type { Delegation } from "../../monos/model/delegations";
import { builderHold, spendHold, useWorkerPoolVersion } from "../../monos/model/workerPool";
import { spendSnapshot, subscribeSpend } from "../../usage/model/spendGate";
import { listMonos, monoLook } from "../../monos/model/mono";
import { PixelMascot } from "../../projects/ui/PixelMascot";
import { useHubDataVersion, hubData } from "../../hub/model/hubData";
import { LOCAL_HUB_CHANGED } from "../../hub/model/localHub/localTransport";
import { PanelFrame } from "../../panels/ui/PanelTabs";
import { useNeedsYou } from "../../needs/model/needsLive";
import { workingCount } from "../../needs/model/needsYou";
import { localDay, readLines, type WorkLogLine } from "../../workLog/model/workLog";
import { hideSection, pinPanel, showSection, unpin, withCardOrder } from "../model/arrangement";
import { addChiefOfStaff, chiefScopeLine, openChiefChat, pickChief } from "../model/chief";
import { openProjectChief } from "../../hub/ui/HubTopNav";
import { needActions } from "../model/needActions";
import { needTarget } from "../model/needTarget";
import { openNeed } from "../../needs/model/needContext";

export { needTarget };
import { homeDateLabel } from "../model/dateLabel";
import { doneToday, projectTag } from "../model/doneToday";
import {
  answerHomeQuestion,
  ensureHomeChief,
  homeChiefVersion,
  readHomeChiefSession,
  sendHomeTurn,
  subscribeHomeChief,
} from "../model/homeChief";
import { LateHomeLoad, createHomeLoader, mergeHomeLoad, realHomeSource, type HomeSnapshot } from "../model/load";
import { builderHoldLine, namesFor, type HomeProject } from "../model/lines";
import { needsRank, needsShown } from "../model/needsShown";
import { openFromHome, targetFor, type HomeOpenTarget } from "../model/opener";
import { HOME_DOC_KEY, changeHome, type HomeDoc } from "../model/store";
import { workingLines } from "../model/workingNow";
import { HOME_HEADER_BUTTON, HomeScreen, type HomeChief, type HomeDone, type HomeExtraSection, type HomeNeed, type HomeWork } from "./HomeScreen";
import { pinnedPages, requestOpenPage, usePagesVersion } from "../../pages/model/pages";
import { automationScheduleLabel, listAutomations, peekAutomations, type Automation } from "../../automations/model/automations";
import { projectAutopilotOn, setProjectAutopilot, useProjectAutopilotVersion } from "../model/projectAutopilot";
import { keepListening } from "./listenRetry";

const TASKS_CHANGED = "tasks://changed";
const RETRY_MS = 2000;

function labelFor(projects: readonly HomeProject[]): (projectId: string) => string | undefined {
  const name = namesFor(projects);
  return (projectId: string) => {
    if (!projectId.trim()) return undefined;
    return projectTag(projectId, (id) => {
      const named = name(id);
      return named === id ? undefined : named;
    });
  };
}

/** Opens a Places view (Pages, Notes, Automations) over Home; App.tsx listens. */
function openPlace(place: "pages" | "notes" | "automations"): void {
  window.dispatchEvent(new CustomEvent("monocode:home-open", { detail: place }));
}

/** Autopilot as the project's mode (Dropwave): one switch beside the title. */
function AutopilotSwitch({ projectId, name }: { projectId?: string; name: string }) {
  useProjectAutopilotVersion();
  const on = projectAutopilotOn(projectId);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-home-autopilot={on ? "on" : "off"}
      title={on
        ? `Autopilot is on: the Chief of Staff keeps ${name} moving and only asks you the big calls.`
        : `Autopilot is off: work on ${name} waits for you.`}
      onClick={() => void setProjectAutopilot(projectId, !on)}
      className={HOME_HEADER_BUTTON}
    >
      <span className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-content/20"}`}>
        <span className={`absolute top-0.5 size-3 rounded-full bg-white transition-[left] ${on ? "left-3.5" : "left-0.5"}`} />
      </span>
      Autopilot {on ? "on" : "off"}
    </button>
  );
}

/**
 * Home, or one project's home (Dropwave, 11 Nov): the Chief of Staff's box on top as a starting point (a message opens
 * the full chat), then only this project's Needs you, Working now, Done today, pinned pages and automations.
 */
export function HomeView({ projectId }: { projectId?: string } = {}) {
  usePagesVersion();
  const [automations, setAutomations] = useState<Automation[]>(() => peekAutomations() ?? []);
  useEffect(() => {
    let stopped = false;
    void listAutomations().then((list) => {
      // A list that didn't come back as one (a test page's stand-in answers nothing) leaves the card empty, not Home broken.
      if (!stopped) setAutomations(Array.isArray(list) ? list : []);
    }).catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, []);
  const source = useMemo(() => realHomeSource(), []);
  const loader = useRef(createHomeLoader(source));
  const token = useRef(0);
  const snapRef = useRef<HomeSnapshot | null>(null);
  const [snap, setSnap] = useState<HomeSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [roster, setRoster] = useState(0);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [work, setWork] = useState<WorkLogLine[]>([]);
  const chiefRev = useSyncExternalStore(subscribeHomeChief, homeChiefVersion, homeChiefVersion);
  useHubDataVersion();
  useWorkerPoolVersion();
  const delegations = useDelegationRows();
  const needs = useNeedsYou();
  // WP-176: a spend limit change clears or shows the pause without waiting for the next queue tick.
  useSyncExternalStore(subscribeSpend, () => spendSnapshot().book.revision, () => 0);
  const projectKey = hubData().listProjects().map((project) => `${project.id}\0${project.name}\0${project.folder ?? ""}`).join("\n");

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let unlistenTasks: (() => void) | undefined;
    let unlistenHub: (() => void) | undefined;
    let taskTimer = 0;
    let hubTimer = 0;
    const run = () => {
      window.clearTimeout(timer);
      const mine = ++token.current;
      loader.current.invalidate();
      void loader.current.load().then((next) => {
        if (stopped || mine !== token.current) return;
        const planned = mergeHomeLoad(snapRef.current, next);
        snapRef.current = planned.snap;
        setSnap(planned.snap);
        setFailed(planned.retry);
        if (planned.retry) timer = window.setTimeout(run, RETRY_MS);
      }).catch((error: unknown) => {
        if (stopped || mine !== token.current || error instanceof LateHomeLoad) return;
        setFailed(true);
        timer = window.setTimeout(run, RETRY_MS);
      });
    };
    run();
    const later = (slot: "task" | "hub", fn: () => void, ms: number) => {
      const id = window.setTimeout(fn, ms);
      if (slot === "task") taskTimer = id;
      else hubTimer = id;
      return id;
    };
    keepListening(
      () => listen(TASKS_CHANGED, () => {
        if (!stopped) run();
      }).then((stop) => {
        if (stopped) {
          stop();
          return () => undefined;
        }
        unlistenTasks = stop;
        return stop;
      }),
      { stopped: () => stopped, retryMs: RETRY_MS, later: (fn, ms) => later("task", fn, ms) },
    );
    keepListening(
      () => listen<{ key?: unknown }>(LOCAL_HUB_CHANGED, (event) => {
        if (!stopped && event.payload?.key === HOME_DOC_KEY) run();
      }).then((stop) => {
        if (stopped) {
          stop();
          return () => undefined;
        }
        unlistenHub = stop;
        return stop;
      }),
      { stopped: () => stopped, retryMs: RETRY_MS, later: (fn, ms) => later("hub", fn, ms) },
    );
    return () => {
      stopped = true;
      token.current += 1;
      window.clearTimeout(timer);
      window.clearTimeout(taskTimer);
      window.clearTimeout(hubTimer);
      unlistenTasks?.();
      unlistenHub?.();
    };
  }, [projectKey, source]);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let mine = 0;
    const load = () => {
      const ticket = ++mine;
      const day = localDay(new Date());
      void invoke("activity_list", { query: {} }).then((raw) => {
        if (stopped || ticket !== mine) return;
        setActivity(readPage(raw).entries);
      }).catch(() => {
        if (stopped || ticket !== mine) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(load, RETRY_MS);
      });
      void invoke("work_log_read", { day }).then((raw) => {
        if (stopped || ticket !== mine) return;
        setWork(readLines(raw));
      }).catch(() => {
        if (stopped || ticket !== mine) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(load, RETRY_MS);
      });
    };
    load();
    return () => {
      stopped = true;
      mine += 1;
      window.clearTimeout(timer);
    };
  }, []);

  const chiefMono = pickChief(listMonos());
  void roster;

  useEffect(() => {
    if (!chiefMono) return undefined;
    const monoId = chiefMono.id;
    let stopped = false;
    let timer = 0;
    const run = () => {
      void ensureHomeChief(monoId).then((id) => {
        if (stopped) return;
        if (id) {
          setSessionId(id);
          return;
        }
        timer = window.setTimeout(run, RETRY_MS);
      });
    };
    run();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [chiefMono?.id]);

  async function update(fn: (doc: HomeDoc) => HomeDoc) {
    const mine = ++token.current;
    const written = await changeHome(source.disk, source.storage, fn);
    if (!written || mine !== token.current) return;
    setSnap((prev) => {
      const next = prev
        ? {
            ...prev,
            arrangement: written.doc.arrangement,
            chats: written.doc.recent,
            rev: written.rev,
            summaryOff: written.doc.dailySummary === false,
            storeUnavailable: false,
          }
        : prev;
      snapRef.current = next;
      return next;
    });
  }

  const projects = snap?.projects ?? [];
  // On a project's home every row is this project's, so rows carry no project tag.
  const tagFor = labelFor(projects);
  const label = (id: string) => (projectId ? undefined : tagFor(id));
  const now = new Date();
  const session = sessionId ? readHomeChiefSession(sessionId) : undefined;
  void chiefRev;
  const pending = session?.pendingQuestion;
  const question = pending?.questions[0];
  const hold = builderHold();
  const spend = spendHold();
  const builderLines = [
    ...(hold ? [builderHoldLine(hold)] : []),
    ...(spend ? [builderHoldLine(spend)] : []),
  ];
  const scoped = hubData().listProjects().find((p) => p.id === projectId);
  const inScope = (id: string | null | undefined) => !scoped || id === scoped.id;
  const mine = needs.filter((item) => inScope(item.projectId));
  const shown = needsShown(mine);
  const totalNeeds = mine.length;
  const lines = workingLines(delegations.filter((row) => inScope(row.project)).map((row: Delegation) => ({
    id: row.id,
    project: row.project,
    title: row.title,
    goal: row.goal,
    state: row.state,
    createdAt: row.createdAt,
  })));
  const running = workingCount(scoped?.id);
  const finished = doneToday({
    activity,
    work,
    delegations: delegations.map((row) => ({
      id: row.id,
      state: row.state,
      delivery: row.delivery,
      settledAt: row.settledAt,
      title: row.title,
      goal: row.goal,
      project: row.project,
      childSession: row.childSession,
    })),
    now,
    label,
  }).filter((line) => inScope(line.projectId));

  const chiefLook = chiefMono ? monoLook(chiefMono) : { mascot: "", color: "" };
  const chief: HomeChief = chiefMono
    ? {
        missing: false,
        name: (chiefMono.name ?? "").trim() || "Chief of Staff",
        scope: scoped ? `runs ${scoped.name} for you` : chiefScopeLine(chiefMono, hubData().listProjects().length),
        placeholder: scoped ? `Ask anything about ${scoped.name}, or hand over work` : undefined,
        // Dropwave (Ash, 11 Nov): the box only starts a conversation, on Home and on a project's home. The conversation
        // itself, and anything the Chief of Staff asks, is in its chat (and under Needs you).
        options: [],
        avatar: <PixelMascot name={chiefLook.mascot} color={chiefLook.color} status="idle" className="size-14 shrink-0" />,
        starters: scoped
          ? [`Where are we on ${scoped.name}?`, "What is blocked?", "What did you decide for me?"]
          : ["What needs me today?", "Where is everything at?", "What did you decide for me?"],
        onAdd: () => undefined,
        onOpenChat: () => (scoped ? void openProjectChief(scoped.id) : openChiefChat(chiefMono.id)),
        onOption: (optionId) => {
          if (!sessionId || !pending || !question) return;
          answerHomeQuestion(sessionId, pending.requestId, {
            kind: "answered",
            answers: { [question.id]: [optionId] },
          });
        },
      }
    : {
        missing: true,
        name: "",
        options: [],
        onAdd: () => {
          const created = addChiefOfStaff();
          if (!created) return;
          setRoster((n) => n + 1);
          openChiefChat(created.id);
        },
        onOpenChat: () => undefined,
        onOption: () => undefined,
      };

  const needRows: HomeNeed[] = shown.map((item) => ({
    key: item.key,
    project: item.projectId ? label(item.projectId) : undefined,
    sentence: item.sentence,
    stopped: item.kind === "stopped",
    blocksShip: needsRank(item) === 1,
    actions: needActions(item),
    onOpen: () => openNeed(item),
  }));
  const workRows: HomeWork[] = lines.map((line) => ({
    key: line.key,
    project: label(line.projectId),
    text: line.text,
    since: line.since,
    onOpen: line.projectId ? () => openFromHome({ kind: "coding", projectId: line.projectId }) : undefined,
  }));
  const doneRows: HomeDone[] = finished.map((line) => ({
    key: line.key,
    project: label(line.projectId),
    text: line.text,
    time: line.time,
    onOpen: () => openFromHome(line.open),
  }));
  const arrangement = snap?.arrangement ?? { order: [], hidden: [], savedAt: 0 };

  const pages = pinnedPages().filter((page) => !scoped || page.projectId === scoped.id);
  const folder = scoped?.folder ?? undefined;
  const autos = automations.filter((auto) => !scoped || (folder ? auto.cwd === folder || auto.cwd.startsWith(`${folder}/`) : false));
  const extras: HomeExtraSection[] = [
    {
      key: "pinned-pages",
      title: "Pinned hubs",
      layout: "tiles",
      empty: "Pin a hub to keep it here.",
      rows: pages.map((page) => ({
        key: page.id,
        text: page.title,
        meta: page.pinnedBy ? `by ${page.pinnedBy}` : undefined,
        onOpen: () => {
          requestOpenPage(page.id);
          openPlace("pages");
        },
      })),
      action: { label: "All hubs", onClick: () => openPlace("pages") },
    },
    {
      key: "automations",
      title: "Automations",
      empty: "Nothing runs by itself yet. Ask the Chief of Staff to set one up.",
      rows: autos.map((auto) => ({
        key: auto.id,
        text: auto.name,
        meta: auto.enabled ? automationScheduleLabel(auto) : "Paused",
        onOpen: () => openPlace("automations"),
      })),
      action: { label: "Manage", onClick: () => openPlace("automations") },
    },
  ];

  function see(target: HomeOpenTarget) {
    openFromHome(target);
  }

  return (
    <HomeScreen
      date={homeDateLabel(now)}
      chief={chief}
      needs={needRows}
      needsTotal={totalNeeds}
      // WP-210: the count at a glance, the card's count and the rail's badges are the one Needs you list.
      needsGlance={totalNeeds}
      builders={builderLines}
      working={workRows}
      workingTotal={running}
      done={doneRows}
      onSeeNeeds={() => see({ kind: "needs" })}
      arrangement={snap ? arrangement : { order: [], hidden: [], savedAt: 0 }}
      catalog={snap?.catalog ?? []}
      known={snap != null}
      failed={failed}
      onOpen={(line) => openFromHome(targetFor(line))}
      onHide={(key) => void update((doc) => ({ ...doc, arrangement: hideSection(doc.arrangement, key) }))}
      onShow={(key) => void update((doc) => ({ ...doc, arrangement: showSection(doc.arrangement, key) }))}
      onPin={(plugin, panelId) => void update((doc) => ({ ...doc, arrangement: pinPanel(doc.arrangement, plugin, panelId) }))}
      onUnpin={(key) => void update((doc) => ({ ...doc, arrangement: unpin(doc.arrangement, key) }))}
      onReorder={(keys) => void update((doc) => ({ ...doc, arrangement: withCardOrder(doc.arrangement, keys) }))}
      onAsk={(text) => {
        if (!chiefMono) return;
        // The box is a starting point: the conversation carries on in the Chief of Staff's own chat. In a project that is
        // the project's own Chief of Staff chat, geared to it; on Home, its chat with everything in view.
        void sendHomeTurn(chiefMono.id, text, scoped?.id).then((result) => {
          if (result.ok && !scoped) setSessionId(result.sessionId);
        });
        if (scoped) openProjectChief(scoped.id);
        else openChiefChat(chiefMono.id);
      }}
      title={scoped ? scoped.name : "Home"}
      headerExtra={<AutopilotSwitch projectId={scoped?.id} name={scoped ? scoped.name : "everything"} />}
      extraSections={extras}
      renderPanel={(panel) => <PanelFrame plugin={panel.plugin} panelId={panel.panelId} spec={panel.spec} />}
    />
  );
}
