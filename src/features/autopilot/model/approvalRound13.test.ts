// Round 13: a Windows temp folder is itself an 8.3 short name (`C:\Users\RUNNER~1\...`). That name is the chat folder,
// not a file the chat named, so the short-name hold applies only below the folder. A `~1` name under the folder still waits.
import { describe, expect, it } from "vitest";
import { credentialInPaths, credentialPath } from "./credentialPaths";
import { placeStaysInside, type Canonical, type Locate } from "./safeApproval";

const outsideGit: Locate = async (paths) => paths.map(() => null);
/** The landing spelling differs from the naive join (slash vs backslash), so the short-name check actually runs. */
const canonical: Canonical = async (paths) => paths.map((p) => p.replace(/\//g, "\\"));

const CHAT = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\r\\outside\\chat";

describe("round 13: a short name in the chat folder itself is not a hold", () => {
  it("allows a read and an edit inside a folder that has a ~1 component, and holds a ~1 name below it", async () => {
    expect(credentialPath(`${CHAT}\\src\\app.ts`, true, CHAT)).toBe(false);
    expect(credentialInPaths([`${CHAT}\\src\\app.ts`], CHAT)).toBeNull();
    expect(await placeStaysInside({ tool: "Bash", command: "cat src/app.ts" } as any, CHAT, outsideGit, canonical)).toBeNull();
    expect(await placeStaysInside({ tool: "Read", paths: [`${CHAT}\\src\\app.ts`] } as any, CHAT, outsideGit, canonical)).toBeNull();
    expect(await placeStaysInside({ tool: "Write", paths: [`${CHAT}\\src\\new.ts`] } as any, CHAT, outsideGit, canonical)).toBeNull();
    expect(credentialPath(`${CHAT}\\src\\ENV~1`, true, CHAT)).toBe(true);
    expect(await placeStaysInside({ tool: "Bash", command: "cat src/ENV~1" } as any, CHAT, outsideGit, canonical)).not.toBeNull();
    expect(await placeStaysInside({ tool: "Read", paths: [`${CHAT}\\src\\ENV~1`] } as any, CHAT, outsideGit, canonical)).not.toBeNull();
  });
});
