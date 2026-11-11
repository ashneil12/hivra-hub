import { describe, expect, it } from "vitest";
import { pairCode, readMachine, sshTarget } from "./machine";

describe("pairing", () => {
  it("accepts a one-time code and nothing that looks like a key or a URL", () => {
    expect(pairCode("ABCD-1234")).toBe("ABCD-1234");
    expect(pairCode("  abcd-1234  ")).toBe("abcd-1234");
    expect(pairCode("short")).toBeNull();
    expect(pairCode("has space 12")).toBeNull();
    expect(pairCode("https://x.example/key")).toBeNull();
    expect(pairCode("tok+en/key=")).toBeNull();
    expect(pairCode(`${"a".repeat(65)}`)).toBeNull();
  });

  it("reads a machine without treating a bad SSH address as something to add", () => {
    expect(readMachine({ id: "m1", label: "Desk", sshHost: "me@cloud" })).toEqual({
      id: "m1",
      label: "Desk",
      sshHost: "me@cloud",
    });
    expect(readMachine({ id: "m1", label: "Desk" })?.sshHost).toBeNull();
    expect(readMachine({ id: "m1", label: "Desk", sshHost: "https://user:pw@cloud.example/key" })).toMatchObject({
      sshHost: null,
    });
    expect(readMachine({ id: "", label: "Desk", sshHost: "me@cloud" })).toBeNull();
    expect(readMachine(null)).toBeNull();
    expect(readMachine({ id: "m1", label: "Desk", sshHost: "-oProxyCommand=curl" })).toMatchObject({
      sshHost: null,
    });
  });

  it("uses the same SSH address rules as Add machine", () => {
    expect(sshTarget("me@cloud")).toBe("me@cloud");
    expect(sshTarget(" my-mac ")).toBe("my-mac");
    expect(sshTarget("")).toBeNull();
    expect(sshTarget("-oProxyCommand=x")).toBeNull();
    expect(sshTarget("a@b@c")).toBeNull();
    expect(sshTarget("has space")).toBeNull();
  });
});
