// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { findBotChange, recordPageSource, redoBotChange, undoBotChange } from "../../hub/model/botChanges";
import {
  allowsUrl,
  connectSource,
  covers,
  disconnectSource,
  forgetAllGrants,
  grantedUrls,
  grantsFor,
  hostLabel,
  MAX_PER_PAGE,
  validSource,
} from "./pageGrants";

beforeEach(() => {
  localStorage.clear();
  forgetAllGrants();
});

it("takes https and nothing else, and never a name, a password, this Mac or the local network", () => {
  const error = (raw: string) => {
    const out = validSource(raw);
    return out.ok ? "" : out.error;
  };
  expect(error("http://api.example.com")).toContain("https://");
  expect(error("https://me:secret@api.example.com")).toContain("name and password");
  expect(error("https://localhost:3000")).toContain("local network");
  expect(error("https://127.0.0.1")).toContain("local network");
  expect(error("https://192.168.1.20")).toContain("local network");
  expect(error("https://169.254.169.254/latest/meta-data")).toContain("local network");
  expect(error("https://svc.internal")).toContain("local network");
  expect(error("not a url")).toContain("https://");
  expect(error("   ")).toContain("web address");
});

it("keeps the path it was given, and is called by its host unless Ash names it", () => {
  expect(validSource("https://api.example.com/v1/")).toEqual({
    ok: true,
    value: { url: "https://api.example.com/v1", origin: "https://api.example.com", label: "api.example.com" },
  });
  expect(validSource("https://api.example.com/")).toEqual({
    ok: true,
    value: { url: "https://api.example.com", origin: "https://api.example.com", label: "api.example.com" },
  });
  const named = validSource("https://api.example.com", "  The API  ");
  expect(named.ok && named.value.label).toBe("The API");
});

it("a grant covers what is under its path, never a sibling path or another host", () => {
  const grant = { url: "https://api.example.com/v1" };
  expect(covers(grant, "https://api.example.com/v1")).toBe(true);
  expect(covers(grant, "https://api.example.com/v1/players?page=2")).toBe(true);
  expect(covers(grant, "https://api.example.com/v10")).toBe(false);
  expect(covers(grant, "https://api.example.com/v2")).toBe(false);
  expect(covers(grant, "https://other.example.com/v1")).toBe(false);
  expect(covers(grant, "http://api.example.com/v1")).toBe(false);
  expect(covers(grant, "not a url")).toBe(false);
  expect(covers({ url: "https://api.example.com" }, "https://api.example.com/anything/at/all")).toBe(true);
});

it("connects a source to one page only, and says so when it is already there", () => {
  const out = connectSource("page-a", "https://api.example.com/v1", "The API");
  expect(out.ok).toBe(true);
  expect(grantsFor("page-a").map((g) => [g.url, g.label])).toEqual([["https://api.example.com/v1", "The API"]]);
  expect(grantsFor("page-b")).toEqual([]);
  expect(localStorage.getItem("monocode:hub-page-sources")).toContain("api.example.com");

  const again = connectSource("page-a", "https://api.example.com/v1/");
  expect(again.ok).toBe(false);
  expect(!again.ok && again.error).toBe("The hub is already connected to The API.");
});

it(`a page can be connected to ${MAX_PER_PAGE} sources at once`, () => {
  for (let i = 0; i < MAX_PER_PAGE; i++) {
    expect(connectSource("page-a", `https://api${i}.example.com`).ok).toBe(true);
  }
  const over = connectSource("page-a", "https://one-too-many.example.com");
  expect(over.ok).toBe(false);
  expect(!over.ok && over.error).toContain(`${MAX_PER_PAGE} sources`);
});

it("disconnects one source, and only if it was connected", () => {
  connectSource("page-a", "https://api.example.com/v1");
  connectSource("page-a", "https://other.example.com");
  expect(disconnectSource("page-a", "https://api.example.com/v1")).toBe(true);
  expect(grantsFor("page-a").map((g) => g.url)).toEqual(["https://other.example.com"]);
  expect(disconnectSource("page-a", "https://api.example.com/v1")).toBe(false);
});

it("hands Rust each grant's own address, path included, and refuses an address outside the granted paths", () => {
  connectSource("page-a", "https://api.example.com/v1");
  connectSource("page-a", "https://api.example.com/v2");
  connectSource("page-a", "https://other.example.com");
  expect(grantedUrls("page-a")).toEqual(["https://api.example.com/v1", "https://api.example.com/v2", "https://other.example.com"]);
  expect(allowsUrl("page-a", "https://api.example.com/v2/players")).toBe(true);
  expect(allowsUrl("page-a", "https://api.example.com/v3")).toBe(false);
  expect(allowsUrl("page-a", "https://unconnected.example.com")).toBe(false);
});

it("names a source back to Ash by its host, never by its path", () => {
  expect(hostLabel("https://api.example.com/v1/secret")).toBe("api.example.com");
});

it("Undo takes a source away and Redo connects it again, both as Bot changes rows", async () => {
  connectSource("page-a", "https://api.example.com/v1");
  const id = recordPageSource({ by: "Scores", pageId: "page-a", url: "https://api.example.com/v1", connected: true });
  expect(findBotChange(id)?.line).toBe("The hub “Scores” can now read api.example.com");

  await undoBotChange([id]);
  expect(grantsFor("page-a")).toEqual([]);
  expect(findBotChange(id)?.undone).toBe(true);

  await redoBotChange([id]);
  expect(grantsFor("page-a").map((g) => g.url)).toEqual(["https://api.example.com/v1"]);
  expect(findBotChange(id)?.undone).toBe(false);
});
