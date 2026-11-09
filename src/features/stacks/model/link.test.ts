import { describe, expect, it } from "vitest";
import { appLink } from "./link";

describe("appLink", () => {
  it("keeps a local http or https url", () => {
    expect(appLink("http://127.0.0.1:22010")).toBe("http://127.0.0.1:22010");
    expect(appLink("http://localhost:80")).toBe("http://localhost:80");
    expect(appLink("https://127.0.0.1:443")).toBe("https://127.0.0.1:443");
  });

  it("keeps a worktree's published name", () => {
    // WP-90: the named address is what the task card links.
    expect(appLink("http://shop-wp-90.localhost:7400")).toBe(
      "http://shop-wp-90.localhost:7400",
    );
    expect(appLink("https://github-ab12cd34.localhost:7400")).toBe(
      "https://github-ab12cd34.localhost:7400",
    );
  });

  it("drops anything that is not this machine", () => {
    expect(appLink(null)).toBeNull();
    expect(appLink("")).toBeNull();
    expect(appLink("not a url")).toBeNull();
    expect(appLink("http://evil.example")).toBeNull();
    expect(appLink("http://127.0.0.1.evil")).toBeNull();
    expect(appLink("http://shop-wp-90.localhost.evil")).toBeNull();
    expect(appLink("http://shop_wp_90.localhost:7400")).toBeNull();
    expect(appLink("http://user:pw@127.0.0.1:80")).toBeNull();
    expect(appLink("javascript:alert(1)")).toBeNull();
    expect(appLink("file:///etc/passwd")).toBeNull();
  });
});
