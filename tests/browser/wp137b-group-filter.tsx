import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  SHOW_ONLY_GROUP_LABEL,
  saveShowOnlyGroup,
  useShowOnlyGroup,
} from "../../src/features/settings/model/displayPrefs";
import {
  GroupFilterRail,
  type GroupFilterItem,
} from "../../src/features/projects/ui/GroupFilterRail";
import "../../src/styles/index.css";

const pinned: GroupFilterItem[] = [
  { id: "pin-old", label: "Pin old", groupId: "work" },
  { id: "pin-new", label: "Pin new", groupId: "home" },
];

const groups = [
  {
    id: "work",
    name: "Work",
    items: [
      { id: "alpha", label: "Alpha", groupId: "work" },
      { id: "beta", label: "Beta", groupId: "work" },
    ] as GroupFilterItem[],
  },
  {
    id: "home",
    name: "Home",
    items: [{ id: "delta", label: "Delta", groupId: "home" }] as GroupFilterItem[],
  },
  { id: "empty", name: "Empty", items: [] as GroupFilterItem[] },
];

const ungrouped: GroupFilterItem[] = [{ id: "gamma", label: "Gamma", groupId: null }];

function Page() {
  const enabled = useShowOnlyGroup();
  const [dropWork, setDropWork] = useState(false);
  const listed = dropWork ? groups.filter((group) => group.id !== "work") : groups;
  const loose = dropWork ? [...groups[0].items, ...ungrouped] : ungrouped;
  return (
    <div className="text-content">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={SHOW_ONLY_GROUP_LABEL}
        onClick={() => saveShowOnlyGroup(!enabled)}
      >
        {SHOW_ONLY_GROUP_LABEL}
      </button>
      <button type="button" onClick={() => setDropWork(true)}>
        Remove Work
      </button>
      <GroupFilterRail pinned={pinned} groups={listed} ungrouped={loose} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
