import { describe, expect, it } from "vitest";
import { appLink } from "./link";

describe("appLink", () => {
  it("keeps a local http or https url", () => {
    expect(appLink("http://127.0.0.1:22010")).toBe("http://127.0.0.1:22010");
    expect(appLink("http://localhost:80")).toBe("http://localhost:80");
    expect(appLink("https://127.0.0.1:443")).toBe("https://127.0.0.1:443");
  });

  it("drops anything that is not this machine", () => {
    expect(appLink(null)).toBeNull();
    expect(appLink("")).toBeNull();
    expect(appLink("not a url")).toBeNull();
    expect(appLink("http://evil.example")).toBeNull();
    expect(appLink("http://127.0.0.1.evil")).toBeNull();
    expect(appLink("http://user:pw@127.0.0.1:80")).toBeNull();
    expect(appLink("javascript:alert(1)")).toBeNull();
    expect(appLink("file:///etc/passwd")).toBeNull();
  });
});
