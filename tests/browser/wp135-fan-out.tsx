// WP-135: the real compare picker, with made-up models and a fake git that behaves like the app's: a worktree made a
// moment ago is clean and at the commit it was made at, and git refuses to remove one with changes in it.
// `?worktrees=reject`: every worktree create fails. `?worktrees=one`: only the first works, so only one can be made.
// `?worktrees=stuck`: the first one made has changes in it before it can be given back. `?save=fail`: the compare
// cannot be saved.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { startFanOut } from "../../src/features/sessions/model/fanOutLaunch";
import { releaseFanOutWorktrees } from "../../src/features/sessions/model/fanOutDecide";
import { ownWorktreeVerdict } from "../../src/features/sessions/model/fanOutJanitor";
import type { FanOutChoice } from "../../src/features/sessions/model/fanOutChoices";
import { FanOutPicker } from "../../src/features/sessions/ui/FanOutPicker";
import "../../src/styles/index.css";

const choices: FanOutChoice[] = [
  { provider: "claude", model: "one", label: "Claude: one" },
  { provider: "codex", model: "two", label: "Codex: two" },
  { provider: "cursor", model: "three", label: "Cursor: three" },
  { provider: "pi", model: "four", label: "Pi: four" },
  { provider: "hermes", model: "five", label: "Hermes: five" },
];

const query = new URLSearchParams(window.location.search);
const worktrees = query.get("worktrees") ?? "ok";
const saveFails = query.get("save") === "fail";
const ROOT = "/work/trees";
const MADE_AT = "abc1234";
/** The worktrees git holds, by path. */
const git = new Map<string, { head: string; dirty: boolean }>();

function Page() {
  const [started, setStarted] = useState(0);
  const [onDisk, setOnDisk] = useState(0);
  return (
    <>
      <div style={{ height: 360 }} />
      <FanOutPicker
        prompt="Fix the flaky test"
        choices={choices}
        onLaunch={async (prompt, targets) => {
          let made = 0;
          const result = await startFanOut(
            { prompt, targets, cwd: "/work/proj", now: 1 },
            {
              git: async () => true,
              allowedRoots: async () => [ROOT],
              createWorktree: async (_cwd, branch) => {
                made += 1;
                if (worktrees === "reject" || ((worktrees === "one" || worktrees === "stuck") && made > 1)) {
                  throw new Error("worktree busy");
                }
                const path = `${ROOT}/${branch.replace(/[^\w]+/g, "-")}`;
                git.set(path, { head: MADE_AT, dirty: worktrees === "stuck" });
                setOnDisk(git.size);
                return { path, branch, head: MADE_AT };
              },
              release: (items) =>
                releaseFanOutWorktrees(items, {
                  allowedRoots: [ROOT],
                  inspect: async (path, madeAt) => {
                    const tree = git.get(path);
                    return ownWorktreeVerdict(
                      tree ? { head: tree.head, dirty: tree.dirty, locked: false, missing: false, isMain: false } : undefined,
                      madeAt,
                    );
                  },
                  remove: async (path) => {
                    if (git.get(path)?.dirty) throw new Error("contains modified or untracked files");
                    git.delete(path);
                    setOnDisk(git.size);
                  },
                }),
              save: async () => !saveFails,
            },
          );
          if (!result.ok) return result.message;
          setStarted(result.sessions.length);
          return true;
        }}
      />
      <p data-fan-out-started="">{started === 0 ? "No chats yet" : `Started ${started} chats`}</p>
      <p data-fan-out-on-disk="">{onDisk === 0 ? "No worktrees on disk" : `${onDisk} worktrees on disk`}</p>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
