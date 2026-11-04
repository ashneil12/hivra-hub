import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CircleWord, redRowProps } from "./StatusMark";

// r69 (PM's blind r67 (a)): the red Needs-Ash state showed only on the ring. Ash, 29 Oct: "do NOT tint or fill the row
// background red. Only the 2px red left bar plus the red 'Needs you' label; row background stays neutral."
// WP-06: the Today and Waiting on you rows that carried this bar are gone. The mark itself stays for the rail.

describe("r69 (a): a Needs you row is marked by a 2px red left bar and a red Needs you word, never a red background", () => {
  it("draws the bar as a 2px inset on the left edge and nothing else", () => {
    const props = redRowProps(true);
    expect(props.style).toEqual({ boxShadow: "inset 2px 0 0 rgb(239 68 68)" });
    expect(props["data-hub-red-row"]).toBe(true);
    expect(JSON.stringify(props)).not.toMatch(/background/i);
    expect(redRowProps(false)).toEqual({});
  });

  it("writes the Needs you word in red; grey states keep the grey word", () => {
    const red = renderToStaticMarkup(createElement(CircleWord, { circle: "red", word: "Needs you" }));
    expect(red).toMatch(/style="color:#ff6b6b"/); // r70b: the word is ~#ff6b6b, the bar stays rgb(239 68 68)
    expect(red).toContain("Needs you");
    const grey = renderToStaticMarkup(createElement(CircleWord, { circle: "grey", word: "Retrying" }));
    expect(grey).toContain("text-content/60");
    expect(grey).not.toMatch(/#ff6b6b"[^>]*>Retrying/);
  });
});
