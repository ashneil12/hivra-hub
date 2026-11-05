import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { readAppIdentity, type AppIdentity } from "../../src/app/model/appIdentity";
import { DevRibbon } from "../../src/app/shell/DevRibbon";
import { BuildStampFooter } from "../../src/features/settings/ui/SettingsView";
import { HubOnboarding } from "../../src/features/hub/ui/HubOnboarding";
import "../../src/styles/index.css";

const SHA = "09141d88a1b2c3d4e5f60718293a4b5c6d7e8f90";

function identity(kind: "daily" | "dev"): AppIdentity {
  const value = readAppIdentity({
    product: kind === "dev" ? "MonoCode Hub Dev" : "MonoCode Hub",
    version: "0.16.0",
    identifier: kind === "dev" ? "com.ash.monocode-hub.dev.wt-a" : "com.ash.monocode-hub",
    kind,
    slot: kind === "dev" ? "wt-a" : null,
    stamp: { sha: SHA, branch: "hub/1b-identity", dirty: true, builtAt: "2026-10-19T21:04:05Z" },
    schemaVersion: 19,
    policy: {},
  });
  if (!value) throw new Error("identity");
  return value;
}

localStorage.setItem("monocode:hub-onboarded", "1");

function Fixture() {
  return (
    <div>
      <div data-daily-footer>
        <BuildStampFooter identity={identity("daily")} />
      </div>
      <div data-dev-footer>
        <BuildStampFooter identity={identity("dev")} />
      </div>
      <DevRibbon identity={identity("dev")} />
      <HubOnboarding onClose={() => {}} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
