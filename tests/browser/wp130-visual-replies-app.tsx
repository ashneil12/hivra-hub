import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import conf from "../../src-tauri/tauri.conf.json";
import { VisualReplyFrame } from "../../src/features/sessions/ui/VisualReplyFrame";
import "../../src/styles/index.css";

// WP-130 proof page that stands in for the app window: it carries the app's own content security policy (read from
// tauri.conf.json), Tauri's globals with a secret in them, and a theme. A frame under this page inherits the app's
// policy if it is a srcdoc, so this is where "the reply's script never runs in the app" shows. The spec serves the
// frame scheme (http://monoartifact.localhost) with the policy the app serves.

declare global {
  interface Window {
    __visualFrames: Record<string, { html: string; network: boolean }>;
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
    __forgetProbe?: (label: string) => void;
  }
}

const ORIGIN = window.location.origin;
const SECRET = "tauri-secret-7f3a";
window.__TAURI__ = { secret: SECRET };
window.__TAURI_INTERNALS__ = { invoke: () => SECRET, secret: SECRET };
window.__visualFrames = {};
document.cookie = "hivra-app=cookie-secret; path=/";

const root = document.documentElement;
root.classList.add("theme-light");
root.style.setProperty("--color-background-base", "#123456");
root.style.setProperty("--color-content", "#abcdef");
root.style.setProperty("--font-sans", "Theme Sans");
root.style.setProperty("--font-mono", "Theme Mono");

const policy = document.createElement("meta");
policy.httpEquiv = "Content-Security-Policy";
policy.content = conf.app.security.csp;
document.head.appendChild(policy);

/** Tries every way out of the frame and reports to the top page. */
function probe(label: string): string {
  const targets = [
    `${ORIGIN}/hivra-visual-local`,
    "http://127.0.0.1:9/hivra-visual-local",
    "file:///etc/hosts",
    "asset://localhost/etc/hosts",
    "http://asset.localhost/etc/hosts",
    "https://asset.localhost/etc/hosts",
    "ipc://localhost/plugin",
    "http://ipc.localhost/plugin",
    "/hivra-visual-relative",
    "hivra-visual-relative.png",
    "https://example.invalid/hivra-visual-remote",
    // Known limit: `https:` also names this machine and the local network. Off, these fail; on, they open (the doc says so).
    "https://127.0.0.1/hivra-visual-local",
    "https://localhost/hivra-visual-local",
  ];
  return `<p>probe ${label}</p><script>
(function () {
  var r = { type: "hivra-app-probe", label: ${JSON.stringify(label)}, ran: true, violations: [], loads: {} };
  document.addEventListener("securitypolicyviolation", function (e) { r.violations.push(String(e.blockedURI)); });
  function send() { try { top.postMessage(JSON.parse(JSON.stringify(r)), "*"); } catch (e) {} }
  function reach(name, f) { try { r[name] = String(f()); } catch (e) { r[name] = "blocked"; } }
  r.tauri = [typeof window.__TAURI__, typeof window.__TAURI_INTERNALS__, typeof window.__TAURI_IPC__, typeof window.ipc].join("/");
  reach("parentTauri", function () { return typeof parent.__TAURI_INTERNALS__; });
  reach("topTauri", function () { return typeof top.__TAURI_INTERNALS__; });
  reach("topSecret", function () { return top.__TAURI_INTERNALS__.invoke(); });
  reach("topTitle", function () { return top.document.title; });
  reach("parentTitle", function () { return parent.document.title; });
  reach("storage", function () { return localStorage.length; });
  reach("cookie", function () { return document.cookie; });
  reach("popup", function () { return window.open(${JSON.stringify(`${ORIGIN}/hivra-visual-popup`)}) === null ? "none" : "open"; });
  try { top.location.href = ${JSON.stringify(`${ORIGIN}/hivra-visual-topnav`)}; } catch (e) {}
  r.origin = String(self.origin);
  var cs = getComputedStyle(document.documentElement);
  r.bg = cs.backgroundColor; r.color = cs.color; r.font = cs.fontFamily;
  parent.postMessage({ type: "hivra-forward-test" }, "*");
  var targets = ${JSON.stringify(targets)};
  var pending = targets.length * 2, finished = false;
  function finish() { if (finished) return; finished = true; setTimeout(function () { r.done = true; send(); }, 400); }
  function done() { pending -= 1; if (pending === 0) finish(); }
  targets.forEach(function (t) {
    try {
      fetch(t).then(function () { r.loads["fetch " + t] = "open"; }, function () { r.loads["fetch " + t] = "failed"; }).then(done);
    } catch (e) { r.loads["fetch " + t] = "failed"; done(); }
    var img = new Image();
    img.onload = function () { r.loads["img " + t] = "open"; done(); };
    img.onerror = function () { r.loads["img " + t] = "failed"; done(); };
    img.src = t;
  });
  // The spec waits for every load to settle; this is only a backstop for a load that never settles.
  setTimeout(finish, 30000);
  send();
})();
</script>`;
}

const frames = {
  inApp: true,
  put: async (key: string, html: string, network: boolean) => {
    window.__visualFrames[key] = { html, network };
    return `page-${key}`;
  },
  url: (path: string) => `http://monoartifact.localhost/${path}`,
};

// A served key the scheme does not hold: the frame gets a 404 and never says it loaded.
const missing = {
  inApp: true,
  put: async (key: string) => `page-${key}`,
  url: (path: string) => `http://monoartifact.localhost/${path}-missing`,
};

function Page() {
  const [probes, setProbes] = useState<Record<string, unknown>>({});
  const [forwarded, setForwarded] = useState(0);
  useEffect(() => {
    window.__forgetProbe = (label: string) =>
      setProbes((current) => {
        const next = { ...current };
        delete next[label];
        return next;
      });
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; label?: unknown } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "hivra-app-probe" && typeof data.label === "string") {
        const label = data.label;
        setProbes((current) => ({ ...current, [label]: data }));
      }
      const outer = [...document.querySelectorAll("iframe")].some((frame) => frame.contentWindow === event.source);
      // The shell passes on only a height from its guest. Its own ready message is not forwarded, so it is not counted.
      if (outer && data.type !== "hivra:visual-height" && data.type !== "hivra:visual-ready") setForwarded((n) => n + 1);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <main>
      <h1>Visual replies in the app</h1>
      <pre data-probes={JSON.stringify(probes)} data-forwarded={forwarded} />
      <div data-reply="restored">
        <VisualReplyFrame source={probe("restored")} frames={frames} />
      </div>
      <div data-reply="served">
        <VisualReplyFrame source={probe("served")} frames={frames} autoRun />
      </div>
      <div data-reply="net">
        <VisualReplyFrame source={probe("net")} frames={frames} autoRun />
      </div>
      <div data-reply="srcdoc">
        <VisualReplyFrame source={probe("srcdoc")} frames={{ inApp: false }} autoRun />
      </div>
      <div data-reply="missing">
        <VisualReplyFrame source={'<p id="missing-source">the source stays</p>'} frames={missing} autoRun />
      </div>
    </main>
  );
}

document.title = "Hivra app";
createRoot(document.getElementById("root")!).render(<Page />);
