// Browser proof for Settings → Activity (WP-78). Seeded rows, no app.
import { createRoot } from "react-dom/client";
import { ActivityPage } from "../../src/features/activity/ui/ActivityPage";
import type { ActivityEntry, Who } from "../../src/features/activity/model/activity";
import "../../src/styles/index.css";

const person: Who = { role: "person" };
const ada: Who = { role: "first-mate", id: "lead-1", name: "Ada" };
const nia: Who = { role: "mono", id: "mono-9", name: "Nia" };
const app: Who = { role: "app" };

const seed: ActivityEntry[] = [
  {
    id: "old",
    seq: 1,
    kind: "git.push",
    actor: { role: "worker", id: "worker-9", name: "" },
    initiator: person,
    project: "acme/web",
    target: "work",
    summary: "Pushed work.",
    link: "",
    at: 1_700_000_000_000,
  },
  {
    id: "merge",
    seq: 2,
    kind: "git.merge",
    actor: ada,
    initiator: person,
    project: "acme/web",
    target: "acme/web#7",
    summary: "Merged acme/web#7.",
    link: "session:lead-1",
    at: 1_700_000_100_000,
  },
  {
    id: "pr",
    seq: 3,
    kind: "git.pr",
    actor: app,
    initiator: person,
    project: "other",
    target: "other#3",
    summary: "Opened a pull request into main.",
    link: "https://github.com/acme/web/pull/3",
    at: 1_700_000_200_000,
  },
  {
    id: "pct",
    seq: 4,
    kind: "git.push",
    actor: nia,
    initiator: nia,
    project: "acme/web",
    target: "100%_done",
    summary: "Pushed 100%_done.",
    link: "note:not-a-url",
    at: 1_700_000_300_000,
  },
];

createRoot(document.getElementById("log")!).render(
  <ActivityPage
    entries={seed}
    onOpenSession={(id) => {
      document.getElementById("opened")!.textContent = id;
    }}
  />,
);

createRoot(document.getElementById("empty")!).render(<ActivityPage entries={[]} />);
