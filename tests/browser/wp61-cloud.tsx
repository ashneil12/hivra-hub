// WP-61. Settings for Hivra Cloud, and the existing Add machine form it fills in.
// The fake answers locally. It never contacts an address.
import { createRoot } from "react-dom/client";
import { ConnectionsSettings } from "../../src/features/connections/ui/ConnectionsSettings";
import { CloudSettings } from "../../src/features/hivraCloud/ui/CloudSettings";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

type Call = { command: string; args: Record<string, unknown> };

const calls: Call[] = [];
Object.assign(window, { __cloudCalls: calls });

type Status = {
  state: string;
  enabled: boolean;
  endpoint: string;
  revision: number;
  signedIn: boolean;
  message: string | null;
};

let status: Status = {
  state: "off",
  enabled: false,
  endpoint: "",
  revision: 0,
  signedIn: false,
  message: null,
};

installFakeTauri("wp61", (command, args) => {
  calls.push({ command, args: { ...args } });
  if (command === "hivra_cloud_status") return status;
  if (command === "hivra_cloud_save") {
    if (args.expectedRevision !== status.revision) {
      throw new Error("Hivra Cloud was changed somewhere else. Nothing was saved.");
    }
    const enabled = args.enabled === true;
    const endpoint = typeof args.endpoint === "string" ? args.endpoint.trim() : "";
    status = {
      state: !enabled ? "off" : endpoint === "" ? "no_endpoint" : "ready",
      enabled,
      endpoint,
      revision: status.revision + 1,
      signedIn: enabled ? status.signedIn : false,
      message: null,
    };
    return status;
  }
  if (command === "hivra_cloud_sign_in") {
    status = { ...status, state: "ready", signedIn: true };
    return status;
  }
  if (command === "hivra_cloud_sign_out") {
    status = { ...status, signedIn: false };
    return status;
  }
  if (command === "hivra_cloud_account") {
    return {
      status: "unavailable",
      plan: null,
      machineLimit: null,
      notice: "Hivra Cloud can't be reached right now. Your own machines still work.",
    };
  }
  if (command === "hivra_cloud_pair") {
    return { id: "m1", label: "Desk", sshHost: "me@cloud" };
  }
  if (command === "remote_machines") return [];
  return null;
});

createRoot(document.getElementById("root")!).render(
  <main style={{ maxWidth: 640, margin: "0 auto", padding: 24 }}>
    <CloudSettings />
    <div style={{ height: 28 }} />
    <ConnectionsSettings />
  </main>,
);
