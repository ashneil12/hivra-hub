import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  FALLBACK_THEME,
  VISUAL_FRAME_PLACEHOLDER_HEIGHT,
  VISUAL_SANDBOX,
  VISUAL_THEME_MESSAGE,
  safeTheme,
  visualDocument,
  visualHeightFromMessage,
  visualThemeCss,
  type VisualTheme,
} from "../model/visualReply";

/**
 * Colors and fonts from the open page. A visual reply cannot see the app's
 * variables, so these are resolved to concrete values first. Anything odd
 * falls back inside `safeTheme`.
 */
export function readVisualTheme(): VisualTheme {
  if (typeof document === "undefined" || !document.body) return FALLBACK_THEME;
  const root = document.documentElement;
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolve = (value: string) => {
    probe.style.color = value;
    return getComputedStyle(probe).color;
  };
  const style = getComputedStyle(root);
  const theme = safeTheme({
    scheme: root.classList.contains("theme-light") ? "light" : "dark",
    background: resolve("var(--color-background-base)"),
    text: resolve("var(--color-content)"),
    font: style.getPropertyValue("--font-sans"),
    mono: style.getPropertyValue("--font-mono"),
  });
  probe.remove();
  return theme;
}

function useVisualTheme(): VisualTheme {
  const [theme, setTheme] = useState(readVisualTheme);
  useEffect(() => {
    const pull = () => {
      const next = readVisualTheme();
      setTheme((current) =>
        visualThemeCss(current) === visualThemeCss(next) ? current : next,
      );
    };
    const observer = new MutationObserver(pull);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/**
 * One visual reply. The guest policy and the shell live in `visualDocument`.
 * A theme change rebuilds the frame with the new colors, and the same colors
 * are posted in so a frame that is still loading picks them up.
 */
export function VisualReplyFrame({ source }: { source: string }) {
  const theme = useVisualTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(VISUAL_FRAME_PLACEHOLDER_HEIGHT);
  const doc = useMemo(() => visualDocument(source, theme, false), [source, theme]);

  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const next = visualHeightFromMessage(event.data);
      if (next != null) setHeight(next);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: VISUAL_THEME_MESSAGE, css: visualThemeCss(theme) },
      "*",
    );
  }, [theme]);

  if (!doc) {
    return (
      <div data-visual-reply-frame>
        <p>This reply is too big to show here.</p>
        <pre>{source}</pre>
      </div>
    );
  }

  return (
    <div data-visual-reply-frame>
      <iframe
        ref={frameRef}
        title="Visual reply"
        sandbox={VISUAL_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={doc}
        style={{ width: "100%", height, border: 0 }}
      />
    </div>
  );
}
