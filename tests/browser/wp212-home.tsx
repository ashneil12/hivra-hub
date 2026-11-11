// WP-212. Example data only. The screen, not the live store.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { CatalogPanel } from "../../src/features/panels/model/panelTabs";
import { hideSection, parseArrangement, pinPanel, showSection, unpin, type HomeArrangement } from "../../src/features/home/model/arrangement";
import { moveHomeSection } from "../../src/features/home/model/arrangeHome";
import { HomeScreen, type HomeChief } from "../../src/features/home/ui/HomeScreen";
import "../../src/styles/index.css";

const KEY = "wp212-home-arrangement";
const empty = new URLSearchParams(location.search).has("empty");

const catalog: CatalogPanel[] = [{
  plugin: "my-panels",
  panelId: "board",
  title: "Example board",
  spec: { kind: "bespoke", title: "Example board", html: "<p>Example: board</p>", permissions: ["tasks.read"] },
}];

function loadArrangement(): HomeArrangement {
  const raw = localStorage.getItem(KEY);
  if (!raw) return parseArrangement({ order: [], hidden: [], savedAt: 1 });
  try {
    return parseArrangement(JSON.parse(raw) as unknown);
  } catch {
    return parseArrangement({ order: [], hidden: [], savedAt: 1 });
  }
}

function Page() {
  const [arrangement, setArrangement] = useState(loadArrangement);
  const [you, setYou] = useState("");
  const [reply, setReply] = useState("");
  function keep(next: HomeArrangement) {
    localStorage.setItem(KEY, JSON.stringify(next));
    setArrangement(next);
  }
  const chief: HomeChief = {
    missing: false,
    name: "Coordinator",
    scope: "read all 7 projects",
    you: you || undefined,
    reply: reply || undefined,
    streaming: false,
    options: reply ? [{ id: "ok", label: "Sounds good" }] : [],
    onAdd: () => undefined,
    onOpenChat: () => {
      document.body.dataset.opened = "chief-1";
    },
    onOption: () => undefined,
  };
  return (
    <HomeScreen
      date="Wednesday 11 November"
      chief={chief}
      needs={empty ? [] : [
        { key: "n1", project: "Crew", sentence: "Should we ship the notes?", stopped: false, actions: [], onOpen: () => undefined },
        {
          key: "n2",
          project: "Crew",
          sentence: "The notes worker stopped.",
          stopped: true,
          actions: [{ label: "Open Ada's chat", onClick: () => undefined }],
          onOpen: () => undefined,
        },
      ]}
      needsTotal={empty ? 0 : 2}
      builders={[]}
      working={empty ? [] : [{
        key: "crew",
        project: "Crew",
        text: "4 workers: chat move fixes, PR watch, commit guard, crew locks",
        since: "since 03:40",
        onOpen: () => undefined,
      }]}
      workingTotal={empty ? 0 : 4}
      done={empty ? [] : [{
        key: "m1",
        project: "Crew",
        text: "Merged the notes",
        time: "09:05",
        onOpen: () => undefined,
      }]}
      onSeeNeeds={() => {
        document.body.dataset.opened = "needs";
      }}
      onSeeDone={() => {
        document.body.dataset.opened = "done";
      }}
      arrangement={arrangement}
      catalog={catalog}
      known
      failed={false}
      onOpen={() => undefined}
      onMove={(key, dir) => keep(moveHomeSection(arrangement, key, dir))}
      onHide={(key) => keep(hideSection(arrangement, key))}
      onShow={(key) => keep(showSection(arrangement, key))}
      onPin={(plugin, panelId) => keep(pinPanel(arrangement, plugin, panelId))}
      onUnpin={(key) => keep(unpin(arrangement, key))}
      onAsk={(text) => {
        setYou(text);
        setReply("EXO is fine.");
      }}
      renderPanel={() => <p>Example: board</p>}
    />
  );
}

createRoot(document.getElementById("shell")!).render(<Page />);
