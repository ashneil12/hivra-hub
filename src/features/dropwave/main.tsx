// Entry for the Dropwave preview page (dropwave.html, `npm run dropwave:build`).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DropwaveApp } from "./DropwaveApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DropwaveApp />
  </StrictMode>,
);
