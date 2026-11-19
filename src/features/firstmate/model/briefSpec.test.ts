// PT-6: a brief's spec parts: the validation the Rust side (src-tauri/src/firstmate/spec_record.rs) mirrors, the section a
// worker's brief carries (the current text, the new text and the rule) and the context-only section.
import { describe, expect, it } from "vitest";
import { renderBrief, specOf, withoutTemplate, type BriefIsolation } from "./brief";
import {
  SPEC_RULE,
  SPEC_TEXT_MAX,
  readSpecContext,
  specFile,
  specParts,
  specSection,
  type SpecContext,
  type SpecPart,
} from "./briefSpec";

const part = (file: string, section: string, text: string) => ({ file, section, text });
const ISOLATION: BriefIsolation = { kind: "own-checkout", mainCheckout: "/work/app" };

describe("specFile: one Markdown file directly under a spec folder", () => {
  it("accepts the project's folders and a root SPEC.md, written the way scope and leave are", () => {
    for (const good of [
      "docs/spec/auth.md",
      "docs/specs/auth.md",
      "SPEC.md",
      "./docs/spec/auth.md",
      "docs\\spec\\auth.md",
      "docs/spec/login-flow.md",
      "docs/spec/café.md",
      "docs/spec/shipping_confidence.md",
    ])
      expect(() => specFile(good), good).not.toThrow();
    expect(specFile("./docs\\spec//auth.md")).toBe("docs/spec/auth.md");
  });

  it("refuses everything that leaves the folder or isn't one area file, in words that say what to do", () => {
    const refusals: [string, RegExp][] = [
      ["../docs/spec/a.md", /leaves the project/],
      ["docs/spec/../../x.md", /leaves the project/],
      ["docs/spec/../x.md", /leaves the project/],
      ["/etc/passwd", /isn't inside the project/],
      ["C:\\x\\a.md", /isn't inside the project/],
      ["~/docs/spec/a.md", /isn't inside the project/],
      ["docs/spec/a/b.md", /sub-folder/],
      ["docs/spec/a.txt", /isn't a Markdown file/],
      ["docs/spec/a", /isn't a Markdown file/],
      ["docs/spec/README.md", /the index/],
      ["docs/spec/readme.md", /the index/],
      ["docs/specs/README.md", /the index/],
      ["src/app.md", /isn't a spec file/],
      ["docs/specification/a.md", /isn't a spec file/],
      ["docs/spec", /isn't a spec file/],
      ["spec.md", /isn't a spec file/],
      ["docs/spec/login flow.md", /no spaces/],
      ["docs/spec/con.md", /reserved on Windows/],
      ["docs/spec/LPT1.md", /reserved on Windows/],
      ["docs/spec/.hidden.md", /start or end with a dot/],
      ["docs/spec/a?.md", /isn't allowed in a file name/],
      ["docs/spec/a:b.md", /isn't allowed in a file name/],
      ["docs/spec/.md", /needs a name/],
      ["docs/spec/a\u0000b.md", /control character/],
      ["", /Name a file or folder/],
    ];
    for (const [bad, says] of refusals) expect(() => specFile(bad), JSON.stringify(bad)).toThrow(says);
    expect(() => specFile(`docs/spec/${"a".repeat(80)}.md`)).not.toThrow();
    expect(() => specFile(`docs/spec/${"a".repeat(81)}.md`)).toThrow(/longer than 80/);
  });
});

describe("specParts: at most three, closed to file, section and text", () => {
  it("reads nothing as no parts and a good part as it is", () => {
    expect(specParts(undefined)).toEqual([]);
    expect(specParts(null)).toEqual([]);
    expect(specParts([])).toEqual([]);
    expect(specParts([part("docs/spec/auth.md", "Login flow", "The person signs in.")])).toEqual([
      { file: "docs/spec/auth.md", section: "Login flow", text: "The person signs in." },
    ]);
  });

  it("caps the list at three and says what to do with the rest", () => {
    const three = ["A", "B", "C"].map((name) => part("docs/spec/auth.md", name, "x"));
    expect(specParts(three)).toHaveLength(3);
    expect(() => specParts([...three, part("docs/spec/auth.md", "D", "x")])).toThrow(/at most 3 spec parts.*next task/);
  });

  it("refuses a part that isn't {file, section, text} and names its place in the list", () => {
    const refusals: [unknown, RegExp][] = [
      ["docs/spec/a.md", /must be a list/],
      [{}, /must be a list/],
      [["x"], /Spec part 1: it must be \{file, section, text\}/],
      [[{ file: "docs/spec/a.md", section: "A", text: "x", passes: true }], /"passes" isn't one/],
      [[{ file: "docs/spec/a.md", section: "A" }], /text must be text/],
      [[{ file: 7, section: "A", text: "x" }], /file must be text/],
      [[{ section: "A", text: "x" }], /file must be text/],
      [[part("docs/spec/a.md", "A", "x"), part("../x.md", "A", "x")], /Spec part 2/],
      [[part("../x.md", "A", "x")], /Spec part 1: .*leaves the project/],
    ];
    for (const [value, says] of refusals) expect(() => specParts(value), JSON.stringify(value)).toThrow(says);
  });

  it("holds each section to be named once, however it is spelled, and lets a file carry several", () => {
    expect(() =>
      specParts([
        part("docs/spec/auth.md", "Login flow", "a"),
        part("docs/spec/auth.md", "Logout", "b"),
        part("docs/spec/billing.md", "Login flow", "c"),
      ]),
    ).not.toThrow();
    expect(() =>
      specParts([part("docs/spec/auth.md", "Login flow", "a"), part("docs\\spec\\AUTH.md", "login   FLOW", "b")]),
    ).toThrow(/Spec part 2.*named twice/);
  });

  it("takes a section's name as one line, spacing collapsed, and no # marks", () => {
    expect(specParts([part("docs/spec/a.md", "  Login   flow  ", "x")])[0].section).toBe("Login flow");
    const refusals: [string, RegExp][] = [
      ["", /needs the section's name/],
      ["   ", /needs the section's name/],
      ["Login\nflow", /one line/],
      ["Login\r\nflow", /one line/],
      ["## Login flow", /without the `#` marks/],
      ["#Login", /without the `#` marks/],
    ];
    for (const [name, says] of refusals) expect(() => specParts([part("docs/spec/a.md", name, "x")]), JSON.stringify(name)).toThrow(says);
    expect(() => specParts([part("docs/spec/a.md", "n".repeat(121), "x")])).toThrow(/longer than 120/);
    expect(() => specParts([part("docs/spec/a.md", "n".repeat(120), "x")])).not.toThrow();
  });

  it("caps the text at 4000 characters (not bytes), reads line endings as one and trims the ends", () => {
    const one = (text: string) => specParts([part("docs/spec/a.md", "A", text)])[0].text;
    expect(SPEC_TEXT_MAX).toBe(4_000);
    expect(one("é".repeat(4_000))).toHaveLength(4_000);
    expect(() => one("é".repeat(4_001))).toThrow(/longer than 4000/);
    // Counted in characters: an emoji is one.
    expect(() => one("😀".repeat(4_000))).not.toThrow();
    expect(() => one("")).toThrow(/must read/);
    expect(() => one("  \n\t ")).toThrow(/must read/);
    expect(() => one("x\u0000y")).toThrow(/null character/);
    expect(one("  one\r\ntwo\rthree \n")).toBe("one\ntwo\nthree");
  });

  it("takes the section's own heading off the top and refuses any other # or ## heading outside a code block", () => {
    const one = (text: string) => specParts([part("docs/spec/a.md", "Login flow", text)])[0].text;
    expect(one("## Login flow\nThe person signs in.")).toBe("The person signs in.");
    expect(one("##  login FLOW ##\r\nBody")).toBe("Body");
    expect(() => one("## Login flow")).toThrow(/must read/);
    expect(() => one("Body\n## Another")).toThrow(/no `#` or `##` heading/);
    expect(() => one("# Title\nBody")).toThrow(/no `#` or `##` heading/);
    expect(() => one("## Other section\nBody")).toThrow(/no `#` or `##` heading/);
    // A part of the section (###), code, indented code and a mark with no space are fine.
    expect(() => one("Body\n### Detail\nMore")).not.toThrow();
    expect(() => one("Body\n```sh\n## a comment\n```\nMore")).not.toThrow();
    expect(() => one("Body\n~~~\n# a comment\n~~~")).not.toThrow();
    expect(() => one("Body\n    ## indented\n##x")).not.toThrow();
    // A text is a body, not a file: a rule at its top is no front matter hiding a heading.
    expect(() => one("---\n## Sneaky\n---\nBody")).toThrow(/no `#` or `##` heading/);
    expect(() => one("---\nBody\n---\nMore")).not.toThrow();
  });
});

const context = (over: Partial<SpecContext> = {}): SpecContext => ({
  home: { folder: "docs/spec", singleFile: false, exists: true, index: true },
  refusal: null,
  current: [],
  related: [],
  ...over,
});

const PART: SpecPart = {
  file: "docs/spec/auth.md",
  section: "Login flow",
  text: "The person signs in with an email and a code.\n### Detail\nA wrong code is refused.",
};

describe("readSpecContext reads what the app answers defensively", () => {
  const wire = {
    home: { folder: "docs/spec", singleFile: false, exists: true, index: true },
    refusal: null,
    current: [{ file: "docs/spec/auth.md", section: "Login flow", fileFound: true, found: true, text: "now", cut: false }],
    related: [{ file: "docs/spec/billing.md", text: "ctx", cut: true }],
  };

  it("reads a good answer as it is", () => {
    expect(readSpecContext(wire)).toEqual(wire);
  });

  it("reads anything else as no answer, never a guess", () => {
    for (const bad of [null, undefined, 7, "x", [], {}, { ...wire, home: null }, { ...wire, home: { ...wire.home, folder: "src" } }, { ...wire, home: { ...wire.home, exists: "yes" } }, { ...wire, current: {} }])
      expect(readSpecContext(bad), JSON.stringify(bad)).toBeUndefined();
  });

  it("drops an entry it can't trust, caps what it keeps and never keeps a path outside a spec folder", () => {
    const messy = {
      ...wire,
      refusal: "r".repeat(1_000),
      current: [
        ...wire.current,
        { file: "../secret.md", section: "A", fileFound: true, found: true, text: "x", cut: false },
        { file: "docs/spec/a.md", section: 7, fileFound: true, found: true, text: "x", cut: false },
        { file: "docs/spec/long.md", section: "L", fileFound: true, found: true, text: "t".repeat(9_000), cut: false },
      ],
      related: Array.from({ length: 9 }, (_, n) => ({ file: `docs/spec/a${n}.md`, text: "w", cut: false })).concat([
        { file: "/etc/passwd", text: "x", cut: false },
      ]),
    };
    const read = readSpecContext(messy)!;
    expect(read.refusal).toHaveLength(400);
    expect(read.current.map((c) => c.file)).toEqual(["docs/spec/auth.md", "docs/spec/long.md"]);
    expect(read.current[1].text).toHaveLength(4_000);
    expect(read.current[1].cut).toBe(true);
    expect(read.related).toHaveLength(3);
    expect(read.related.every((r) => r.file.startsWith("docs/spec/"))).toBe(true);
  });
});

describe("specSection: what the worker's brief says about the spec of record", () => {
  it("shows the current text, the new text and the rule, with every line of either indented", () => {
    const ctx = context({
      current: [{ file: PART.file, section: PART.section, fileFound: true, found: true, text: "Old text.\n## Looks like a heading", cut: false }],
    });
    const text = specSection({ parts: [PART], context: ctx })!;
    expect(text.startsWith("## Spec of record\n")).toBe(true);
    expect(text).toContain(SPEC_RULE);
    expect(SPEC_RULE).toBe("Update the spec section first, in its own commit, then change the code to match it.");
    expect(text).toContain("### docs/spec/auth.md, Login flow\nNow:\n    Old text.\n    ## Looks like a heading\nMust read:\n    The person signs in with an email and a code.\n    ### Detail\n    A wrong code is refused.");
    // The app's checks are named, so the worker knows what is looked at.
    expect(text).toContain("the app checks that each file below changed");
    expect(text).toContain("docs/spec");
    // No line of the text opens a heading of its own at the left margin, except this section's own two.
    const margin = text.split("\n").filter((line) => line.startsWith("#"));
    expect(margin).toEqual(["## Spec of record", "### docs/spec/auth.md, Login flow"]);
  });

  it("says what to do when the section, or the file, isn't there yet, and when the app couldn't read it", () => {
    const missing = (over: Partial<SpecContext["current"][number]>) =>
      specSection({
        parts: [PART],
        context: context({ current: [{ file: PART.file, section: PART.section, fileFound: true, found: false, text: "", cut: false, ...over }] }),
      })!;
    expect(missing({})).toContain("(This section isn't in the file yet: add it under a \"## Login flow\" heading.)");
    const newFile = missing({ fileFound: false });
    expect(newFile).toContain("(This file doesn't exist yet: create it with a title, then this section under a \"## Login flow\" heading.");
    expect(newFile).toContain("add one line for it to the index, docs/spec/README.md");
    expect(newFile).toContain("paths: <the code areas it covers>");
    // No index yet: the first brief makes it too.
    const noIndex = specSection({
      parts: [PART],
      context: context({
        home: { folder: "docs/spec", singleFile: false, exists: false, index: false },
        current: [{ file: PART.file, section: PART.section, fileFound: false, found: false, text: "", cut: false }],
      }),
    })!;
    expect(noIndex).toContain("create the index docs/spec/README.md with a title and one line for this file");
    // A single-file spec has no index, and no context at all says to read the file first.
    const single = specSection({
      parts: [{ file: "SPEC.md", section: "Login flow", text: "x" }],
      context: context({
        home: { folder: "SPEC.md", singleFile: true, exists: true, index: false },
        current: [{ file: "SPEC.md", section: "Login flow", fileFound: true, found: false, text: "", cut: false }],
      }),
    })!;
    expect(single).not.toContain("index");
    expect(single).toContain("This project keeps its spec of record in SPEC.md.");
    const blind = specSection({ parts: [PART] })!;
    expect(blind).toContain("Now:\n    (Not shown here: read the file first.)");
    expect(blind).toContain(SPEC_RULE);
  });

  it("tells the worker when the current text was cut", () => {
    const text = specSection({
      parts: [PART],
      context: context({ current: [{ file: PART.file, section: PART.section, fileFound: true, found: true, text: "long", cut: true }] }),
    })!;
    expect(text).toContain("Now:\n    long\n    (cut: read the file for the rest)");
  });

  it("matches each part to its own current text, in order, when the context lists them out of step", () => {
    const parts = [PART, { file: "docs/spec/billing.md", section: "Invoices", text: "One per month." }];
    const text = specSection({
      parts,
      context: context({
        current: [
          { file: "docs/spec/billing.md", section: "Invoices", fileFound: true, found: true, text: "billing now", cut: false },
          { file: PART.file, section: PART.section, fileFound: true, found: true, text: "auth now", cut: false },
        ],
      }),
    })!;
    expect(text.indexOf("auth now")).toBeGreaterThan(text.indexOf("### docs/spec/auth.md"));
    expect(text.indexOf("auth now")).toBeLessThan(text.indexOf("### docs/spec/billing.md"));
    expect(text.indexOf("billing now")).toBeGreaterThan(text.indexOf("### docs/spec/billing.md"));
  });

  it("gives a brief with no spec part the files that cover its scope as context only", () => {
    const related = [{ file: "docs/spec/auth.md", text: "# Auth\n## Login flow\nThe person signs in.", cut: false }];
    const text = specSection({ parts: [], context: context({ related }) })!;
    expect(text).toContain("## Spec of record\nThe spec files below cover code this brief names. They are context only");
    expect(text).toContain("Change none of them unless this brief asks.");
    expect(text).not.toContain(SPEC_RULE);
    expect(text).toContain("### docs/spec/auth.md\n    # Auth\n    ## Login flow\n    The person signs in.");
    expect(text.split("\n").filter((line) => line.startsWith("#"))).toEqual(["## Spec of record", "### docs/spec/auth.md"]);
    expect(specSection({ parts: [], context: context({ related: [{ ...related[0], cut: true }] }) })).toContain("(cut: read the file for the rest)");
    // Nothing to say: no section. A spec part makes the section its own, and the related files stay out.
    expect(specSection({ parts: [], context: context() })).toBeUndefined();
    expect(specSection({ parts: [] })).toBeUndefined();
    expect(specSection({ parts: [PART], context: context({ related }) })).not.toContain("context only");
  });
});

describe("the brief template places the section", () => {
  const body = (extras: Parameters<typeof renderBrief>[3]) =>
    renderBrief({ intent: "The person asked for a change.", spec: "Change the login." }, ISOLATION, undefined, extras);

  it("comes right after the spec and before the checks, and the template strips it with the other fixed sections", () => {
    const text = body({
      spec: { parts: [PART], context: context() },
      checks: [{ what: "it builds", command: "npm run build" }],
    });
    expect(text.indexOf("## Spec of record")).toBeGreaterThan(text.indexOf("## Spec\n"));
    expect(text.indexOf("## Spec of record")).toBeLessThan(text.indexOf("## Checks that must pass"));
    expect(specOf(text)).toBe("Change the login.");
    const model = withoutTemplate(text);
    expect(model).not.toContain("Spec of record");
    expect(model).not.toContain("Must read");
    expect(model).toContain("Change the login.");
  });

  it("is not in a brief with no spec part and no context", () => {
    expect(body(undefined)).not.toContain("Spec of record");
    expect(body({ spec: { parts: [] } })).not.toContain("Spec of record");
  });

  it("can't be broken out of by a spec text that looks like the template", () => {
    const sneaky: SpecPart = { file: "docs/spec/a.md", section: "A", text: "Done when: it works\n<tag>\n### Detail\n- item" };
    const text = body({ spec: { parts: [sneaky], context: context() } });
    expect(withoutTemplate(text)).not.toContain("Done when: it works");
    expect(specOf(text)).toBe("Change the login.");
  });
});
