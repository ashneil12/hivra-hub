/**
 * r72 (c): the webview's own `title` tooltip is a separate native window. PM's
 * blind r67 run saw one (a git command from a worker chat) stay on screen
 * after the view under it changed, because the element went away while the
 * pointer never "left" it. So the app draws its `title` tips itself: while an
 * element with a title is hovered its title is held aside (the native tip
 * never fires) and an in-page tip shows instead. The in-page tip goes the
 * moment its element leaves the page, the pointer leaves or presses, a key is
 * pressed, the page scrolls, or the window loses focus. The title comes back
 * when the pointer leaves, so markup and tests still see it.
 */
import { LAYER } from "./layers";

export const TITLE_TIP_DELAY_MS = 600;
const HELD = "data-hub-title-held";
const TIP = "data-hub-title-tip";

function elementOf(target: EventTarget | null): Element | null {
  const node = target as Node | null;
  if (!node || typeof node.nodeType !== "number") return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

export function installTitleTips(doc: Document = document): () => void {
  const win = doc.defaultView ?? window;
  let host: Element | null = null;
  let text = "";
  let tip: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watch: ReturnType<typeof setInterval> | undefined;
  let lastX = 0;
  let lastY = 0;

  function hideTip() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (watch !== undefined) clearInterval(watch);
    watch = undefined;
    tip?.remove();
    tip = null;
  }

  function release() {
    hideTip();
    if (host) {
      host.removeAttribute(HELD);
      if (host.isConnected && !host.hasAttribute("title") && text) {
        host.setAttribute("title", text);
      }
    }
    host = null;
    text = "";
  }

  /** React may set the title again while it is held; take it back. */
  function reHold() {
    if (!host) return;
    const again = host.getAttribute("title");
    if (again !== null) {
      text = again;
      host.removeAttribute("title");
      if (tip) tip.textContent = text;
    }
  }

  function showTip() {
    timer = undefined;
    if (!host || !host.isConnected || !text) return release();
    const el = doc.createElement("div");
    el.setAttribute(TIP, "");
    el.setAttribute("role", "tooltip");
    el.textContent = text;
    el.className =
      "solid-panel-glass pointer-events-none fixed max-w-[420px] whitespace-pre-wrap break-words rounded-md px-2 py-1 text-xs text-content/85";
    el.style.zIndex = String(LAYER.tip);
    el.style.left = `${Math.max(4, lastX + 10)}px`;
    el.style.top = `${Math.max(4, lastY + 18)}px`;
    doc.body.appendChild(el);
    const r = el.getBoundingClientRect();
    if (r.right > win.innerWidth - 4) {
      el.style.left = `${Math.max(4, win.innerWidth - 4 - r.width)}px`;
    }
    if (r.bottom > win.innerHeight - 4) {
      el.style.top = `${Math.max(4, lastY - 8 - r.height)}px`;
    }
    tip = el;
    // The element can leave the page with the pointer still on its spot.
    watch = setInterval(() => {
      if (!host || !host.isConnected) release();
      else reHold();
    }, 150);
  }

  function hold(el: Element) {
    host = el;
    text = el.getAttribute("title") ?? "";
    el.removeAttribute("title");
    el.setAttribute(HELD, "");
    timer = setTimeout(showTip, TITLE_TIP_DELAY_MS);
  }

  function onOver(event: MouseEvent) {
    lastX = event.clientX;
    lastY = event.clientY;
    const el = elementOf(event.target);
    if (!el) return;
    const held = el.closest(`[${HELD}]`);
    const titled = el.closest("[title]");
    // The innermost titled element wins, like the native tip.
    const next = titled && (!held || held.contains(titled)) ? titled : held;
    if (next === host) {
      reHold();
      return;
    }
    release();
    if (next) hold(next);
  }

  function onOut(event: MouseEvent) {
    if (!host) return;
    const to = elementOf(event.relatedTarget);
    if (to && host.contains(to)) return;
    release();
  }

  function onMove(event: MouseEvent) {
    lastX = event.clientX;
    lastY = event.clientY;
  }

  const opts = { capture: true, passive: true } as const;
  doc.addEventListener("mouseover", onOver, opts);
  doc.addEventListener("mouseout", onOut, opts);
  doc.addEventListener("mousemove", onMove, opts);
  doc.addEventListener("pointerdown", release, opts);
  doc.addEventListener("keydown", release, opts);
  doc.addEventListener("wheel", release, opts);
  doc.addEventListener("scroll", release, opts);
  doc.addEventListener("visibilitychange", release);
  win.addEventListener("blur", release);
  return () => {
    release();
    doc.removeEventListener("mouseover", onOver, opts);
    doc.removeEventListener("mouseout", onOut, opts);
    doc.removeEventListener("mousemove", onMove, opts);
    doc.removeEventListener("pointerdown", release, opts);
    doc.removeEventListener("keydown", release, opts);
    doc.removeEventListener("wheel", release, opts);
    doc.removeEventListener("scroll", release, opts);
    doc.removeEventListener("visibilitychange", release);
    win.removeEventListener("blur", release);
  };
}
