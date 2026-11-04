import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GrokRetirementNote } from "../../src/features/sessions/ui/GrokRetirementNote";
import { retireGrokLauncherOnce } from "../../src/features/sessions/model/grokRetirement";
import "../../src/styles/index.css";

// WP-16: the same clear the app runs at boot, against this page's localStorage.
retireGrokLauncherOnce(localStorage);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GrokRetirementNote />
  </StrictMode>,
);
