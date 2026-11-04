import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CrewRulesPage } from "../../src/features/crew/ui/CrewRulesPage";
import "../../src/styles/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrewRulesPage
      initial={{
        rules: [],
        plugins: [{ labels: ["ui"], paths: [], cli: "cursor", effort: "medium" }],
        signedIn: [{ cli: "claude", installed: true, signedIn: true }],
      }}
    />
  </StrictMode>,
);
