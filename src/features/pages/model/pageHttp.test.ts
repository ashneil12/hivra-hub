// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from "vitest";
import { forgetAllGrants, connectSource } from "./pageGrants";
import {
  clearSourceToken,
  fetchRefusal,
  hasSourceToken,
  pageFetch,
  pageHttpHandlers,
  setPageHttpRunner,
  setPageTokenStore,
  setSourceToken,
} from "./pageHttp";

type Request = {
  pageId: string;
  url: string;
  grants: string[];
  method: string;
  body?: string;
  accept?: string;
  contentType?: string;
};

const sent: Request[] = [];
function useRunner(): void {
  setPageHttpRunner(async (request) => {
    sent.push(request);
    return { status: 200, type: "application/json", body: `{"ok":true}`, url: request.url };
  });
}

beforeEach(() => {
  localStorage.clear();
  forgetAllGrants();
  sent.length = 0;
  useRunner();
});

afterEach(() => {
  setPageHttpRunner(undefined);
  setPageTokenStore(undefined);
});

it("says in plain words when a page asks for an address nobody connected", () => {
  expect(fetchRefusal("https://api.example.com/v1")).toBe(
    "This hub isn't connected to api.example.com, so it can't read it. Connect the source on the hub first (Hubs → the hub → Connected sources).",
  );
  expect(fetchRefusal("not a url")).toContain("https://");
});

it("refuses an address the page wasn't connected to, and never goes out", async () => {
  connectSource("page-a", "https://api.example.com/v1");
  await expect(pageFetch("page-a", { url: "https://other.example.com" })).rejects.toThrow("This hub isn't connected to other.example.com");
  await expect(pageFetch("page-a", { url: "https://api.example.com/v2" })).rejects.toThrow("isn't connected");
  expect(sent).toEqual([]);
});

it("sends the request through the app with the page's grants, path included, trim, and GET by default", async () => {
  connectSource("page-a", "https://api.example.com/v1");
  const reply = await pageFetch("page-a", { url: "  https://api.example.com/v1/players  " });
  expect(reply).toMatchObject({ status: 200, type: "application/json", body: '{"ok":true}' });
  expect(sent).toEqual([
    { pageId: "page-a", url: "https://api.example.com/v1/players", grants: ["https://api.example.com/v1"], method: "GET", body: undefined, accept: undefined, contentType: undefined },
  ]);
});

it("sends what the page may set, and nothing else", async () => {
  connectSource("page-a", "https://api.example.com/v1");
  await pageFetch("page-a", {
    url: "https://api.example.com/v1/players",
    method: "post",
    body: "{}",
    accept: "a".repeat(500),
    contentType: "application/json",
    token: "a page can't set this",
    headers: { Authorization: "Bearer nope" },
  });
  const request = sent[0] as Request & Record<string, unknown>;
  expect(request.method).toBe("POST");
  expect(request.body).toBe("{}");
  expect(request.accept).toHaveLength(200);
  expect(request.contentType).toBe("application/json");
  expect(request.token).toBeUndefined();
  expect(request.headers).toBeUndefined();
});

it("asks for an address, a plain method and a body that fits", async () => {
  connectSource("page-a", "https://api.example.com/v1");
  await expect(pageFetch("page-a", {})).rejects.toThrow("needs an address");
  await expect(pageFetch("page-a", { url: "https://api.example.com/v1", method: "TRACE" })).rejects.toThrow("“TRACE”");
  await expect(pageFetch("page-a", { url: "https://api.example.com/v1", body: "{}" })).rejects.toThrow("GET request can't have a body");
  await expect(pageFetch("page-a", { url: "https://api.example.com/v1", method: "HEAD", body: "{}" })).rejects.toThrow("HEAD request can't have a body");
  await expect(pageFetch("page-a", { url: "https://api.example.com/v1", method: "POST", body: "a".repeat(100_001) })).rejects.toThrow("too long");
  expect(sent).toEqual([]);
});

it("keeps a source's token in the app's store, never in what the page sends", async () => {
  const calls: string[] = [];
  const tokens = new Map<string, string>();
  setPageTokenStore({
    set: async (pageId, origin, token) => {
      calls.push(`set ${pageId} ${origin}`);
      tokens.set(`${pageId} ${origin}`, token);
    },
    has: async (pageId, origin) => tokens.has(`${pageId} ${origin}`),
    clear: async (pageId, origin) => tokens.delete(`${pageId} ${origin}`),
  });

  await setSourceToken("page-a", "https://api.example.com", "  tok-123  ");
  expect(tokens.get("page-a https://api.example.com")).toBe("tok-123");
  expect(calls).toEqual(["set page-a https://api.example.com"]);
  await setSourceToken("page-a", "https://api.example.com", "   ");
  expect(calls).toHaveLength(1);
  expect(await hasSourceToken("page-a", "https://api.example.com")).toBe(true);
  expect(await clearSourceToken("page-a", "https://api.example.com")).toBe(true);
  expect(await hasSourceToken("page-a", "https://api.example.com")).toBe(false);

  connectSource("page-a", "https://api.example.com/v1");
  await pageFetch("page-a", { url: "https://api.example.com/v1/players" });
  expect(JSON.stringify(sent[0])).not.toContain("tok-123");
});

it("gives the bridge one handler, and its refusal reads as the plain reason", async () => {
  const handlers = pageHttpHandlers("page-a");
  expect(Object.keys(handlers)).toEqual(["http.fetch"]);
  await expect(handlers["http.fetch"]({ url: "https://api.example.com/v1" })).rejects.toThrow("This hub isn't connected to api.example.com");
  connectSource("page-a", "https://api.example.com/v1");
  await expect(handlers["http.fetch"]({ url: "https://api.example.com/v1" })).resolves.toMatchObject({ status: 200 });
});
