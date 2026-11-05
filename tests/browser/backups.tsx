import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BackupsPage, type BackupsFixture } from "../../src/features/backups/ui/BackupsPage";
import "../../src/styles/index.css";

const when = Date.UTC(2026, 10, 4, 12);

const sample: BackupsFixture = {
  status: {
    schedule: "daily",
    folder: "/tmp/hivra backups",
    folderIsDefault: true,
    lastGood: { id: "b1", createdAt: when },
    dev: false,
  },
  backups: [{ id: "b1", createdAt: when }],
  items: { b1: [{ kind: "chat", id: "c1", title: "Ship plan" }] },
};

const empty: BackupsFixture = {
  status: {
    schedule: "off",
    folder: "/tmp/hivra backups",
    folderIsDefault: true,
    lastGood: null,
    dev: false,
  },
  backups: [],
  items: {},
};

const fixture = new URLSearchParams(window.location.search).has("empty") ? empty : sample;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BackupsPage fixture={fixture} />
  </StrictMode>,
);
