// WP-101 review round 5, M2: a read or a search resolves through links, as an edit already did. The app's lookup is
// stubbed here with the same shape it returns (a checkout root and a relative path, or null outside git).
import { describe, expect, it } from "vitest";
import { placeStaysInside, readStaysInside, type Locate } from "./safeApproval";

const FOLDER = "/Users/ash/proj";
const PROBE = ".monocode-autopilot-probe";

/** A stub lookup: the probe places the chat's folder; a target in `map` is placed as given (null: outside git). */
const locateWith =
  (map: Record<string, { root: string; relative: string } | null>): Locate =>
  async (paths) =>
    paths.map((path) => {
      if (path.endsWith(PROBE)) return { root: FOLDER, relative: PROBE };
      if (path in map) return map[path];
      return { root: FOLDER, relative: path.slice(FOLDER.length + 1) };
    });

const read = (paths: string[]) => ({ tool: "Read", paths }) as any;

describe("M2: reads and searches resolve through links", () => {
  it("holds a file inside the repo that links to a login in another place", async () => {
    const locate = locateWith({ [`${FOLDER}/docs/notes.txt`]: { root: "/Users/ash/elsewhere", relative: ".ssh/id_rsa" } });
    expect(await readStaysInside(read(["docs/notes.txt"]), FOLDER, locate)).not.toBeNull();
    expect(await placeStaysInside(read(["docs/notes.txt"]), FOLDER, locate)).not.toBeNull();
  });

  it("holds a read whose real place is outside git, or whose lookup fails", async () => {
    const outside = locateWith({ [`${FOLDER}/docs/link.txt`]: null });
    expect(await readStaysInside(read(["docs/link.txt"]), FOLDER, outside)).not.toBeNull();
    const failing: Locate = async () => {
      throw new Error("lookup down");
    };
    expect(await readStaysInside(read(["src/app.ts"]), FOLDER, failing)).not.toBeNull();
  });

  it("allows a link that lands on an ordinary file in the same checkout", async () => {
    const locate = locateWith({ [`${FOLDER}/docs/app.md`]: { root: FOLDER, relative: "src/app.ts" } });
    expect(await readStaysInside(read([`${FOLDER}/docs/app.md`]), FOLDER, locate)).toBeNull();
  });

  it("does not look up a search with no path, which walks the folder itself", async () => {
    // Round 10: a search with no path starts from its request's cwd, which the request names here.
    expect(await readStaysInside({ tool: "Grep", cwd: FOLDER } as any, FOLDER, locateWith({}))).toBeNull();
  });
});
