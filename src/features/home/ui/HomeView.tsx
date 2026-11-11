// Home, wired to the chief's chat, the needs list, running workers and what finished today.
// A late load is dropped. A failed load keeps the last one. Home does not file tasks.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readPage, type ActivityEntry } from "../../activity/model/activity";
import { useDelegationRows } from "../../monos/model/delegationStore";
import type { Delegation } from "../../monos/model/delegations";
import { builderHold, useWorkerPoolVersion } from "../../monos/model/workerPool";
import { listMonos } from "../../monos/model/mono";
import { useHubDataVersion, hubData } from "../../hub/model/hubData";
import { LOCAL_HUB_CHANGED } from "../../hub/model/localHub/localTransport";
import { PanelFrame } from "../../panels/ui/PanelTabs";
import { needsCount, useNeedsYou, workingCount, type NeedsItem } from "../../needs/model/needsYou";
import { localDay, readLines, type WorkLogLine } from "../../workLog/model/workLog";
import { hideSection, pinPanel, showSection, unpin } from "../model/arrangement";
import { moveHomeSection } from "../model/arrangeHome";
import { addChiefOfStaff, chiefScopeLine, openChiefChat, pickChief } from "../model/chief";
import { homeDateLabel } from "../model/dateLabel";
import { doneToday, projectTag } from "../model/doneToday";
import { latestExchange } from "../model/exchange";
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
import { needsShown } from "../model/needsShown";
import { openFromHome, targetFor, type HomeOpenTarget } from "../model/opener";
import { HOME_DOC_KEY, changeHome, type HomeDoc } from "../model/store";
import { workingLines } from "../model/workingNow";
import { HomeScreen, type HomeChief, type HomeDone, type HomeNeed, type HomeWork } from "./HomeScreen";
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

function openNeed(item: NeedsItem): void {
  const projectId = item.projectId ?? "";
  if (item.open.kind === "inbox") {
    openFromHome({ kind: "needs" });
    return;
  }
  if (item.open.kind === "chat") {
    openFromHome({ kind: "chat", id: item.open.id, projectId });
    return;
  }
  if (item.open.kind === "page") {
    openFromHome({ kind: "doc", id: item.open.id });
    return;
  }
  openFromHome({ kind: "task", projectId: item.open.projectId ?? projectId, id: item.open.id });
}

export function HomeView() {
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
  const label = labelFor(projects);
  const now = new Date();
  const session = sessionId ? readHomeChiefSession(sessionId) : undefined;
  void chiefRev;
  const exchange = latestExchange(session?.blocks ?? [], session?.busy === true);
  const pending = session?.pendingQuestion;
  const question = pending?.questions[0];
  const hold = builderHold();
  const shown = needsShown(needs, now.getTime());
  const totalNeeds = needsCount();
  const lines = workingLines(delegations.map((row: Delegation) => ({
    id: row.id,
    project: row.project,
    title: row.title,
    goal: row.goal,
    state: row.state,
    createdAt: row.createdAt,
  })));
  const running = workingCount();
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
  });

  const chief: HomeChief = chiefMono
    ? {
        missing: false,
        name: (chiefMono.name ?? "").trim() || "Chief of Staff",
        scope: chiefScopeLine(chiefMono, hubData().listProjects().length),
        you: exchange.you,
        reply: exchange.reply,
        streaming: exchange.streaming,
        options: (question?.options ?? []).map((option) => ({ id: option.id, label: option.label })),
        onAdd: () => undefined,
        onOpenChat: () => openChiefChat(chiefMono.id),
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
    actions: item.actions.map((action) => ({ label: action.label, onClick: () => action.run() })),
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

  function see(target: HomeOpenTarget) {
    openFromHome(target);
  }

  return (
    <HomeScreen
      date={homeDateLabel(now)}
      chief={chief}
      needs={needRows}
      needsTotal={totalNeeds}
      builders={hold ? [builderHoldLine(hold)] : []}
      working={workRows}
      workingTotal={running}
      done={doneRows}
      onSeeNeeds={() => see({ kind: "needs" })}
      onSeeDone={() => see({ kind: "settings", section: "work-log", anchor: "" })}
      arrangement={snap ? arrangement : { order: [], hidden: [], savedAt: 0 }}
      catalog={snap?.catalog ?? []}
      known={snap != null}
      failed={failed}
      onOpen={(line) => openFromHome(targetFor(line))}
      onMove={(key, dir) => void update((doc) => ({ ...doc, arrangement: moveHomeSection(doc.arrangement, key, dir) }))}
      onHide={(key) => void update((doc) => ({ ...doc, arrangement: hideSection(doc.arrangement, key) }))}
      onShow={(key) => void update((doc) => ({ ...doc, arrangement: showSection(doc.arrangement, key) }))}
      onPin={(plugin, panelId) => void update((doc) => ({ ...doc, arrangement: pinPanel(doc.arrangement, plugin, panelId) }))}
      onUnpin={(key) => void update((doc) => ({ ...doc, arrangement: unpin(doc.arrangement, key) }))}
      onAsk={(text) => {
        if (!chiefMono) return;
        void sendHomeTurn(chiefMono.id, text).then((result) => {
          if (result.ok) setSessionId(result.sessionId);
        });
      }}
      renderPanel={(panel) => <PanelFrame plugin={panel.plugin} panelId={panel.panelId} spec={panel.spec} />}
    />
  );
}
