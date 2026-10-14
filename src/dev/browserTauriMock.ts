// Dev only: boots the real app in a plain browser (hub-dev.html) so the hub
// frontend can be run with vite and screenshotted. Never shipped.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

// Look like the Mac app (traffic-light space, ⌘ shortcuts).
Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });

// Example Monos for the hub's mock projects (real ones come from the store).
if (localStorage.getItem("monocode:mono-roster") == null) {
  localStorage.setItem(
    "monocode:mono-roster",
    JSON.stringify([
      { id: "mono-invader", name: "MonoInvader", mascot: "invader", color: "hsl(211 92% 62%)", projects: ["/Users/ash/harness/exo-game"] },
      { id: "playtester", name: "Playtester", mascot: "ghost", color: "hsl(12 80% 58%)", projects: ["/Users/ash/harness/exo-game"] },
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

mockWindows("main");
const seen = new Set<string>();
mockIPC(
  (cmd) => {
    if (!seen.has(cmd)) {
      seen.add(cmd);
      (window as unknown as { __ipc: string[] }).__ipc = [...seen];
    }
    if (cmd === "plugin:path|resolve_directory" || cmd === "home_dir") return "/Users/ash";
    if (cmd.startsWith("plugin:event|")) return 1;
    if (cmd.includes("list") || cmd.includes("read_dir")) return [];
    return null;
  },
  { shouldMockEvents: true },
);
