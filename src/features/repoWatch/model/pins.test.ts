import { describe, expect, it } from "vitest";
import { cleanText } from "./redact";
import {
  commitPins,
  emptyPins,
  githubSlug,
  githubUrl,
  importPinText,
  insideProject,
  parsePinDocument,
  pinFilePath,
  readPinRows,
  serializePinDocument,
  type RepoPin,
} from "./pins";
import { memoryPinIo, savePins, textFromFolder, PinIoError } from "./pinStore";

const TOKEN = `ghp_${"a".repeat(36)}`;

function pin(over: Partial<RepoPin> = {}): RepoPin {
  return {
    url: "https://github.com/acme/web",
    licence: "MIT",
    pinSha: "abc1234",
    notes: "door",
    ...over,
  };
}

describe("pin file path", () => {
  it("stays inside a project path that has spaces or unicode", () => {
    expect(pinFilePath("/work/My Project")).toBe("/work/My Project/.hivra/repo-pins.json");
    expect(pinFilePath("/work/文档")).toBe("/work/文档/.hivra/repo-pins.json");
    expect(insideProject("C:\\Work\\My Project", ".hivra/repo-pins.json")).toBe(
      "C:/Work/My Project/.hivra/repo-pins.json",
    );
  });

  it("refuses a relative path that climbs out", () => {
    expect(insideProject("/work/proj", ".hivra/../../etc/passwd")).toBeNull();
    expect(insideProject("/work/proj", "..\\repo-pins.json")).toBeNull();
    expect(pinFilePath("")).toBeNull();
    expect(insideProject("/work/proj", ".hivra/\0repo-pins.json")).toBeNull();
  });
});

describe("addresses", () => {
  it("accepts a GitHub web address, a short name and an ssh name", () => {
    expect(githubUrl("https://github.com/Acme/Web.git")).toBe("https://github.com/Acme/Web");
    expect(githubUrl("http://github.com/Acme/Web/")).toBe("https://github.com/Acme/Web");
    expect(githubUrl("Acme/Web")).toBe("https://github.com/Acme/Web");
    expect(githubUrl("git@github.com:Acme/Web.git")).toBe("https://github.com/Acme/Web");
    expect(githubSlug("https://github.com/Acme/Web")).toEqual({ owner: "Acme", repo: "Web" });
  });

  it("rejects logins, queries, other hosts and path tricks", () => {
    expect(githubUrl(`https://user:${TOKEN}@github.com/Acme/Web`)).toBeNull();
    expect(githubUrl("https://github.com/Acme/Web?token=1")).toBeNull();
    expect(githubUrl("https://gitlab.com/Acme/Web")).toBeNull();
    expect(githubUrl("javascript:alert(1)")).toBeNull();
    expect(githubUrl("https://github.com/Acme/Web/tree/main")).toBeNull();
    expect(githubUrl("../etc/passwd")).toBeNull();
    expect(githubUrl("")).toBeNull();
  });
});

describe("parse and import", () => {
  it("is empty when the file is missing, blank or broken", () => {
    expect(parsePinDocument(null)).toEqual(emptyPins());
    expect(parsePinDocument("")).toEqual(emptyPins());
    expect(parsePinDocument("   ")).toEqual(emptyPins());
    expect(parsePinDocument("{")).toEqual(emptyPins());
    expect(parsePinDocument("[]")).toEqual(emptyPins());
    expect(readPinRows("{").unreadable).toBe(true);
  });

  it("reads a pin file and a repos list, including crlf", () => {
    const text = '{\r\n  "pins": [\r\n    {"url": "https://github.com/Acme/Web.git", "licence": "MIT", "pinSha": "ABC1234", "notes": "door"}\r\n  ]\r\n}\r\n';
    const doc = parsePinDocument(text);
    expect(doc.pins).toEqual([pin({ url: "https://github.com/Acme/Web", pinSha: "abc1234" })]);
    expect(doc.enqueueDrafts).toBe(false);

    const repos = parsePinDocument(
      JSON.stringify({
        repos: [{ repo: "acme/web", license: "Apache-2.0", pinned_sha: "abc1234", takes: "audit" }],
      }),
    );
    expect(repos.pins[0]).toMatchObject({
      url: "https://github.com/acme/web",
      licence: "Apache-2.0",
      pinSha: "abc1234",
      notes: "audit",
    });
  });

  it("keeps an explicit draft flag and ignores other truthy values", () => {
    expect(parsePinDocument(JSON.stringify({ enqueueDrafts: true, pins: [] })).enqueueDrafts).toBe(true);
    expect(parsePinDocument(JSON.stringify({ enqueueDrafts: "yes", pins: [] })).enqueueDrafts).toBe(false);
    expect(parsePinDocument(JSON.stringify({ enqueueDrafts: 1, pins: [] })).enqueueDrafts).toBe(false);
    expect(parsePinDocument(JSON.stringify({ revision: -3, pins: [] })).revision).toBe(0);
  });

  it("drops logins, bad pins, secrets, home paths and duplicate addresses", () => {
    const read = readPinRows(
      JSON.stringify({
        pins: [
          { url: `https://user:${TOKEN}@github.com/acme/web`, notes: "no" },
          { url: "https://github.com/acme/web", pinSha: "nope", notes: "bad pin" },
          { url: "https://github.com/acme/web", pinSha: "abc1234", notes: `see ${TOKEN} and /Users/example/notes` },
          { url: "https://github.com/Acme/Web.git", pinSha: "abc1234", notes: "second" },
          { repo: "not a repo" },
          {},
        ],
      }),
    );
    expect(read.pins).toHaveLength(1);
    expect(read.pins[0]?.notes).not.toContain(TOKEN);
    expect(read.pins[0]?.notes).not.toContain("/Users/example");
    expect(read.pins[0]?.notes).toContain("second");
    expect(read.skipped.some((line) => line.includes("login"))).toBe(true);
    expect(read.skipped.some((line) => line.includes("pin"))).toBe(true);
    expect(read.skipped.some((line) => line.includes("duplicate"))).toBe(true);
    expect(JSON.stringify(read)).not.toContain(TOKEN);
    expect(JSON.stringify(read)).not.toContain("/Users/example");
  });

  it("does not turn draft upgrades on just because the imported file says so", () => {
    const report = importPinText(emptyPins(), JSON.stringify({
      enqueueDrafts: true,
      pins: [{ url: "https://github.com/acme/web", pinSha: "abc1234", licence: "MIT" }],
    }));
    expect(report.document.enqueueDrafts).toBe(false);
    expect(report.added).toBe(1);
    const again = importPinText(report.document, JSON.stringify({
      pins: [{ url: "https://github.com/acme/web", notes: "newer" }],
    }));
    expect(again.added).toBe(0);
    expect(again.updated).toBe(1);
    expect(again.document.pins[0]?.notes).toBe("newer");
    expect(again.document.enqueueDrafts).toBe(false);
  });

  it("leaves the current list alone when the import cannot be read", () => {
    const current = { ...emptyPins(), pins: [pin()] };
    const report = importPinText(current, "{");
    expect(report.document).toEqual(current);
    expect(report.added).toBe(0);
    expect(report.skipped).toEqual(["That file could not be read."]);
  });

  it("round trips without extra fields", () => {
    const doc = { revision: 2, enqueueDrafts: false, pins: [pin()] };
    const again = parsePinDocument(serializePinDocument(doc));
    expect(again).toEqual(doc);
    expect(serializePinDocument(doc)).not.toContain("takes");
  });

  it("strips a byte order mark", () => {
    const text = `${String.fromCharCode(0xfeff)}${JSON.stringify({ pins: [{ url: "acme/web", pinSha: "abc1234" }] })}`;
    expect(parsePinDocument(text).pins[0]?.url).toBe("https://github.com/acme/web");
  });
});

describe("compare and swap", () => {
  it("refuses a write when the revision moved", () => {
    const current = { ...emptyPins(), revision: 2, pins: [pin()] };
    expect(commitPins(current, 1, { pins: [], enqueueDrafts: false }).ok).toBe(false);
    const ok = commitPins(current, 2, { pins: [], enqueueDrafts: false });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.document.revision).toBe(3);
  });

  it("retries onto the list the other window saved", async () => {
    const root = "/work/proj";
    const io = memoryPinIo(serializePinDocument({ ...emptyPins(), revision: 1, pins: [pin()] }));
    const real = io.write.bind(io);
    let writes = 0;
    io.write = async (project, body, expected) => {
      writes += 1;
      if (writes === 1) {
        const other = pin({ url: "https://github.com/acme/other", notes: "other" });
        await real(
          project,
          serializePinDocument({ revision: 2, enqueueDrafts: false, pins: [pin(), other] }),
          1,
        );
        return false;
      }
      return real(project, body, expected);
    };
    const saved = await savePins(io, root, (doc) => ({
      pins: doc.pins.some((item) => item.notes === "from-a")
        ? doc.pins
        : [...doc.pins, pin({ notes: "from-a" })],
      enqueueDrafts: doc.enqueueDrafts,
    }));
    expect(saved.pins.map((item) => item.notes).sort()).toEqual(["door", "from-a", "other"]);
    expect(saved.revision).toBe(3);
  });

  it("does not write after the import was stopped", async () => {
    const io = memoryPinIo();
    const signal = { aborted: true };
    await expect(savePins(io, "/work/proj", () => ({ pins: [pin()], enqueueDrafts: false }), signal)).rejects.toMatchObject({
      final: false,
    });
    expect(io.text()).toBeNull();
  });

  it("treats a timeout as something to retry, not a finished failure", async () => {
    const io = memoryPinIo();
    io.read = async () => {
      throw new Error("timed out");
    };
    await expect(savePins(io, "/work/proj", () => ({ pins: [], enqueueDrafts: false }))).rejects.toBeInstanceOf(PinIoError);
    try {
      await savePins(io, "/work/proj", () => ({ pins: [], enqueueDrafts: false }));
    } catch (error) {
      expect(error).toBeInstanceOf(PinIoError);
      expect((error as PinIoError).final).toBe(false);
      expect((error as PinIoError).message).not.toContain("/work");
    }
  });
});

describe("folder import", () => {
  it("prefers repo-pins.json and treats a missing file as not that name", async () => {
    const read = async (path: string) => {
      if (path.endsWith("repo-pins.json")) throw new Error("no such file");
      if (path.endsWith("repos.json")) return JSON.stringify({ repos: [{ repo: "acme/web" }] });
      throw new Error("no such file");
    };
    const found = await textFromFolder("/work/My Project", read);
    expect(found.name).toBe("repos.json");
    expect(found.text).toContain("acme/web");
  });

  it("says when the folder has neither file", async () => {
    await expect(textFromFolder("/work/proj", async () => {
      throw new Error("ENOENT");
    })).rejects.toMatchObject({ message: "That folder has no pin file.", final: true });
  });

  it("a timeout is not an empty folder", async () => {
    await expect(textFromFolder("/work/proj", async () => {
      throw new Error("timed out");
    })).rejects.toMatchObject({ final: false });
  });

  it("reads only the known names inside the folder", async () => {
    const seen: string[] = [];
    await expect(textFromFolder("/work/My Project", async (path) => {
      seen.push(path);
      throw new Error("no such file");
    })).rejects.toMatchObject({ final: true });
    expect(seen).toEqual([
      "/work/My Project/repo-pins.json",
      "/work/My Project/repos.json",
    ]);
  });
});

describe("clean text", () => {
  it("removes tokens and home paths", () => {
    const cleaned = cleanText(`note ${TOKEN} /Users/example/secret C:\\Users\\example\\secret`);
    expect(cleaned).not.toContain(TOKEN);
    expect(cleaned).not.toContain("/Users/example");
    expect(cleaned).not.toContain("C:\\Users\\example");
    expect(cleaned).toContain("[secret removed]");
    expect(cleaned).toContain("a local path");
  });
});
