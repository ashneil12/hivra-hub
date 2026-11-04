// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { setBotFiles } from "../../hub/model/botChanges";
import { refreshSouls, SOUL_TEMPLATE_FILE, type SoulFiles } from "../../hub/model/soulRefresh";
import type { AgentFilePath } from "./monoFiles";
import { keepsEditedSoul } from "./soulKeep";
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
  it("keeps an edited soul and memory, and not a known template", () => {
    const memory = "The save button is too small.\r\n";
    expect(keepsEditedSoul(EDITED, [LEGACY])).toBe(true);
    expect(keepsEditedSoul(memory, ["# Memory\n\n- nothing yet\n"])).toBe(true);
    expect(keepsEditedSoul(LEGACY, [LEGACY])).toBe(false);
    expect(keepsEditedSoul(LEGACY.replace(/\n/g, "\r\n"), [LEGACY])).toBe(false);
    expect(keepsEditedSoul(null, [LEGACY])).toBe(false);
    expect(keepsEditedSoul("", [])).toBe(true);
    expect(keepsEditedSoul(EDITED, [LEGACY, NEXT, "# Soul\n\n## How I speak\n- Newer still\n"])).toBe(true);
    expect(keepsEditedSoul(memory, ["# Memory\n\n- nothing yet\n", "# Memory\n\n- replaced\n"])).toBe(true);
  });

  it("leaves a missing soul for creation, replaces a CRLF known template, and does not claim a write that missed", async () => {
    const files = new Map<string, string>();
    const key = (id: string, path: string) => `${id}/${path}`;
    const hash = (text: string | undefined) => `h:${text ?? ""}`;
    const api: SoulFiles & { get(id: string, path: string): string | undefined } = {
      get: (id, path) => files.get(key(id, path)),
      read: async (id, path) => ({ text: files.get(key(id, path)) ?? null, hash: hash(files.get(key(id, path))) }),
      write: async (id, path: AgentFilePath, text, expected) => {
        if (id === "raced" && path === "SOUL.md") return hash(files.get(key(id, path)));
        if (expected !== undefined && hash(files.get(key(id, path))) !== expected) return "conflict";
        files.set(key(id, path), text);
        return hash(text);
      },
    };
    setBotFiles({ read: api.read, write: api.write });
    const day = new Date(2026, 10, 4);

    const missing = await refreshSouls(api, [{ monoId: "gone", name: "Gone", template: NEXT }], day);
    expect(missing.refreshed).toEqual([]);
    expect(files.has(key("gone", "SOUL.md"))).toBe(false);

    const crlf = LEGACY.replace(/\n/g, "\r\n");
    files.set(key("ada-crlf", "SOUL.md"), crlf);
    files.set(key("ada-crlf", SOUL_TEMPLATE_FILE), LEGACY);
    const replaced = await refreshSouls(api, [{ monoId: "ada-crlf", name: "Ada", template: NEXT }], day);
    expect(replaced.refreshed).toEqual(["ada-crlf"]);
    expect(files.get(key("ada-crlf", "SOUL.md"))).toBe(NEXT);

    files.set(key("raced", "SOUL.md"), LEGACY);
    files.set(key("raced", SOUL_TEMPLATE_FILE), LEGACY);
    const raced = await refreshSouls(api, [{ monoId: "raced", name: "Ada", template: NEXT }], day);
    expect(raced.refreshed).not.toContain("raced");
    expect(files.get(key("raced", "SOUL.md"))).toBe(LEGACY);
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
