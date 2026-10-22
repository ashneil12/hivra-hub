// @vitest-environment happy-dom
// The page kit every built page gets (sandbox.ts), from Critiquito's review of the C3 page (22 Oct): an empty section
// shows one grey line instead of a bare heading, headings read in sentence case, and the page's own title isn't
// shown a second time under the app's header.
import { afterEach, describe, expect, it } from "vitest";
import { bespokeSrcdoc } from "./sandbox";

const C3_LIKE = `<section class="card"><div class="kicker">MonoCode Hub</div><h1>What they're doing</h1><p>Stuck and asking come first.</p>
<section class="group"><h2 class="group-title">Needs you</h2><div class="rows" data-list="needs"></div></section>
<section class="group"><h2 class="group-title">Everyone else</h2><div class="rows" data-list="rest"></div></section>
<section class="group" data-empty="No builds today"><h3>Builds</h3><ul></ul></section></section>`;

/** Runs the kit's helper script over the page's HTML, the way the frame does. */
function mount(html: string) {
  const doc = bespokeSrcdoc({ html, css: "h2{text-transform:uppercase;font-weight:700}" }, {});
  const helper = doc.match(/<script>([\s\S]*?)<\/script><\/head>/)![1];
  document.body.innerHTML = html;
  new Function(helper)();
  document.dispatchEvent(new Event("DOMContentLoaded"));
  return doc;
}
const flush = () => new Promise((r) => setTimeout(r, 5));
const lineOf = (title: string) =>
  Array.from(document.querySelectorAll("section")).find((s) => s.querySelector(":scope > h2, :scope > h3")?.textContent === title)
    ?.querySelector(":scope > .hub-empty")?.textContent;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("page kit", () => {
  it("gives an empty section one plain grey line, not a bare heading", () => {
    mount(C3_LIKE);
    expect(lineOf("Needs you")).toBe("Nothing waiting on you");
    expect(lineOf("Everyone else")).toBe("No one else right now");
    expect(lineOf("Builds")).toBe("No builds today");
    // The outer card has real words, so it gets no line.
    expect(document.querySelector("section.card > .hub-empty")).toBeNull();
  });

  it("takes the line away once real content arrives", async () => {
    mount(C3_LIKE);
    document.querySelector('[data-list="needs"]')!.textContent = "Projects Manager is asking: which theme?";
    await flush();
    expect(lineOf("Needs you")).toBeUndefined();
    expect(lineOf("Everyone else")).toBe("No one else right now");
  });

  it("doesn't show the page's own title twice: the app's header already has it", () => {
    mount(C3_LIKE);
    expect((document.querySelector("h1") as HTMLElement).style.display).toBe("none");
  });

  it("puts section headings in sentence case after the page's own CSS, never bold caps", () => {
    const doc = mount(C3_LIKE);
    const styles = [...doc.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    const kit = styles[styles.length - 1];
    expect(styles.length).toBe(3);
    expect(kit).toMatch(/text-transform:none!important/);
    expect(kit).toMatch(/font-weight:500!important/);
    expect(doc).not.toMatch(/\.hub-block-title\{[^}]*uppercase/);
  });
});
