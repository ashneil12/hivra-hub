// WP-101 review round 6, MED-1: the app's lookup places a read or an edit by where its last part really points. A link
// as the last part is followed by the Rust lookup (fs.rs git_locate_file), so a read whose last part is a link to a
// place outside the chat's folder waits, and a link that lands inside the folder does not. The stubs below return what
// the fixed lookup returns; fs.rs's own test (locate_follows_a_link_named_last) makes a real symlink.
import { describe, expect, it } from "vitest";
import { editStaysInside, placeStaysInside, readStaysInside, type Locate } from "./safeApproval";

const FOLDER = "/Users/example/proj";
const PROBE = ".monocode-autopilot-probe";

/** A stub lookup with the shape of git_locate_files: the probe places the folder; `map` gives each target's place. */
const locateWith =
  (map: Record<string, { root: string; relative: string; linked?: boolean } | null>): Locate =>
  async (paths) =>
    paths.map((path) => {
      if (path.endsWith(PROBE)) return { root: FOLDER, relative: PROBE };
      if (path in map) return map[path];
      return { root: FOLDER, relative: path.slice(FOLDER.length + 1) };
    });

const read = (paths: string[]) => ({ tool: "Read", paths, folderPinned: true }) as any;
const write = (paths: string[]) => ({ tool: "Write", paths }) as any;

describe("MED-1: a link as the last part of a path is placed where it points", () => {
  it("holds a read of a link whose target is in another checkout, even though its own name is in the folder", async () => {
    const locate = locateWith({ [`${FOLDER}/docs/link.md`]: { root: "/Users/example/elsewhere", relative: "notes/plan.md", linked: true } });
    expect(await readStaysInside(read(["docs/link.md"]), FOLDER, locate)).not.toBeNull();
    expect(await placeStaysInside(read(["docs/link.md"]), FOLDER, locate)).not.toBeNull();
  });

  it("holds a read of a link whose target is outside git (the lookup gives null)", async () => {
    const locate = locateWith({ [`${FOLDER}/docs/notes.txt`]: null });
    expect(await readStaysInside(read(["docs/notes.txt"]), FOLDER, locate)).not.toBeNull();
  });

  it("holds a search whose path ends in a link out of the folder", async () => {
    const locate = locateWith({ [`${FOLDER}/linked`]: { root: "/Users/example", relative: ".aws", linked: true } });
    expect(await readStaysInside({ tool: "Grep", pattern: "x", paths: ["linked"] } as any, FOLDER, locate)).not.toBeNull();
  });

  it("holds a write through a link that leaves the folder", async () => {
    const locate = locateWith({ [`${FOLDER}/zshrc-link`]: null });
    expect(await editStaysInside(write(["zshrc-link"]), FOLDER, locate)).not.toBeNull();
    const elsewhere = locateWith({ [`${FOLDER}/zshrc-link`]: { root: "/Users/example", relative: ".zshrc", linked: true } });
    expect(await editStaysInside(write(["zshrc-link"]), FOLDER, elsewhere)).not.toBeNull();
  });

  it("allows a link whose target is an ordinary file inside the same checkout", async () => {
    const locate = locateWith({ [`${FOLDER}/docs/app.md`]: { root: FOLDER, relative: "src/app.ts", linked: true } });
    expect(await readStaysInside(read([`${FOLDER}/docs/app.md`]), FOLDER, locate)).toBeNull();
  });
});

describe("MED-1: a shell command's words are placed too (round 6)", () => {
  const bash = (command: string) => ({ tool: "Bash", command, folderPinned: true }) as any;

  it("holds a command that reads a link out of the folder by its name in the folder", async () => {
    const locate = locateWith({ [`${FOLDER}/docs/linked`]: { root: "/Users/example", relative: ".aws", linked: true } });
    expect(await placeStaysInside(bash("cat docs/linked"), FOLDER, locate)).not.toBeNull();
    expect(await placeStaysInside(bash("grep -n key docs/linked"), FOLDER, locate)).not.toBeNull();
  });

  it("holds a word whose folder is a link out of git (the lookup gives null)", async () => {
    const locate = locateWith({ [`${FOLDER}/linkdir/x`]: null });
    expect(await placeStaysInside(bash("cat linkdir/x"), FOLDER, locate)).not.toBeNull();
  });

  it("holds a word whose real place is a login file, however the link was named", async () => {
    const locate = locateWith({ [`${FOLDER}/notes`]: { root: "/Users/example", relative: ".netrc", linked: true } });
    expect(await placeStaysInside(bash("cat notes"), FOLDER, locate)).not.toBeNull();
  });

  it("allows ordinary words, patterns and revisions that stay in the folder", async () => {
    const locate = locateWith({});
    expect(await placeStaysInside(bash("rg -n token src"), FOLDER, locate)).toBeNull();
    expect(await placeStaysInside(bash("git diff HEAD~1 -- src/app.ts"), FOLDER, locate)).toBeNull();
    expect(await placeStaysInside(bash("cat docs/app.md"), FOLDER, locate)).toBeNull();
  });

  it("allows a link inside the folder that lands on a file inside it", async () => {
    const locate = locateWith({ [`${FOLDER}/docs/alias`]: { root: FOLDER, relative: "src/app.ts", linked: true } });
    expect(await placeStaysInside(bash("cat docs/alias"), FOLDER, locate)).toBeNull();
  });

  it("holds a command whose lookup fails", async () => {
    const failing: Locate = async () => {
      throw new Error("lookup down");
    };
    expect(await placeStaysInside(bash("cat docs/app.md"), FOLDER, failing)).not.toBeNull();
  });
});
