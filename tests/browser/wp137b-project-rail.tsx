import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectRail } from "../../src/app/shell/ProjectRail";
import {
  SHOW_ONLY_GROUP_LABEL,
  saveShowOnlyGroup,
  useShowOnlyGroup,
} from "../../src/features/settings/model/displayPrefs";
import {
  loadProjectGroups,
  saveProjectGroups,
} from "../../src/features/projects/model/projectGroups";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

// WP-137b: the real project rail, with the webview's own commands answered
// by nothing. The page only seeds recents; the rail builds every row itself.
installFakeTauri("main", () => null);

// What a person does in the group menu or in another window: delete a group.
Object.assign(window, {
  removeGroup: (id: string) =>
    saveProjectGroups(loadProjectGroups().filter((group) => group.id !== id)),
});

const allRecents = [
  { path: "/work/alpha", openedAt: 1 },
  { path: "/work/beta", openedAt: 2 },
  { path: "/work/gamma", openedAt: 3 },
  { path: "/work/delta", openedAt: 4 },
];

function Page() {
  const enabled = useShowOnlyGroup();
  const [withHub, setWithHub] = useState(false);
  return (
    <div className="flex text-content" style={{ height: "100vh" }}>
      <div className="flex flex-col gap-1 p-2">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={SHOW_ONLY_GROUP_LABEL}
          onClick={() => saveShowOnlyGroup(!enabled)}
        >
          {SHOW_ONLY_GROUP_LABEL}
        </button>
        <button type="button" onClick={() => setWithHub(true)}>
          Use hub list
        </button>
      </div>
      <ProjectRail
        cwd="/work/alpha"
        recents={allRecents}
        onSelectProject={() => {}}
        onOpenProject={() => {}}
        hubItems={withHub ? <div data-hub-items="">Hub list</div> : undefined}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
