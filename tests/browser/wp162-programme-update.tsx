// Browser proof for the programme update setting (WP-162). The Tauri bridge is faked before the page loads.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProgrammeUpdateSetting } from "../../src/features/programme/ui/ProgrammeUpdateSetting";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

const held: Array<() => void> = [];

installFakeTauri("wp162", (command, args) => {
  const project = String(args.project ?? "");
  if (command === "programme_update_settings_get") {
    if (project === "/tmp/slow") {
      return new Promise((resolve) => {
        held.push(() =>
          resolve({
            project,
            updateConflicting: true,
            strategy: "rebase",
            version: 3,
          }),
        );
      });
    }
    if (project === "/tmp/two") {
      return { project, updateConflicting: false, strategy: "merge", version: 4 };
    }
    return { project, updateConflicting: false, strategy: "merge", version: 0 };
  }
  if (command === "programme_update_settings_set") {
    document.body.dataset.lastCommand = command;
    document.body.dataset.lastFlag = String(args.updateConflicting === true);
    document.body.dataset.lastStrategy = String(args.strategy ?? "");
    return {
      project,
      updateConflicting: args.updateConflicting === true,
      strategy: args.strategy === "rebase" ? "rebase" : "merge",
      version: 1,
    };
  }
  return null;
});

Object.assign(window, {
  releaseStale() {
    for (const resolve of held.splice(0)) resolve();
  },
});

function Page() {
  const [project, setProject] = useState("/tmp/web");
  return (
    <>
      <button type="button" onClick={() => setProject("/tmp/slow")}>
        Slow project
      </button>
      <button type="button" onClick={() => setProject("/tmp/two")}>
        Other project
      </button>
      <ProgrammeUpdateSetting project={project} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
