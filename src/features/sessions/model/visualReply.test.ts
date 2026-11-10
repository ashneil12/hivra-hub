import { describe, expect, it } from "vitest";
import {
  FALLBACK_THEME,
  VISUAL_FRAME_MAX_HEIGHT,
  VISUAL_FRAME_MIN_HEIGHT,
  VISUAL_REPLY_MAX_BYTES,
  VISUAL_SANDBOX,
  visualCsp,
  visualDocument,
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
    expect(csp).toContain("connect-src https: http: wss: ws:");
    expect(csp).toContain("img-src data: blob: https: http:");
    expect(csp).toContain("font-src data: https: http:");
    expect(csp).toContain("media-src data: blob: https: http:");
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
    expect(open).toContain("connect-src https: http: wss: ws:");
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
