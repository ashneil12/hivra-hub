import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CrewDefaults } from "../../src/features/crew/ui/CrewDefaults";
import { setHarnessModels } from "../../src/features/sessions/model/models";
import "../../src/styles/index.css";

setHarnessModels("claude", [
  {
    id: "claude:sonnet-5",
    harness: "claude",
    name: "Claude Sonnet 5",
    settings: [],
  },
]);

const signedIn = [
  { cli: "claude", installed: true, signedIn: true },
  { cli: "codex", installed: true, signedIn: true },
  { cli: "grok", installed: true, signedIn: true },
  { cli: "pi", installed: false, signedIn: false },
];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrewDefaults
      cwd="/work/app"
      projectId="vg-app"
      initial={{
        policy: { lockDefault: false, neverUse: [], fallback: [] },
        rules: [],
        revision: 1,
        signedIn,
        policyUnreadable: new URLSearchParams(window.location.search).has("unreadable"),
      }}
    />
  </StrictMode>,
);
