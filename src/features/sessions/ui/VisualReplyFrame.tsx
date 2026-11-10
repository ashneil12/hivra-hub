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
import {
  saveVisualReply,
  visualFrameInApp,
  visualFrameKey,
  visualFrameUrl,
  type VisualFrameDeps,
} from "../model/visualFrame";

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
 * are posted in so a frame that is still loading picks them up. In the app the
 * shell is served from the app's frame scheme with its own policy (a srcdoc
 * there would inherit the app's policy and the reply's script would not run).
 * `frames` is for the browser proofs, which stand in for the app.
 */
function frameId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function VisualReplyFrame({
  source,
  frames,
}: {
  source: string;
  frames?: VisualFrameDeps;
}) {
  const theme = useVisualTheme();
  const inApp = visualFrameInApp(frames);
  const id = useRef<string | null>(null);
  const version = useRef(0);
  const [served, setServed] = useState<{ doc: string; url?: string } | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(VISUAL_FRAME_PLACEHOLDER_HEIGHT);
  const [showSource, setShowSource] = useState(false);
  const [network, setNetwork] = useState(false);
  const doc = useMemo(
    () => visualDocument(source, theme, network),
    [source, theme, network],
  );

  useEffect(() => {
    if (!doc || !inApp) return;
    let live = true;
    if (id.current === null) id.current = frameId();
    const key = visualFrameKey(id.current, version.current++);
    void visualFrameUrl(key, doc, network, frames).then((url) => {
      if (live) setServed({ doc, url });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `frames` is fixed for a frame
  }, [doc, network, inApp]);

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

  const controls = (
    <div className="mb-2 flex flex-wrap gap-2">
      {doc ? (
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs"
          onClick={() => setShowSource((current) => !current)}
        >
          {showSource ? "Show visual" : "Show source"}
        </button>
      ) : null}
      <button
        type="button"
        className="rounded-md px-2 py-1 text-xs"
        onClick={() => {
          setSaveNote(null);
          void saveVisualReply(source).then((result) => {
            if (result === "failed") setSaveNote("Could not save the file.");
          });
        }}
      >
        Save as file
      </button>
      {doc ? (
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs"
          aria-pressed={network}
          onClick={() => setNetwork((current) => !current)}
        >
          Allow network
        </button>
      ) : null}
      {saveNote ? <span className="px-2 py-1 text-xs">{saveNote}</span> : null}
    </div>
  );

  if (!doc) {
    return (
      <div data-visual-reply-frame>
        {controls}
        <p>This reply is too big to show here.</p>
        <pre>{source}</pre>
      </div>
    );
  }

  return (
    <div data-visual-reply-frame>
      {controls}
      {showSource ? (
        <pre>{source}</pre>
      ) : !inApp ? (
        <iframe
          ref={frameRef}
          title="Visual reply"
          sandbox={VISUAL_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={doc}
          style={{ width: "100%", height, border: 0 }}
        />
      ) : served?.doc !== doc ? (
        <div data-visual-reply-loading style={{ width: "100%", height }} />
      ) : served.url ? (
        <iframe
          key={served.url}
          ref={frameRef}
          title="Visual reply"
          sandbox={VISUAL_SANDBOX}
          referrerPolicy="no-referrer"
          src={served.url}
          data-visual-reply-src
          style={{ width: "100%", height, border: 0 }}
        />
      ) : (
        <>
          <p>This reply could not be shown here.</p>
          <pre>{source}</pre>
        </>
      )}
    </div>
  );
}
