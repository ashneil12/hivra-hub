import "./macPlatform";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FinderHost } from "../../src/features/search/ui/FinderHost";
import type { PaletteContext, PaletteRow } from "../../src/features/search/model/commandRegistry";
import { runPaletteRow, type PaletteRunHandlers } from "../../src/features/search/model/paletteRun";
import { resolveAppShortcut } from "../../src/features/settings/model/appShortcuts";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

// WP-93. The real palette, the real registry and the real runner, with a fake
// Tauri so the file index answers at once. App does what this fixture does:
// hand the registry what the app can do now, and map each run name to the
// handler the matching shortcut already calls.
const PROJECT = "/work/proj";

installFakeTauri("command-palette", (command) => {
  if (command === "list_project_files") return [];
  return null;
});

const READY: PaletteContext = {
  project: PROJECT,
  terminal: true,
  chat: true,
  busy: false,
  terminalFocus: false,
  pickerFocus: false,
  editor: false,
};

const NOTHING: PaletteContext = {
  project: null,
  terminal: false,
  chat: false,
  busy: false,
  terminalFocus: false,
  pickerFocus: false,
  editor: false,
};

function PaletteFixture() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState(0);
  const [ran, setRan] = useState<string[]>([]);
  const [context, setContext] = useState<PaletteContext>(READY);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (resolveAppShortcut(event) !== "App: Command Palette") return;
      event.preventDefault();
      event.stopPropagation();
      setToken((current) => current + 1);
      setOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const onRunCommand = (row: PaletteRow) => {
    const handlers: PaletteRunHandlers = {
      tab: (action) => setRan((current) => [...current, `tab:${action}`]),
      app: (action) => setRan((current) => [...current, `app:${action}`]),
      zoom: (action) => setRan((current) => [...current, `zoom:${action}`]),
      editor: (action) => setRan((current) => [...current, `editor:${action}`]),
    };
    setRan((current) =>
      runPaletteRow(row, handlers) ? current : [...current, `blocked:${row.id}`],
    );
  };

  // The palette reads the app on the render that opens it, so a test that wants
  // a command greyed changes the context before opening, never behind it.
  return (
    <div>
      <p data-runs>{ran.join(",")}</p>
      <button
        type="button"
        data-no-project
        onClick={() => setContext(NOTHING)}
      >
        Close the project
      </button>
      <button type="button" data-ready onClick={() => setContext(READY)}>
        Open the project
      </button>
      {open ? (
        <FinderHost
          key={token}
          finder
          open
          cwd={PROJECT}
          initialQuery=">"
          history={[]}
          sessions={[]}
          recents={[{ path: PROJECT, openedAt: 1 }]}
          onOpenFile={() => undefined}
          onRunAction={() => undefined}
          paletteContext={context}
          onRunCommand={onRunCommand}
          onClose={() => setOpen(false)}
          onOpenHit={() => undefined}
        />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<PaletteFixture />);
