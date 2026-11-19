import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_THEME,
  VISUAL_FRAME_MAX_BYTES,
  VISUAL_FRAME_MAX_HEIGHT,
  VISUAL_FRAME_MIN_HEIGHT,
  VISUAL_HEIGHT_MESSAGE,
  VISUAL_READY_MESSAGE,
  VISUAL_REPLY_MAX_BYTES,
  VISUAL_SANDBOX,
  isVisualReadyMessage,
  networkNote,
  visualBytes,
  visualCsp,
  visualFrameCsp,
  visualDocument,
  visualFenceMark,
  visualHeightFromMessage,
  visualThemeCss,
} from "./visualReply";

const MARKER = "parent.document.title='pwned'";

describe("visual reply sandbox", () => {
  it("gives the frame scripts and nothing else", () => {
    expect(VISUAL_SANDBOX).toBe("allow-scripts");
    expect(VISUAL_SANDBOX).not.toContain("allow-same-origin");
    expect(VISUAL_SANDBOX).not.toContain("allow-popups");
    expect(VISUAL_SANDBOX).not.toContain("allow-forms");
    expect(VISUAL_SANDBOX).not.toContain("allow-downloads");
    expect(VISUAL_SANDBOX).not.toContain("allow-top-navigation");
    expect(VISUAL_SANDBOX).not.toContain("allow-modals");
  });

  it("blocks the network, remote scripts, frames, forms and navigation by default", () => {
    const csp = visualCsp(false);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).not.toContain("https:");
    expect(csp).not.toContain("http:");
    expect(csp).not.toContain("*");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("child-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("navigate-to");
    expect(csp).not.toContain('"');
  });

  it("keeps remote scripts, frames, forms and navigation blocked when network is allowed", () => {
    const csp = visualCsp(true);
    expect(csp).toContain("connect-src https: wss:");
    expect(csp).toContain("img-src data: blob: https:");
    expect(csp).toContain("font-src data: https:");
    expect(csp).toContain("media-src data: blob: https:");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).not.toMatch(/script-src[^;]*https:/);
    expect(csp).not.toMatch(/style-src[^;]*https:/);
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("navigate-to");
    expect(csp).not.toContain("*");
  });

  it("puts the locked policy ahead of a payload that tries to close the document", () => {
    const payload = `</head><meta http-equiv="Content-Security-Policy" content="default-src *"><script>${MARKER}</script>`;
    const doc = visualDocument(payload, FALLBACK_THEME, false);
    expect(doc).not.toBeNull();
    const cspAt = doc!.indexOf("connect-src 'none'");
    const payloadAt = doc!.indexOf(MARKER);
    expect(cspAt).toBeGreaterThan(-1);
    expect(payloadAt).toBeGreaterThan(cspAt);
    expect(doc).not.toContain("allow-same-origin");
    expect(doc).toContain('content="default-src \'none\'');
  });

  it("does not let a null byte cut the policy off the page", () => {
    const doc = visualDocument(
      `before\u0000after<p id="keep">z</p>`,
      FALLBACK_THEME,
      false,
    );
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain("<p id=&quot;keep&quot;>z</p>");
    expect(doc).not.toContain("\u0000");
  });

  it("refuses a reply over the size cap and does not return the payload", () => {
    const big = "a".repeat(VISUAL_REPLY_MAX_BYTES + 1);
    expect(visualDocument(big, FALLBACK_THEME, false)).toBeNull();
    const exact = "b".repeat(VISUAL_REPLY_MAX_BYTES);
    expect(visualDocument(exact, FALLBACK_THEME, false)).toContain(exact);
  });

  it("rejects a source that is not text", () => {
    expect(visualDocument(undefined as unknown as string, FALLBACK_THEME, false)).toBeNull();
    expect(visualDocument(null as unknown as string, FALLBACK_THEME, false)).toBeNull();
  });

  it("drops theme values that could break out of the style block", () => {
    const doc = visualDocument("<p>chart</p>", {
      scheme: "light",
      background: "red;}</style><script>1</script>",
      text: "rgb(1, 2, 3)",
      font: '"Test Sans", sans-serif',
      mono: "url(https://example.invalid/font.woff)",
    }, false);
    expect(doc).toContain("--hivra-background:#111111");
    expect(doc).toContain("--hivra-text:rgb(1, 2, 3)");
    expect(doc).toContain("--hivra-font:&quot;Test Sans&quot;, sans-serif");
    expect(doc).toContain("--hivra-mono:ui-monospace, monospace");
    expect(doc).toContain("color-scheme:light");
    expect(doc).not.toContain("</style><script>1");
    expect(doc).not.toContain("example.invalid");
  });

  it("ignores a scheme that is not light or dark", () => {
    expect(visualThemeCss({ scheme: "blue" as "dark" })).toContain("color-scheme:dark");
    expect(visualThemeCss({ scheme: "light", background: " #abc " })).toContain(
      "--hivra-background:#abc",
    );
  });

  it("accepts only a finite height from the frame, inside the cap", () => {
    expect(visualHeightFromMessage({ type: "hivra:visual-height", height: 10 })).toBe(
      VISUAL_FRAME_MIN_HEIGHT,
    );
    expect(visualHeightFromMessage({ type: "hivra:visual-height", height: 99999 })).toBe(
      VISUAL_FRAME_MAX_HEIGHT,
    );
    expect(visualHeightFromMessage({ type: "hivra:visual-height", height: 100.2 })).toBe(101);
    expect(visualHeightFromMessage({ type: "hivra:visual-theme", height: 100 })).toBeNull();
    expect(visualHeightFromMessage({ type: "hivra:visual-height", height: "100" })).toBeNull();
    expect(visualHeightFromMessage({ type: "hivra:visual-height", height: Number.NaN })).toBeNull();
    expect(
      visualHeightFromMessage({ type: "hivra:visual-height", height: Number.POSITIVE_INFINITY }),
    ).toBeNull();
    expect(visualHeightFromMessage(null)).toBeNull();
    expect(visualHeightFromMessage("hivra:visual-height")).toBeNull();
  });

  it("builds a themed document only when network is exactly requested", () => {
    const locked = visualDocument("<p>chart</p>", FALLBACK_THEME, false);
    const open = visualDocument("<p>chart</p>", FALLBACK_THEME, true);
    expect(locked).toContain("connect-src 'none'");
    expect(open).toContain("connect-src https: wss:");
    expect(open).toContain("script-src 'unsafe-inline'");
    expect(open).not.toMatch(/script-src[^;]*https:/);
    const guestAt = open!.indexOf('id="hivra-visual-guest"');
    expect(guestAt).toBeGreaterThan(-1);
    const shell = open!.slice(0, guestAt);
    expect(shell).toContain("frame-src 'none'");
    expect(shell).not.toMatch(/script-src[^;]*https:/);
    expect(open!.slice(guestAt)).toContain('sandbox="allow-scripts"');
    expect(open!.slice(guestAt)).not.toContain("allow-same-origin");
    const lockedGuest = locked!.slice(locked!.indexOf('id="hivra-visual-guest"'));
    expect(lockedGuest).toContain("connect-src 'none'");
    expect(lockedGuest).not.toContain("connect-src https:");
  });

  it("escapes the guest so a quote cannot close the shell", () => {
    const doc = visualDocument(
      `"><iframe src="https://example.invalid/pwn"></iframe>`,
      FALLBACK_THEME,
      false,
    )!;
    const guestAt = doc.indexOf('id="hivra-visual-guest"');
    expect(guestAt).toBeGreaterThan(doc.indexOf("frame-src 'none'"));
    expect(doc.slice(guestAt)).not.toContain('"><iframe');
    expect(doc.slice(guestAt)).toContain(
      "&quot;><iframe src=&quot;https://example.invalid/pwn&quot;></iframe>",
    );
    expect(doc).not.toContain("allow-same-origin");
    expect(doc).not.toContain("navigate-to");
  });

  it("leaves a reply's own colors in charge and keeps the tokens underneath", () => {
    const doc = visualDocument(
      "<style>html{background:red;color:blue;font-family:serif}</style>",
      FALLBACK_THEME,
      false,
    )!;
    const tokens = doc.indexOf("--hivra-background:");
    const own = doc.indexOf("html{background:red;color:blue;font-family:serif}");
    expect(tokens).toBeGreaterThan(-1);
    expect(own).toBeGreaterThan(tokens);
    expect(doc).not.toContain("!important");
  });
});

describe("visual reply detection", () => {
  it("marks an explicit visual fence and the single-word html hint", () => {
    expect(visualFenceMark("visual", "")).toBe(true);
    expect(visualFenceMark("visual-html", "ignored")).toBe(true);
    expect(visualFenceMark("hivra-visual", "")).toBe(true);
    expect(visualFenceMark(" Visual ", "")).toBe(true);
    expect(visualFenceMark("html", "visual")).toBe(true);
    expect(visualFenceMark("HTML", " Visual ")).toBe(true);
    expect(visualFenceMark("htm", "VISUAL")).toBe(true);
  });

  it("does not treat ordinary html, prose or another language as a visual reply", () => {
    expect(visualFenceMark("html", "")).toBe(false);
    expect(visualFenceMark("html", "visual extra")).toBe(false);
    expect(visualFenceMark("html", "not visual")).toBe(false);
    expect(visualFenceMark("htm", "visual-html")).toBe(false);
    expect(visualFenceMark("javascript", "visual")).toBe(false);
    expect(visualFenceMark("", "visual")).toBe(false);
    expect(visualFenceMark("svg", "")).toBe(false);
    expect(visualFenceMark("html", "visual\nvisual")).toBe(false);
  });
});

// Hardening after review: a reply the person lets onto the network must still not reach the machine it runs on, and
// in the app the shell is served by the app with its own policy, because a srcdoc frame inherits the app's policy.
describe("visual reply network and served policy", () => {
  it("never lets a reply reach plain http or ws, so localhost, the LAN and the app's own http schemes stay shut", () => {
    for (const network of [false, true]) {
      const csp = visualCsp(network);
      expect(csp).not.toMatch(/(^|\s)http:/);
      expect(csp).not.toMatch(/(^|\s)ws:/);
      expect(csp).not.toMatch(/localhost|127\.0\.0\.1|asset:|ipc:|tauri:|file:/);
    }
  });

  it("the shell carries the same policy as its guest, so opting in is the only thing that opens the network", () => {
    for (const network of [false, true]) {
      const doc = visualDocument("<p>chart</p>", FALLBACK_THEME, network)!;
      const shell = doc.slice(0, doc.indexOf('id="hivra-visual-guest"'));
      expect(shell).toContain(`content="${visualCsp(network)}"`);
    }
  });

  it("the served policy is the sandbox plus the guest policy, and the app serves exactly that", () => {
    const rust = readFileSync(resolve(process.cwd(), "src-tauri/src/page_frames.rs"), "utf8").replace(/\\\n\s*/g, "");
    for (const network of [false, true]) {
      expect(visualFrameCsp(network)).toBe(`sandbox allow-scripts; ${visualCsp(network)}`);
      expect(rust).toContain(`"${visualFrameCsp(network)}"`);
    }
  });

  it("the shell passes on only a height from its guest", () => {
    const doc = visualDocument("<p>chart</p>", FALLBACK_THEME, false)!;
    const shell = doc.slice(0, doc.indexOf('id="hivra-visual-guest"'));
    expect(shell).toMatch(/event\.data\.type !== "hivra:visual-height"/);
  });

  it("turns off DNS prefetch before the reply", () => {
    const doc = visualDocument("<p>chart</p>", FALLBACK_THEME, false)!;
    const guest = doc.slice(doc.indexOf('id="hivra-visual-guest"'));
    const off = guest.indexOf("x-dns-prefetch-control");
    expect(off).toBeGreaterThan(-1);
    expect(off).toBeLessThan(guest.indexOf("&lt;p&gt;chart") > -1 ? guest.indexOf("&lt;p&gt;chart") : guest.indexOf("<p>chart"));
  });
});

// WP-130 review, items 2, 4, 5, 6 and 7: what the network choice means, the frame's size cap, the ready message and
// the guest's own link and peer-connection hardening.
describe("visual reply review hardening", () => {
  it("says plainly what the network choice reaches, and only when it is on", () => {
    expect(networkNote(false)).toBeNull();
    const note = networkNote(true);
    expect(note).not.toBeNull();
    expect(note).toMatch(/https/);
    expect(note).toMatch(/this machine|local network/);
    expect(note!.length).toBeLessThan(200);
    expect(note).not.toMatch(/[–—]/);
  });

  it("the frame cap is 3.2 MiB and a reply at the source cap, escaped in full, stays under it", () => {
    expect(VISUAL_FRAME_MAX_BYTES).toBe(3_355_443);
    for (const network of [false, true]) {
      const worst = '"'.repeat(VISUAL_REPLY_MAX_BYTES);
      const doc = visualDocument(worst, FALLBACK_THEME, network)!;
      expect(doc).not.toBeNull();
      expect(visualBytes(doc)).toBeLessThanOrEqual(VISUAL_FRAME_MAX_BYTES);
    }
  });

  it("a served shell says it has loaded, and only that message counts as ready", () => {
    expect(isVisualReadyMessage({ type: VISUAL_READY_MESSAGE })).toBe(true);
    expect(isVisualReadyMessage({ type: VISUAL_HEIGHT_MESSAGE, height: 10 })).toBe(false);
    expect(isVisualReadyMessage(null)).toBe(false);
    expect(isVisualReadyMessage("hivra:visual-ready")).toBe(false);
    const doc = visualDocument("<p>chart</p>", FALLBACK_THEME, false)!;
    const shell = doc.slice(0, doc.indexOf('id="hivra-visual-guest"'));
    expect(shell).toContain(VISUAL_READY_MESSAGE);
  });

  it("drops link hints from the reply, so a preconnect or prefetch is never sent", () => {
    const hints =
      '<link rel="preconnect" href="https://example.invalid"><LINK REL=prefetch HREF="https://example.invalid/x"><link rel="dns-prefetch" href="//example.invalid"><p>chart</p>';
    for (const network of [false, true]) {
      const doc = visualDocument(hints, FALLBACK_THEME, network)!;
      expect(doc.toLowerCase()).not.toContain("preconnect");
      expect(doc).not.toMatch(/<link\b/i);
      expect(doc).not.toMatch(/rel=["']?prefetch/i);
      expect(doc).toContain("chart");
    }
  });

  it("stubs the peer connection constructors in the guest, before the reply", () => {
    const doc = visualDocument("<p>chart</p>", FALLBACK_THEME, true)!;
    const guest = doc.slice(doc.indexOf('id="hivra-visual-guest"'));
    const stub = guest.indexOf("RTCPeerConnection");
    expect(stub).toBeGreaterThan(-1);
    expect(guest.indexOf("webkitRTCPeerConnection")).toBeGreaterThan(-1);
    expect(stub).toBeLessThan(guest.indexOf("chart"));
  });
});

describe("visualPreviewDocument (WP-254)", () => {
  it("is always locked, collects errors first, and drops link tags", async () => {
    const { visualPreviewDocument, visualCsp } = await import("./visualReply");
    const page = visualPreviewDocument('<link rel="prefetch" href="https://x.test"><p>ok</p>')!;
    expect(page).toContain(visualCsp(false));
    expect(page).not.toContain("connect-src https:");
    expect(page).not.toContain("<link");
    expect(page.indexOf("data-hivra-preview-errors")).toBeLessThan(page.indexOf("<p>ok</p>"));
    expect(page).not.toMatch(/<\/script>[\s\S]*<\/script>[\s\S]*<\/script>[\s\S]*<\/script>/);
    expect(visualPreviewDocument("x".repeat(600 * 1024))).toBeNull();
  });
});
