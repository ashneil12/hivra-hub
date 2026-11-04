import { describe, expect, it } from "vitest";
import { draftFor, pluginName, shownAsk } from "./draftFor";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function paths(kind: Parameters<typeof draftFor>[0], ask = "Hello") {
  return draftFor(kind, ask, ID).map((file) => file.path);
}

describe("draftFor", () => {
  it("puts a hostile ask in a paragraph, escaped, and never in a path", () => {
    const ask = `<script>alert("x")</script> & more`;
    const files = draftFor("panel", ask, ID);
    const html = files.find((file) => file.path.endsWith("index.html"))?.content ?? "";
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&amp; more");
    expect(html.startsWith("<p>")).toBe(true);
    for (const file of files) {
      expect(file.path).not.toContain("..");
      expect(file.path).not.toContain("\\");
    }
    const manifest = JSON.parse(files[0].content);
    expect(manifest.name).toBe(pluginName("panel", ID));
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  });

  it("keeps a line break in a body and falls back when the ask is empty", () => {
    const skill = draftFor("skill", "hello\r\nthere\u0000", ID);
    const body = skill.find((file) => file.path.endsWith("SKILL.md"))?.content ?? "";
    expect(body).toContain("hello\r\nthere");
    expect(body).not.toContain("\u0000");
    expect(body).toContain("name: greet");
    expect(draftFor("command", "   \n\t  ", ID)[1].content).toBe("Hello\n");
    expect(shownAsk("a".repeat(600)).length).toBe(500);
  });

  it("writes one folder per kind, with no path that can leave the scratch folder", () => {
    expect(paths("skill")).toEqual(["plugin.json", "skills/greet/SKILL.md"]);
    expect(paths("persona")).toEqual(["plugin.json", "hivra/personas/critic.md"]);
    expect(paths("mono")).toEqual(["plugin.json", "hivra/monos/helper/mono.json", "hivra/monos/helper/SOUL.md"]);
    expect(paths("command")).toEqual(["plugin.json", "hivra/commands/greet.md"]);
    const hostile = "../../etc/passwd\r\n<script>";
    for (const kind of ["skill", "panel", "persona", "mono", "command"] as const) {
      for (const file of draftFor(kind, hostile, ID)) {
        expect(file.path).not.toContain("..");
        expect(file.path).not.toContain("\\");
        expect(file.path).not.toContain("\r");
        expect(file.content.length).toBeGreaterThan(0);
      }
      const name = JSON.parse(draftFor(kind, "x", ID)[0].content).name;
      expect(name).toBe(pluginName(kind, ID));
      expect(name).not.toBe(`made-${kind}`);
    }
  });

  it("gives each build its own plugin name", () => {
    const left = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const right = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const a = JSON.parse(draftFor("panel", "one", left)[0].content).name as string;
    const b = JSON.parse(draftFor("panel", "one", right)[0].content).name as string;
    expect(a).not.toBe(b);
    expect(a).not.toBe("made-panel");
    expect(a).toMatch(/^made-panel-[a-z0-9]+$/);
    expect(b).toMatch(/^made-panel-[a-z0-9]+$/);
    expect(JSON.parse(draftFor("panel", "again", left)[0].content).name).toBe(a);
    const hostile = JSON.parse(draftFor("skill", "../../etc", "../..\u0000")[0].content).name as string;
    expect(hostile).toMatch(/^made-skill-[a-z0-9]+$/);
    expect(hostile).not.toContain(".");
    expect(hostile).not.toContain("/");
  });
});
