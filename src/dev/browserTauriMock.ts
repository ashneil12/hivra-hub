// Dev only: boots the real app in a plain browser (hub-dev.html) so the hub
// frontend can be run with vite and screenshotted. Never shipped.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

// Look like the Mac app (traffic-light space, ⌘ shortcuts).
Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });

// Example Monos for the hub's mock projects (real ones come from the store).
// Dev page: example data and no onboarding, unless ?onboarding is in the URL,
// which starts like a clean first launch (no projects, as the app ships).
if (new URLSearchParams(location.search).has("onboarding")) {
  if (!sessionStorage.getItem("hub-clean-start")) {
    sessionStorage.setItem("hub-clean-start", "1");
    for (const k of ["monocode:hub-examples", "monocode:hub-projects", "monocode:hub-templates", "monocode:hub-onboarded"]) localStorage.removeItem(k);
  }
} else {
  localStorage.setItem("monocode:hub-examples", "1");
  localStorage.setItem("monocode:hub-onboarded", "1");
}
if (localStorage.getItem("monocode:mono-roster") == null) {
  localStorage.setItem(
    "monocode:mono-roster",
    JSON.stringify([
      { id: "mono-invader", name: "MonoInvader", mascot: "invader", color: "hsl(211 92% 62%)", projects: ["/Users/ash/harness/exo-game"] },
      { id: "playtester", name: "Playtester", mascot: "ghost", color: "hsl(12 80% 58%)", projects: ["/Users/ash/harness/exo-game"] },
      { id: "chief-of-staff", name: "Chief of Staff", mascot: "robot", color: "hsl(210 8% 58%)", projects: ["/Users/ash/harness/exo-game", "/Users/ash/harness/hivra"] },
      { id: "projects-manager", name: "Projects Manager", mascot: "crab", color: "hsl(211 92% 62%)", projects: ["/Users/ash/harness/exo-game"] },
      { id: "design-critic", name: "Design critic", mascot: "mushroom", color: "hsl(12 80% 58%)", projects: ["/Users/ash/harness/exo-game"] },
      { id: "growth-lead", name: "Growth lead", mascot: "rocket", color: "hsl(211 92% 62%)", projects: ["/Users/ash/harness/hivra"] },
      { id: "hivra-mailer", name: "Hivra mailer", mascot: "cat", color: "hsl(210 8% 58%)", projects: ["/Users/ash/harness/hivra"] },
    ]),
  );
}

// Stand-in for the native macOS traffic lights.
window.addEventListener("DOMContentLoaded", () => {
  const lights = document.createElement("div");
  lights.setAttribute("aria-hidden", "true");
  lights.style.cssText = "position:fixed;left:14px;top:14px;display:flex;gap:8px;z-index:99999;pointer-events:none";
  for (const c of ["#ff5f57", "#febc2e", "#28c840"]) {
    const d = document.createElement("span");
    d.style.cssText = `width:12px;height:12px;border-radius:50%;background:${c}`;
    lights.appendChild(d);
  }
  document.body.appendChild(lights);

});

// DEV STAND-IN ONLY: a dim dark-blue "desktop" behind the window, plus the
// tint AppKit would paint over the vibrancy (base colour at the opacity the
// app asks for). On a Mac the real wallpaper and NSVisualEffectView do this.
type GlassArgs = { enabled?: boolean; background?: { r: number; g: number; b: number }; opacity?: number };
const DESKTOP = "radial-gradient(120% 90% at 30% 20%, #1b2a44 0%, #0f1a2e 45%, #070c16 100%)";
function emulateNativeGlass(a: GlassArgs | undefined) {
  const root = document.documentElement;
  if (!a?.enabled || !a.background) {
    root.style.background = "";
    return;
  }
  const { r, g, b } = a.background;
  const o = a.opacity ?? 0.91;
  root.style.background = `linear-gradient(rgb(${r} ${g} ${b} / ${o}), rgb(${r} ${g} ${b} / ${o})), ${DESKTOP}`;
  document.body.style.background = "transparent";
}

mockWindows("main");
const seen = new Set<string>();
mockIPC(
  (cmd, args) => {
    if (!seen.has(cmd)) {
      seen.add(cmd);
      (window as unknown as { __ipc: string[] }).__ipc = [...seen];
    }
    if (cmd === "set_window_glass_enabled") {
      emulateNativeGlass(args as GlassArgs);
      return true;
    }
    if (cmd === "plugin:path|resolve_directory" || cmd === "home_dir") return "/Users/ash";
    if (cmd.startsWith("plugin:event|")) return 1;
    if (cmd.includes("list") || cmd.includes("read_dir")) return [];
    return null;
  },
  { shouldMockEvents: true },
);
