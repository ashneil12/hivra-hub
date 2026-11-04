// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { setBotFiles } from "../../hub/model/botChanges";
import { refreshSouls, type SoulFiles } from "../../hub/model/soulRefresh";
import type { AgentFilePath } from "./monoFiles";
import { applyMonoTemplateUpdate, keepsEditedSoul, updateFileFromTemplate } from "./soulKeep";
import { needsMigration, normalizeSoulText } from "./vendor/mercurySoul";

const LEGACY = "# Soul\n\n## How I speak\n- Concise and direct\n";
const NEXT = "# Soul\n\n## How I speak\n- Short and plain\n";
const EDITED = LEGACY.replace("Concise and direct", "Concise, direct, and a little dry");

describe("Mercury soul migration", () => {
  it("treats a CRLF copy of a known template as untouched", () => {
    expect(needsMigration(LEGACY.replace(/\n/g, "\r\n"), [LEGACY])).toBe(true);
    expect(normalizeSoulText("a  \r\nb\r\n")).toBe("a\nb");
  });

  it("never treats an edited file as a template, even with no legacy list", () => {
    expect(needsMigration(EDITED, [LEGACY])).toBe(false);
    expect(needsMigration("anything the person wrote", [])).toBe(false);
    expect(needsMigration("", [LEGACY])).toBe(false);
  });
});

describe("a template update keeps a person's edits", () => {
  it("replaces a known soul and leaves an edited soul and an edited memory", async () => {
    const writes: string[] = [];
    const files = new Map<string, string>([
      ["SOUL.md", EDITED],
      ["MEMORY.md", "The save button is too small.\r\n"],
    ]);
    const write = async (file: "SOUL.md" | "MEMORY.md", text: string) => {
      writes.push(file);
      files.set(file, text);
      return true;
    };
    const edited = await applyMonoTemplateUpdate({
      soul: { text: files.get("SOUL.md")!, hash: "soul" },
      memory: { text: files.get("MEMORY.md")!, hash: "mem" },
      soulTemplate: NEXT,
      memoryTemplate: "# Memory\n\n- nothing yet\n",
      knownSouls: [LEGACY],
      knownMemories: ["# Memory\n\n- nothing yet\n"],
      write,
    });
    expect(edited).toEqual({ soul: "kept", memory: "kept" });
    expect(writes).toEqual([]);
    expect(files.get("SOUL.md")).toBe(EDITED);
    expect(files.get("MEMORY.md")).toBe("The save button is too small.\r\n");

    const again = await applyMonoTemplateUpdate({
      soul: { text: EDITED, hash: "soul" },
      memory: { text: "The save button is too small.\r\n", hash: "mem" },
      soulTemplate: "# Soul\n\n## How I speak\n- Newer still\n",
      memoryTemplate: "# Memory\n\n- replaced\n",
      knownSouls: [LEGACY, NEXT],
      knownMemories: ["# Memory\n\n- nothing yet\n"],
      write,
    });
    expect(again).toEqual({ soul: "kept", memory: "kept" });
    expect(files.get("SOUL.md")).toBe(EDITED);
  });

  it("writes a missing file, and a CRLF known template, and retries when the hash moved", async () => {
    const missing = await updateFileFromTemplate({ text: null, hash: "" }, NEXT, [LEGACY], async () => true);
    expect(missing).toEqual({ outcome: "wrote", text: NEXT });

    const crlf = await updateFileFromTemplate(
      { text: LEGACY.replace(/\n/g, "\r\n"), hash: "old" },
      NEXT,
      [LEGACY],
      async () => true,
    );
    expect(crlf.outcome).toBe("wrote");

    let tried = 0;
    const raced = await updateFileFromTemplate(
      { text: LEGACY.replace(/\n/g, "\r\n"), hash: "old" },
      NEXT,
      [LEGACY],
      async () => {
        tried += 1;
        return false;
      },
    );
    expect(raced).toEqual({ outcome: "retry", text: LEGACY.replace(/\n/g, "\r\n") });
    expect(tried).toBe(1);
    expect(keepsEditedSoul("", [])).toBe(true);
    expect(keepsEditedSoul(null, [LEGACY])).toBe(false);
  });

  it("leaves an edited soul and memory alone on the app's own refresh", async () => {
    const files = new Map<string, string>();
    const writes: string[] = [];
    const key = (id: string, path: string) => `${id}/${path}`;
    const hash = (text: string | undefined) => `h:${text ?? ""}`;
    const api: SoulFiles & { get(id: string, path: string): string | undefined } = {
      get: (id, path) => files.get(key(id, path)),
      read: async (id, path) => ({ text: files.get(key(id, path)) ?? null, hash: hash(files.get(key(id, path))) }),
      write: async (id, path: AgentFilePath, text, expected) => {
        writes.push(`${id}/${path}`);
        if (expected !== undefined && hash(files.get(key(id, path))) !== expected) return "conflict";
        files.set(key(id, path), text);
        return hash(text);
      },
    };
    setBotFiles({ read: api.read, write: api.write });
    const memory = "Remember the unicode name 設計 and the path C:\\work files\\..\\nope\r\n";
    files.set(key("ada", "SOUL.md"), EDITED);
    files.set(key("ada", "MEMORY.md"), memory);
    const result = await refreshSouls(api, [{ monoId: "ada", name: "Ada", template: NEXT }], new Date(2026, 10, 4));
    expect(result.refreshed).toEqual([]);
    expect(result.skipped).toEqual(["ada"]);
    expect(files.get(key("ada", "SOUL.md"))).toBe(EDITED);
    expect(files.get(key("ada", "MEMORY.md"))).toBe(memory);
    expect(writes.some((path) => path.endsWith("MEMORY.md") || path.includes(".."))).toBe(false);

    const second = await refreshSouls(api, [{ monoId: "ada", name: "Ada", template: NEXT }], new Date(2026, 10, 4));
    expect(second.skipped).toEqual([]);
    expect(files.get(key("ada", "SOUL.md"))).toBe(EDITED);
    expect(files.get(key("ada", "MEMORY.md"))).toBe(memory);
  });
});
