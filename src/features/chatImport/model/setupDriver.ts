// Moves the "bring my chats over" setup from one part to the next as the work behind it finishes. It never opens
// anything by itself: the sidebar's card says where the setup stands and the person comes back when they want to.

import type { ChatImportRun } from "./runner";
import { setSetupState, setupState, subscribeSetup, type SetupState } from "./setupStage";

export type LearnStatus = { phase: string; proposals: unknown[] };

export type SetupDriverPorts = {
  run: ChatImportRun;
  learnStatus: () => LearnStatus;
  subscribeLearn: (listener: () => void) => () => void;
  startLearn: (options: { fromMs?: number; files: string[]; sources: string[]; includeUserFile?: boolean }) => Promise<unknown>;
};

const learnBusy = (phase: string) => phase === "listing" || phase === "reading" || phase === "asking";

/** The stage the facts say the setup is in now. */
export function nextStage(state: SetupState, runPhase: string, imported: number, learn: LearnStatus): SetupState {
  switch (state.stage) {
    case "sweep":
      if (runPhase === "ready") return { ...state, stage: "choose" };
      // Nothing to read on this computer, or the sweep was stopped: the setup is over.
      if (runPhase === "failed" || runPhase === "cancelled") return { ...state, stage: "off" };
      return state;
    case "choose":
      if (runPhase === "importing") return { ...state, stage: "importing" };
      return state;
    case "importing":
      if (runPhase === "done") return state.learn && imported > 0 ? { ...state, stage: "reading" } : { ...state, stage: "off" };
      if (runPhase === "failed" || runPhase === "cancelled") return { ...state, stage: "off" };
      return state;
    case "reading":
      if (learnBusy(learn.phase)) return state;
      if (learn.phase === "done" && learn.proposals.length > 0) return { ...state, stage: "rules" };
      if (learn.phase === "done" || learn.phase === "failed") return { ...state, stage: "off" };
      return state;
    default:
      return state;
  }
}

/** Starts watching. Returns a stop. A relaunch mid-setup runs the sweep again, since its results were only in memory. */
export function startSetupDriver(ports: SetupDriverPorts): () => void {
  let reading = false;
  const tick = () => {
    const before = setupState();
    const run = ports.run.get();
    if ((before.stage === "sweep" || before.stage === "choose") && run.phase === "idle") {
      void ports.run.find();
      return;
    }
    // Cut by a quit while chats were coming in: back to choosing, with a fresh sweep. Chats already in are skipped.
    if (before.stage === "importing" && run.phase === "idle") {
      setSetupState({ ...before, stage: "choose" });
      return;
    }
    const after = nextStage(before, run.phase, run.imported, ports.learnStatus());
    if (after.stage === "reading" && !reading && !learnBusy(ports.learnStatus().phase) && before.stage !== "reading") {
      // Only the chats the person brought in are read: never a folder they left out, never another tool's store.
      const files = run.importedFiles;
      if (files.length === 0) {
        setSetupState({ ...before, stage: "off" });
        return;
      }
      reading = true;
      const fromMs = run.choices?.fromMs ?? undefined;
      setSetupState(after);
      void ports.startLearn({ ...(fromMs != null ? { fromMs } : {}), files, sources: ["claude", "codex"], includeUserFile: true }).finally(() => {
        reading = false;
        tick();
      });
      return;
    }
    // A relaunch while a model was reading: the run is gone, so there is nothing to wait for.
    if (before.stage === "reading" && !reading && ports.learnStatus().phase === "idle") {
      setSetupState({ ...before, stage: "off" });
      return;
    }
    // A relaunch with rules waiting: the batch was only in memory, so there is nothing left to show.
    if (before.stage === "rules" && ports.learnStatus().proposals.length === 0 && !learnBusy(ports.learnStatus().phase)) {
      setSetupState({ ...before, stage: "off" });
      return;
    }
    if (after !== before) setSetupState(after);
  };
  const stops = [ports.run.subscribe(tick), ports.subscribeLearn(tick), subscribeSetup(tick)];
  tick();
  return () => stops.forEach((stop) => stop());
}
