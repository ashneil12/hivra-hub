import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  FALLBACK_THEME,
  VISUAL_SANDBOX,
  visualDocument,
} from "../../src/features/sessions/model/visualReply";
import { VisualReplyFrame } from "../../src/features/sessions/ui/VisualReplyFrame";
import "../../src/styles/index.css";

// WP-130 proof fixture. Each reply tries one way out. None of that should work. Replies report to the top page:
// the shell passes on only a height from its guest.
// The navigation target is this dev server, so a slip would be a real page load.
const NAV_TARGET = `${window.location.origin}/hivra-visual-nav`;

const PROBE = `<p id="ok">probe</p>
<img src="https://example.invalid/hivra-visual-tag.png" alt="">
<iframe src="https://example.invalid/hivra-visual-frame.html"></iframe>
<script src="https://example.invalid/hivra-visual.js"></script>
<script>
var result = { type: "hivra-probe", dom: false, net: "pending", img: "pending" };
try { parent.document.title = "pwned"; result.dom = true; } catch (e) { result.dom = false; }
function report() { top.postMessage(result, "*"); }
report();
var img = new Image();
img.onload = function () { result.img = "open"; report(); };
img.onerror = function () { result.img = "blocked"; report(); };
img.src = "https://example.invalid/hivra-visual-img.png";
var pixel = new Image();
pixel.onload = function () { result.dataImg = "shown"; report(); };
pixel.onerror = function () { result.dataImg = "blocked"; report(); };
pixel.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
fetch("https://example.invalid/hivra-visual-fetch").then(function () { result.net = "open"; report(); }).catch(function () { result.net = "blocked"; report(); });
setTimeout(function () {
  result.late = true;
  if (result.net === "pending") result.net = "blocked";
  if (result.img === "pending") result.img = "blocked";
  report();
}, 800);
</script>`;

const NAV = `<p>nav</p><script>
var target = ${JSON.stringify(NAV_TARGET)};
top.postMessage({ type: "hivra-nav", step: "ready" }, "*");
var link = document.createElement("a");
link.href = target;
document.body.appendChild(link);
link.click();
try { location.href = target; } catch (e) { top.postMessage({ type: "hivra-nav", step: "threw" }, "*"); }
top.postMessage({ type: "hivra-nav", step: "after", href: String(location.href) }, "*");
setTimeout(function () {
  top.postMessage({ type: "hivra-nav", step: "late", href: String(location.href) }, "*");
}, 800);
</script>`;

const META = `<script>
top.postMessage({ type: "hivra-meta", step: "ready" }, "*");
setTimeout(function () { top.postMessage({ type: "hivra-meta", step: "late" }, "*"); }, 500);
</script>
<meta http-equiv="refresh" content="0;url=${NAV_TARGET}">`;

const FORM = `<form action="${NAV_TARGET}" method="get"><input name="q" value="secret"></form>
<script>
top.postMessage({ type: "hivra-form", step: "ready" }, "*");
try { document.forms[0].submit(); } catch (e) { top.postMessage({ type: "hivra-form", step: "threw" }, "*"); }
setTimeout(function () { top.postMessage({ type: "hivra-form", step: "late" }, "*"); }, 500);
</script>`;

const BREAKOUT = `</script><script>try { parent.document.title = "pwned"; } catch (e) {}</script>`;

function Frame({ source, label }: { source: string; label: string }) {
  const srcDoc = visualDocument(source, FALLBACK_THEME, false);
  if (!srcDoc) return <p>Could not build the frame.</p>;
  return (
    <iframe
      title={label}
      sandbox={VISUAL_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      data-visual-reply={label}
      style={{ width: "100%", height: 120, border: 0 }}
    />
  );
}

function Page() {
  const [probe, setProbe] = useState("waiting");
  const [nav, setNav] = useState("waiting");
  const [meta, setMeta] = useState("waiting");
  const [form, setForm] = useState("waiting");
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown } | null;
      if (!data || typeof data.type !== "string") return;
      const text = JSON.stringify(data);
      if (data.type === "hivra-probe") setProbe(text);
      if (data.type === "hivra-nav") setNav(text);
      if (data.type === "hivra-meta") setMeta(text);
      if (data.type === "hivra-form") setForm(text);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <main>
      <h1>Visual replies</h1>
      <p data-probe={probe}>{probe}</p>
      <p data-nav={nav}>{nav}</p>
      <p data-meta={meta}>{meta}</p>
      <p data-form={form}>{form}</p>
      <Frame source={PROBE} label="probe" />
      <Frame source={NAV} label="nav" />
      <Frame source={META} label="meta" />
      <Frame source={FORM} label="form" />
      <Frame source={BREAKOUT} label="breakout" />
      <div data-themed-reply>
        <VisualReplyFrame source={'<p id="themed">chart</p>'} autoRun />
      </div>
    </main>
  );
}

document.title = "Hivra visual";
createRoot(document.getElementById("root")!).render(<Page />);
