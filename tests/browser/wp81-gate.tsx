// Browser proof for the delivery gate (WP-81). The Tauri bridge is faked before the page loads.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GateCards } from "../../src/features/delivery-gate/ui/GateCards";
import { GateSetting } from "../../src/features/delivery-gate/ui/GateSetting";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

const CHECKING = {
  id: "1",
  delegationId: "d1",
  line: "checking: tests",
  finding: null,
  decisionKey: null,
  prUrl: null,
  state: "checking",
};

const PARKED = {
  id: "2",
  delegationId: "d2",
  line: "The name change needs a look.",
  finding: "The name change needs a look.",
  decisionKey: "gate/r1",
  prUrl: null,
  state: "parked",
};

const PASSED = {
  id: "3",
  delegationId: "d3",
  line: "The check passed.",
  finding: null,
  decisionKey: null,
  prUrl: "https://github.com/acme/web/pull/7",
  state: "passed",
};

const held: Array<() => void> = [];

installFakeTauri("wp81", (command, args) => {
  const project = String(args.project ?? "");
  if (command === "gate_setting_get") {
    if (project === "/tmp/slow") {
      return new Promise((resolve) => {
        held.push(() => resolve({ enabled: true, version: 3, note: "Stale note." }));
      });
    }
    if (project === "/tmp/two") return { enabled: false, version: 4, note: "This project is off." };
    return { enabled: false, version: 0, note: null };
  }
  if (command === "gate_setting_set") {
    document.body.dataset.lastCommand = command;
    return {
      enabled: args.enabled === true,
      version: 1,
      note: args.enabled === true ? "Added the no-mistakes remote." : "Removed the no-mistakes remote.",
    };
  }
  if (command === "gate_cards") {
    if (project === "/tmp/bad") throw new Error("no");
    if (project === "/tmp/slow") {
      return new Promise((resolve) => {
        held.push(() =>
          resolve([
            {
              id: "old",
              delegationId: null,
              line: "Old card.",
              finding: null,
              decisionKey: null,
              prUrl: null,
              state: "checking",
            },
          ]),
        );
      });
    }
    if (project === "/tmp/two") return [];
    return [CHECKING, PARKED, PASSED];
  }
  if (command === "gate_respond") {
    document.body.dataset.lastAnswer = String(args.answer ?? "");
    return null;
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
      <button type="button" onClick={() => setProject("/tmp/bad")}>
        Broken project
      </button>
      <GateSetting project={project} />
      <GateCards project={project} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
