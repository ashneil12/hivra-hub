// Browser proof for Settings → Repo watch (WP-166). The page is the one
// Settings renders. Pickers and the pin file are injected, so this never
// touches a real project or the network.
import { createRoot } from "react-dom/client";
import { RepoWatchPage } from "../../src/features/repoWatch/ui/RepoWatchPage";
import { RepoWatchHabitSwitch } from "../../src/features/repoWatch/ui/RepoWatchHabitSwitch";
import { memoryPinIo, type PinIo } from "../../src/features/repoWatch/model/pinStore";
import type { Habit } from "../../src/features/monos/model/monoHabits";
import "../../src/styles/index.css";

type Control = {
  file: string | null;
  folder: string | null;
  files: Record<string, string>;
  loadStarted: boolean;
  releaseLoad: () => void;
};

const control: Control = {
  file: null,
  folder: null,
  files: {},
  loadStarted: false,
  releaseLoad: () => {},
};

(window as unknown as { repoWatch: Control }).repoWatch = control;

function readPicked(path: string): Promise<string> {
  const base = path.split(/[/\\]/).pop() ?? path;
  const text = control.files[path] ?? control.files[base];
  if (text === undefined) return Promise.reject(new Error("not found"));
  return Promise.resolve(text);
}

function page(root: HTMLElement, io: PinIo, projectRoot: string) {
  createRoot(root).render(
    <RepoWatchPage
      projectRoot={projectRoot}
      io={io}
      pickFile={async () => control.file}
      pickFolder={async () => control.folder}
      readPicked={readPicked}
    />,
  );
}

page(document.getElementById("list")!, memoryPinIo(), "/work/My Project");

const lateBase = memoryPinIo();
let reads = 0;
const waiting: Array<() => void> = [];
const lateIo: PinIo = {
  async read(root) {
    reads += 1;
    if (reads === 1) {
      control.loadStarted = true;
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    return lateBase.read(root);
  },
  write: (root, text, expected) => lateBase.write(root, text, expected),
};
control.releaseLoad = () => {
  for (const resolve of waiting.splice(0)) resolve();
};
page(document.getElementById("late")!, lateIo, "/work/My Project");

page(document.getElementById("none")!, memoryPinIo(), "  ");

const habitState: { habits: Habit[] } = { habits: [] };
(window as unknown as { repoWatchHabits: Habit[] }).repoWatchHabits = habitState.habits;
createRoot(document.getElementById("habit")!).render(
  <RepoWatchHabitSwitch
    load={async () => habitState.habits}
    update={async (change) => {
      habitState.habits = change(habitState.habits);
      (window as unknown as { repoWatchHabits: Habit[] }).repoWatchHabits = habitState.habits;
    }}
  />,
);

createRoot(document.getElementById("habit-down")!).render(
  <RepoWatchHabitSwitch
    load={async () => {
      throw new Error("timed out");
    }}
    update={async () => {
      throw new Error("should not save");
    }}
  />,
);
