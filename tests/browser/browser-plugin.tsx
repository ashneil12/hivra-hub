// Browser proof for WP-43: Stop, and a profile per agent. The Tauri bridge is faked.
import { installFakeTauri } from "./fakeTauri";
import "../../src/styles/index.css";

type Drive = { id: string; agentId: string; name: string };
type Profile = { id: string; name: string; watch: boolean; own: boolean; path: string };

let drives: Drive[] = [
  { id: "drive-ada", agentId: "mono-ada", name: "Ada" },
  { id: "drive-milo", agentId: "mono-milo", name: "Milo" },
];

let profiles: Profile[] = [
  { id: "mono-ada", name: "Ada", watch: false, own: false, path: "/data/browser-profiles/mono-ada" },
  { id: "mono-milo", name: "Milo", watch: true, own: true, path: "/Users/ash/browsers/milo" },
];

const deleted: string[] = [];

installFakeTauri("main", (command, args) => {
  const params = new URLSearchParams(window.location.search);
  if (command === "browser_engine") {
    if (params.get("node") === "missing") {
      return { chrome: true, message: "Node couldn't be found." };
    }
    return params.get("chrome") === "missing"
      ? { chrome: false, message: "Google Chrome isn't installed." }
      : { chrome: true, message: "This uses Google Chrome." };
  }
  if (command === "browser_get_browser") {
    document.body.dataset.getBrowser = "1";
    return null;
  }
  if (command === "browser_drives") return drives;
  if (command === "browser_stop") {
    drives = drives.filter((drive) => drive.id !== args.id);
    return null;
  }
  if (command === "browser_stop_all") {
    drives = [];
    return null;
  }
  if (command === "browser_profiles") return profiles;
  if (command === "browser_clear") {
    const id = String(args.agentId);
    const row = profiles.find((profile) => profile.id === id);
    if (row && !row.own) deleted.push(row.path);
    profiles = profiles.filter((profile) => profile.id !== id);
    document.body.dataset.cleared = id;
    document.body.dataset.deleted = deleted.join(",");
    return profiles;
  }
  if (command === "browser_watch") {
    profiles = profiles.map((profile) =>
      profile.id === args.agentId ? { ...profile, watch: args.watch === true } : profile,
    );
    document.body.dataset.watched = JSON.stringify({ id: args.agentId, watch: args.watch === true });
    return profiles;
  }
  if (command === "browser_choose_own") {
    const id = String(args.agentId);
    const path = String(args.path ?? "");
    document.body.dataset.chosen = JSON.stringify({ id, path });
    profiles = profiles.map((profile) => (profile.id === id ? { ...profile, own: true, path } : profile));
    return profiles;
  }
  throw new Error(`Unavailable fixture service ${command}`);
});

const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { DrivingBar } = await import("../../src/features/browser/ui/DrivingBar");
const { BrowserProfiles } = await import("../../src/features/browser/ui/BrowserProfiles");
const root = document.getElementById("root");
if (root) createRoot(root).render(createElement("div", null, createElement(DrivingBar), createElement(BrowserProfiles)));
