// Keeps the "bring my chats over" setup moving for as long as the app is open, and opens its card on the part the
// sidebar's card asks for. Mounted once, beside first run's own card.

import { useEffect, useState } from "react";
import { liveHubStore } from "../../hub/model/hubData";
import { learnRunStatus, sharedLearnPorts, startLearnRun, subscribeLearnRun, useLearnRun } from "../../memory/ui/learnHost";
import { chatImportRun } from "../model/live";
import type { ProjectRef } from "../model/plan";
import { startSetupDriver } from "../model/setupDriver";
import { setSetupState, setupState } from "../model/setupStage";
import { ImportSetupCard } from "./ImportSetupCard";
import { inMockup, mockupLearn } from "./mockupLearn";
import { OPEN_IMPORT_SETUP_EVENT, type SetupPart } from "./importRail";

function projectRefs(): ProjectRef[] {
  return (liveHubStore()?.getSnapshot().projects ?? []).map((project) => ({ id: project.id, name: project.name, folder: project.folder }));
}

export function ImportSetupHost() {
  const [part, setPart] = useState<SetupPart | null>(null);
  const learn = useLearnRun();
  useEffect(
    () =>
      startSetupDriver({
        run: chatImportRun(),
        learnStatus: learnRunStatus,
        subscribeLearn: subscribeLearnRun,
        startLearn: inMockup() ? mockupLearn : startLearnRun,
      }),
    [],
  );
  useEffect(() => {
    const open = (event: Event) => {
      const asked = (event as CustomEvent<{ part?: string }>).detail?.part;
      if (asked === "choose" || asked === "rules") setPart(asked);
    };
    window.addEventListener(OPEN_IMPORT_SETUP_EVENT, open);
    return () => window.removeEventListener(OPEN_IMPORT_SETUP_EVENT, open);
  }, []);
  if (!part) return null;
  return (
    <ImportSetupCard
      part={part}
      run={chatImportRun()}
      projects={projectRefs()}
      rules={learn.proposals}
      rulesFrom={learn.chats}
      accept={(id) => (inMockup() ? Promise.resolve(true) : sharedLearnPorts().accept(id))}
      onBringIn={() => setPart(null)}
      onRulesDone={() => {
        setSetupState({ ...setupState(), stage: "off" });
        setPart(null);
      }}
      onClose={() => setPart(null)}
    />
  );
}
