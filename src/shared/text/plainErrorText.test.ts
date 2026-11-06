import { describe, expect, it } from "vitest";
import { plainErrorText } from "./plainErrorText";

describe("plainErrorText", () => {
  it("turns a locked database into a sentence with what to do", () => {
    expect(plainErrorText(new Error("database is locked"))).toBe(
      "The hub's database is busy. Nothing was lost. Try again in a moment.",
    );
    expect(plainErrorText("database table is locked: sessions")).toContain(
      "Try again in a moment",
    );
  });

  it("turns a refused permission into a sentence with where to look", () => {
    expect(plainErrorText(new Error("Access is denied."))).toContain("Privacy and Security");
    expect(plainErrorText("EACCES: permission denied, open '/Users/ash/notes'")).toContain(
      "did not allow it",
    );
  });

  it("turns a missing file into a sentence with what to do", () => {
    expect(plainErrorText("No such file or directory (os error 2)")).toContain("another one");
    expect(plainErrorText(new Error("ENOENT: no such file or directory, open 'x'"))).toContain(
      "not there any more",
    );
  });

  it("covers a full disk and a damaged database", () => {
    expect(plainErrorText("No space left on device")).toContain("no room left");
    expect(plainErrorText("database disk image is malformed")).toContain("Export and import");
  });

  it("keeps what failed when the message names it before the cause", () => {
    expect(plainErrorText("Could not copy a.txt: Access is denied.")).toBe(
      "Could not copy a.txt. The computer did not allow it. Check the folder's permissions in System Settings, Privacy and Security, then try again.",
    );
    expect(plainErrorText("ENOENT: no such file or directory, open 'x'")).toContain("not there any more");
  });

  it("shows an unknown message as it came", () => {
    expect(plainErrorText(new Error("Disk full"))).toBe("Disk full");
    expect(plainErrorText("The helper quit")).toBe("The helper quit");
  });

  it("reads the message of a plain object, the shape a call from Rust can take", () => {
    expect(plainErrorText({ message: "database is locked" })).toContain("busy");
    expect(plainErrorText({ message: 12 })).toBe("That didn't work. Try again in a moment.");
  });

  it("never shows an empty string", () => {
    expect(plainErrorText("")).toBe("That didn't work. Try again in a moment.");
    expect(plainErrorText("   ")).toBe("That didn't work. Try again in a moment.");
    expect(plainErrorText(new Error(""))).toBe("That didn't work. Try again in a moment.");
    expect(plainErrorText(undefined)).toBe("That didn't work. Try again in a moment.");
    expect(plainErrorText(null)).toBe("That didn't work. Try again in a moment.");
    expect(plainErrorText(42)).toBe("That didn't work. Try again in a moment.");
  });

  it("shortens a long unknown message and trims it", () => {
    const long = plainErrorText(`  ${"x".repeat(500)}  `);
    expect(long.length).toBe(200);
    expect(long.endsWith("...")).toBe(true);
    expect(plainErrorText("  Disk full  ")).toBe("Disk full");
  });

  it("writes no em dash or en dash into any of its sentences", () => {
    for (const error of [
      "database is locked",
      "Access is denied",
      "No such file",
      "No space left on device",
      "database disk image is malformed",
      "read-only database",
      "",
      "Disk full",
    ]) {
      expect(plainErrorText(error)).not.toMatch(/[–—]/);
    }
  });
});
