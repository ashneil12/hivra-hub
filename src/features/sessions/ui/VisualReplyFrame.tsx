import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  FALLBACK_THEME,
  VISUAL_FRAME_PLACEHOLDER_HEIGHT,
  VISUAL_SANDBOX,
  VISUAL_THEME_MESSAGE,
  isVisualReadyMessage,
  networkNote,
  safeTheme,
  visualDocument,
  visualHeightFromMessage,
  visualThemeCss,
  type VisualTheme,
} from "../model/visualReply";
import {
  newFrameId,
  saveVisualReply,
  visualFrameDrop,
  visualFrameInApp,
  visualFrameKey,
  visualFrameUrl,
  type VisualFrameDeps,
} from "../model/visualFrame";

/** A served frame that has not sent its ready message by then did not load: its reply shows as source. */
export const VISUAL_READY_TIMEOUT_MS = 8000;

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
    // The first read happened while rendering; a theme change between then and this effect has no mutation left
    // to observe, so read once more now.
    pull();
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
 *
 * A reply runs only when the person runs it, or when `autoRun` says it was
 * written while this window watched (the agent's own live reply). A reply
 * loaded from history waits for a click, because the agent may have copied
 * its text from something it read.
 */
export function VisualReplyFrame({
  source,
  frames,
  autoRun,
}: {
  source: string;
  frames?: VisualFrameDeps;
  autoRun?: boolean;
}) {
  const theme = useVisualTheme();
  const inApp = visualFrameInApp(frames);
  const id = useRef<string | null>(null);
  const version = useRef(0);
  const [ranByPerson, setRanByPerson] = useState(false);
  const running = ranByPerson || autoRun === true;
  const [served, setServed] = useState<{ doc: string; url?: string } | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(VISUAL_FRAME_PLACEHOLDER_HEIGHT);
  const [showSource, setShowSource] = useState(false);
  const [network, setNetwork] = useState(false);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const [stalledUrl, setStalledUrl] = useState<string | null>(null);
  const servedUrl = served?.url ?? null;
  const servedUrlRef = useRef<string | null>(null);
  const doc = useMemo(
    () => visualDocument(source, theme, network),
    [source, theme, network],
  );

  useEffect(() => {
    if (!running || !doc || !inApp) return;
    let live = true;
    if (id.current === null) id.current = newFrameId(globalThis.crypto);
    // No source of randomness: no id, so no frame. The reply shows as source.
    if (id.current === null) {
      setServed({ doc });
      return;
    }
    const key = visualFrameKey(id.current, version.current++);
    void visualFrameUrl(key, doc, network, frames).then((url) => {
      if (live) setServed({ doc, url });
      else void visualFrameDrop(key, frames);
    });
    return () => {
      // Replaced or unmounted: the app's store lets this document go.
      live = false;
      void visualFrameDrop(key, frames);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `frames` is fixed for a frame
  }, [doc, network, inApp, running]);

  useEffect(() => {
    servedUrlRef.current = servedUrl;
    if (!servedUrl) return;
    const timer = setTimeout(() => setStalledUrl(servedUrl), VISUAL_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [servedUrl]);

  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      if (isVisualReadyMessage(event.data)) {
        setReadyUrl(servedUrlRef.current);
        return;
      }
      const next = visualHeightFromMessage(event.data);
      if (next != null) setHeight(next);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  // A frame that never said it loaded (its document was evicted, or the scheme refused it) shows the source instead.
  const stalled = servedUrl !== null && stalledUrl === servedUrl && readyUrl !== servedUrl;

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: VISUAL_THEME_MESSAGE, css: visualThemeCss(theme) },
      "*",
    );
  }, [theme]);

  const controls = (
    <div className="mb-2 flex flex-wrap gap-2">
      {doc && !running ? (
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs"
          onClick={() => setRanByPerson(true)}
        >
          Run visual reply
        </button>
      ) : null}
      {doc && running ? (
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
      {doc && running ? (
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
      {networkNote(network) && running ? (
        <p role="note" className="w-full text-xs">
          {networkNote(network)}
        </p>
      ) : null}
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

  if (!running) {
    return (
      <div data-visual-reply-frame>
        {controls}
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
      ) : served.url && !stalled ? (
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
