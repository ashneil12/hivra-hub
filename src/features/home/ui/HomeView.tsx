// Home, wired to the app's tasks, decisions, docs and panels. A late load is dropped. A failed load keeps the last one.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fileIntoProject } from "../../chief/model/answer";
import { createHomeAsks } from "../model/ask";
import { readingsOf } from "../../chief/model/homeReadings";
import { summaryLines } from "../../chief/model/summary";
import { MORNING_HABIT_ID } from "../../chief/model/habit";
import { readsEveryProject } from "../../chief/model/scope";
import { listMonos } from "../../monos/model/mono";
import { builderHold, useWorkerPoolVersion } from "../../monos/model/workerPool";
import { loadHabits } from "../../monos/model/monoHabits";
import { useHubDataVersion, hubData, registryProjects } from "../../hub/model/hubData";
import { showAppItem } from "../../hub/model/hubNav";
import { importFromAshOsAgain, importOutcome, lastAshOsImport, subscribeAshOsImport } from "../../hub/model/localHub/ashOsImport";
import { LOCAL_HUB_CHANGED, appHubTransport } from "../../hub/model/localHub/localTransport";
import { PanelFrame } from "../../panels/ui/PanelTabs";
import { hideSection, moveSection, pinPanel, showSection, unpin } from "../model/arrangement";
import { LateHomeLoad, createHomeLoader, mergeHomeLoad, realHomeSource, type HomeSnapshot } from "../model/load";
import { builderHoldLine, hubProjectId, movingLines, namesFor, projectLines, recentLines, type HomeLine } from "../model/lines";
import { useNeedsYou } from "../../needs/model/needsLive";
import type { NeedsItem } from "../../needs/model/needsYou";
import { openFromHome, targetFor } from "../model/opener";
import { HOME_DOC_KEY, changeHome, type HomeDoc } from "../model/store";
import { HomeScreen } from "./HomeScreen";
import { keepListening } from "./listenRetry";
import { ProgrammePanel } from "../../programme/ui/ProgrammePanel";
import {
  applyProgrammeLoad,
  collectProgramme,
  PROGRAMME_CHANGED,
  READ_NOTICE,
  READ_NOTICE_AFTER,
  programmeShows,
  retryDelayMs,
  type ProgrammePackage,
} from "../../programme/model/programme";

const TASKS_CHANGED = "tasks://changed";

function lineFromNeed(item: NeedsItem): HomeLine {
  const kind = item.kind === "review" ? "review" : item.kind === "question" ? "question" : "decision";
  return {
    id: item.key,
    kind,
    text: item.sentence,
    projectId: item.projectId ?? "",
    target: item.open?.id ?? item.key,
    at: item.at,
    actions: item.actions,
  };
}
const RETRY_MS = 2000;

export function HomeView() {
  const source = useMemo(() => realHomeSource(), []);
  const loader = useRef(createHomeLoader(source));
  const token = useRef(0);
  const asks = useRef<ReturnType<typeof createHomeAsks> | null>(null);
  if (!asks.current) {
    asks.current = createHomeAsks((projectId, title) => fileIntoProject((command, args) => invoke(command, args), projectId, title));
  }
  const snapRef = useRef<HomeSnapshot | null>(null);
  const [snap, setSnap] = useState<HomeSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [report, setReport] = useState<string | undefined>(undefined);
  const [reply, setReply] = useState<{ text?: string; notes?: { id: string; kind: string; text: string; projectId: string }[] } | undefined>(undefined);
  // WP-159: the programme card. A failed read keeps the last rows and does not mark Home failed.
  const [programme, setProgramme] = useState<ProgrammePackage[]>([]);
  const [programmeNotice, setProgrammeNotice] = useState<string | undefined>(undefined);
  const programmeToken = useRef(0);
  // The rows on screen (kept when a board fails), the read a notice was set by, and the failed reads in a row.
  const programmeRows = useRef<ProgrammePackage[]>([]);
  const programmeNoticeAt = useRef(-1);
  const programmeFails = useRef(0);
  const reloadProgramme = useRef<() => void>(() => undefined);
  const [bringing, setBringing] = useState<{ busy: boolean; outcome?: string }>({ busy: false });
  const ashOs = useSyncExternalStore(subscribeAshOsImport, lastAshOsImport, lastAshOsImport);
  useHubDataVersion();
  // WP-161: the queue, the saved pauses and the machine's last reading, so a hold on new builders shows and clears here.
  useWorkerPoolVersion();
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
    let laterTimer = 0;
    let unlisten: (() => void) | undefined;
    const load = () => {
      window.clearTimeout(timer);
      const mine = ++programmeToken.current;
      const projects = hubData().listProjects().map((project) => project.id).filter((id) => id.trim() !== "");
      void collectProgramme(projects, (project) =>
        invoke("programme_list", { actor: { id: "person", project, kind: "person" } }),
      ).then((loaded) => {
        if (stopped) return;
        const applied = applyProgrammeLoad(mine, programmeToken.current, loaded, programmeRows.current, programmeNoticeAt.current);
        if ("drop" in applied) return;
        programmeRows.current = applied.rows;
        setProgramme(applied.rows);
        if (applied.clearNotice) setProgrammeNotice(undefined);
        if (!applied.retry) {
          programmeFails.current = 0;
          return;
        }
        // A board that did not answer keeps its rows. Retry with a longer wait each time, and say so after a few.
        programmeFails.current += 1;
        if (programmeFails.current >= READ_NOTICE_AFTER) {
          programmeNoticeAt.current = mine;
          setProgrammeNotice(READ_NOTICE);
        }
        timer = window.setTimeout(load, retryDelayMs(programmeFails.current));
      });
    };
    reloadProgramme.current = load;
    load();
    keepListening(
      () => listen(PROGRAMME_CHANGED, () => {
        if (!stopped) load();
      }).then((stop) => {
        if (stopped) {
          stop();
          return () => undefined;
        }
        unlisten = stop;
        return stop;
      }),
      { stopped: () => stopped, retryMs: RETRY_MS, later: (fn, ms) => (laterTimer = window.setTimeout(fn, ms)) },
    );
    return () => {
      stopped = true;
      programmeToken.current += 1;
      window.clearTimeout(timer);
      window.clearTimeout(laterTimer);
      unlisten?.();
    };
  }, [projectKey]);

  useEffect(() => {
    let stopped = false;
    const mono = listMonos().find((item) => readsEveryProject(item));
    if (!mono) return undefined;
    void loadHabits(mono.id).then((habits) => {
      if (stopped) return;
      const morning = habits.find((habit) => habit.id === MORNING_HABIT_ID);
      const latest = morning?.runs?.[0];
      setReport(latest?.outcome === "posted" ? latest.report : undefined);
    }).catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [snap?.rev]);

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
  const name = namesFor(projects);
  const tasks = (snap?.tasks ?? []).map((task) => ({ ...task, projectId: hubProjectId(task.projectId, projects) }));
  const arrangement = snap?.arrangement ?? { order: [], hidden: [], savedAt: 0 };
  const readings = readingsOf({
    projects,
    tasks,
    docs: snap?.docs ?? [],
    decisions: snap?.decisions ?? [],
    chats: snap?.chats ?? [],
  });
  const summary = summaryLines(report, snap?.summaryOff === true, readings);
  function programmeSaid(error: unknown): string {
    if (typeof error === "string" && error.trim()) return error;
    if (error instanceof Error && error.message.trim()) return error.message;
    return "The programme is busy. Try again.";
  }

  async function clearPark(row: ProgrammePackage) {
    try {
      await invoke("programme_clear", {
        actor: { id: "person", project: row.projectId, kind: "person" },
        input: { id: row.id, version: row.version },
      });
      setProgrammeNotice(undefined);
      reloadProgramme.current();
    } catch (error) {
      // The notice stays until a complete read that starts after it (the reload below is the one that shows the board as it is now).
      reloadProgramme.current();
      programmeNoticeAt.current = programmeToken.current;
      setProgrammeNotice(programmeSaid(error));
    }
  }

  async function onAsk(text: string) {
    const current = snapRef.current;
    const next = await asks.current?.ask(text, {
      readings: current
        ? readingsOf({
            projects: current.projects,
            tasks: current.tasks.map((task) => ({ ...task, projectId: hubProjectId(task.projectId, current.projects) })),
            docs: current.docs,
            decisions: current.decisions,
            chats: current.chats,
          })
        : [],
      projects: (current?.projects ?? []).map((project) => ({ id: project.id, name: project.name, folder: project.folder })),
      loaded: current != null,
    });
    if (!next) return;
    setReply(next);
  }
  async function bringOver() {
    setBringing({ busy: true });
    try {
      const decision = await importFromAshOsAgain(appHubTransport().hub);
      setBringing({ busy: false, outcome: importOutcome(decision) });
    } catch {
      setBringing({ busy: false, outcome: "Couldn't bring them over just now. Try again." });
    }
  }
  const hold = builderHold();
  const liveNeeds = useNeedsYou();
  const needsYou = [...(hold ? [builderHoldLine(hold)] : []), ...liveNeeds.map(lineFromNeed)];
  const moving = movingLines(tasks, name);
  // The app holds no project at all (not one hidden by the trash or Ash's own "Remove from hub"): say why.
  const noProjects = snap && registryProjects().length === 0
    ? { inAshOs: ashOs?.decided === "later", outcome: bringing.outcome, busy: bringing.busy }
    : undefined;
  return (
    <HomeScreen
      needsYou={needsYou}
      needsMark={liveNeeds.length}
      projects={projectLines(projects, needsYou, moving, tasks)}
      noProjects={noProjects}
      onBringOver={() => void bringOver()}
      onNewProject={() => showAppItem("new-project")}
      moving={moving}
      recent={recentLines(snap?.docs ?? [], snap?.chats ?? [])}
      arrangement={snap ? arrangement : { order: [], hidden: [], savedAt: 0 }}
      catalog={snap?.catalog ?? []}
      known={snap != null}
      failed={failed}
      summary={summary}
      reply={reply}
      onOpen={(line) => openFromHome(targetFor(line))}
      onMove={(key, dir) => void update((doc) => ({ ...doc, arrangement: moveSection(doc.arrangement, key, dir) }))}
      onHide={(key) => void update((doc) => ({ ...doc, arrangement: hideSection(doc.arrangement, key) }))}
      onShow={(key) => void update((doc) => ({ ...doc, arrangement: showSection(doc.arrangement, key) }))}
      onPin={(plugin, panelId) => void update((doc) => ({ ...doc, arrangement: pinPanel(doc.arrangement, plugin, panelId) }))}
      onUnpin={(key) => void update((doc) => ({ ...doc, arrangement: unpin(doc.arrangement, key) }))}
      onAsk={(text) => void onAsk(text)}
      renderPanel={(panel) => <PanelFrame plugin={panel.plugin} panelId={panel.panelId} spec={panel.spec} />}
      programme={programmeShows(programme, programmeNotice) ? (
        <ProgrammePanel rows={programme} notice={programmeNotice} onClear={(row) => void clearPark(row)} />
      ) : undefined}
    />
  );
}
