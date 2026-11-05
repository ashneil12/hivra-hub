// Home, wired to the app's tasks, decisions, docs and panels. A late load is dropped. A failed load keeps the last one.

import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useHubDataVersion, hubData } from "../../hub/model/hubData";
import { LOCAL_HUB_CHANGED } from "../../hub/model/localHub/localTransport";
import { PanelFrame } from "../../panels/ui/PanelTabs";
import { hideSection, moveSection, pinPanel, showSection, unpin } from "../model/arrangement";
import { LateHomeLoad, createHomeLoader, realHomeSource, type HomeSnapshot } from "../model/load";
import { hubProjectId, movingLines, namesFor, needsYouLines, recentLines } from "../model/lines";
import { openFromHome, targetFor } from "../model/opener";
import { HOME_DOC_KEY, changeHome, type HomeDoc } from "../model/store";
import { HomeScreen } from "./HomeScreen";

const TASKS_CHANGED = "tasks://changed";
const RETRY_MS = 2000;

export function HomeView() {
  const source = useMemo(() => realHomeSource(), []);
  const loader = useRef(createHomeLoader(source));
  const token = useRef(0);
  const [snap, setSnap] = useState<HomeSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  useHubDataVersion();
  const projectKey = hubData().listProjects().map((project) => `${project.id}\0${project.name}\0${project.folder ?? ""}`).join("\n");

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let unlistenTasks: (() => void) | undefined;
    let unlistenHub: (() => void) | undefined;
    const run = () => {
      window.clearTimeout(timer);
      const mine = ++token.current;
      loader.current.invalidate();
      void loader.current.load().then((next) => {
        if (stopped || mine !== token.current) return;
        setSnap(next);
        setFailed(false);
      }).catch((error: unknown) => {
        if (stopped || mine !== token.current || error instanceof LateHomeLoad) return;
        setFailed(true);
        timer = window.setTimeout(run, RETRY_MS);
      });
    };
    run();
    void listen(TASKS_CHANGED, () => {
      if (!stopped) run();
    }).then((stop) => {
      if (stopped) stop();
      else unlistenTasks = stop;
    }).catch(() => undefined);
    void listen<{ key?: unknown }>(LOCAL_HUB_CHANGED, (event) => {
      if (!stopped && event.payload?.key === HOME_DOC_KEY) run();
    }).then((stop) => {
      if (stopped) stop();
      else unlistenHub = stop;
    }).catch(() => undefined);
    return () => {
      stopped = true;
      token.current += 1;
      window.clearTimeout(timer);
      unlistenTasks?.();
      unlistenHub?.();
    };
  }, [projectKey, source]);

  async function update(fn: (doc: HomeDoc) => HomeDoc) {
    const mine = ++token.current;
    const written = await changeHome(source.disk, source.storage, fn);
    if (!written || mine !== token.current) return;
    setSnap((prev) => (prev ? { ...prev, arrangement: written.doc.arrangement, chats: written.doc.recent, rev: written.rev } : prev));
  }

  const projects = snap?.projects ?? [];
  const name = namesFor(projects);
  const tasks = (snap?.tasks ?? []).map((task) => ({ ...task, projectId: hubProjectId(task.projectId, projects) }));
  const arrangement = snap?.arrangement ?? { order: [], hidden: [], savedAt: 0 };
  return (
    <HomeScreen
      needsYou={needsYouLines(snap?.decisions ?? [], tasks, name)}
      moving={movingLines(tasks, name)}
      recent={recentLines(snap?.docs ?? [], snap?.chats ?? [])}
      arrangement={snap ? arrangement : { order: [], hidden: [], savedAt: 0 }}
      projects={projects}
      catalog={snap?.catalog ?? []}
      known={snap != null}
      failed={failed}
      onOpen={(line) => openFromHome(targetFor(line))}
      onMove={(key, dir) => void update((doc) => ({ ...doc, arrangement: moveSection(doc.arrangement, key, dir) }))}
      onHide={(key) => void update((doc) => ({ ...doc, arrangement: hideSection(doc.arrangement, key) }))}
      onShow={(key) => void update((doc) => ({ ...doc, arrangement: showSection(doc.arrangement, key) }))}
      onPin={(plugin, panelId) => void update((doc) => ({ ...doc, arrangement: pinPanel(doc.arrangement, plugin, panelId) }))}
      onUnpin={(key) => void update((doc) => ({ ...doc, arrangement: unpin(doc.arrangement, key) }))}
      onStart={(projectId) => openFromHome({ kind: "coding", projectId })}
      renderPanel={(panel) => <PanelFrame plugin={panel.plugin} panelId={panel.panelId} spec={panel.spec} />}
    />
  );
}
