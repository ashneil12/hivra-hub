import { describe, expect, it } from "vitest";
import { draftFor, shownAsk } from "./draftFor";

function paths(kind: Parameters<typeof draftFor>[0], ask = "Hello") {
  return draftFor(kind, ask).map((file) => file.path);
}

describe("draftFor", () => {
  it("puts a hostile ask in a paragraph, escaped, and never in a path", () => {
    const ask = `<script>alert("x")</script> & more`;
    const files = draftFor("panel", ask);
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
    expect(manifest.name).toBe("made-panel");
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  });

  it("keeps a line break in a body and falls back when the ask is empty", () => {
    const skill = draftFor("skill", "hello\r\nthere\u0000");
    const body = skill.find((file) => file.path.endsWith("SKILL.md"))?.content ?? "";
    expect(body).toContain("hello\r\nthere");
    expect(body).not.toContain("\u0000");
    expect(body).toContain("name: greet");
    expect(draftFor("command", "   \n\t  ")[1].content).toBe("Hello\n");
    expect(shownAsk("a".repeat(600)).length).toBe(500);
  });

  it("writes one folder per kind, with no path that can leave the scratch folder", () => {
    expect(paths("skill")).toEqual(["plugin.json", "skills/greet/SKILL.md"]);
    expect(paths("persona")).toEqual(["plugin.json", "hivra/personas/critic.md"]);
    expect(paths("mono")).toEqual(["plugin.json", "hivra/monos/helper/mono.json", "hivra/monos/helper/SOUL.md"]);
    expect(paths("command")).toEqual(["plugin.json", "hivra/commands/greet.md"]);
    const hostile = "../../etc/passwd\r\n<script>";
    for (const kind of ["skill", "panel", "persona", "mono", "command"] as const) {
      for (const file of draftFor(kind, hostile)) {
        expect(file.path).not.toContain("..");
        expect(file.path).not.toContain("\\");
        expect(file.path).not.toContain("\r");
        expect(file.content.length).toBeGreaterThan(0);
      }
      const name = JSON.parse(draftFor(kind, "x")[0].content).name;
      expect(name).toBe(`made-${kind}`);
    }
  });
});
