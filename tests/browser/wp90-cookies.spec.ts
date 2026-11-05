import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * WP-90: two worktree names are two origins. A cookie set on one is never sent to the other,
 * which is the whole reason a port alone is not an address. The proxy is host-transparent;
 * this proves the browser rule the proxy relies on, on the real engine.
 */
let server: Server;
let base = "";

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const host = request.headers.host ?? "";
    if (request.url === "/set") {
      response.writeHead(200, {
        "Content-Type": "text/plain",
        "Set-Cookie": `sid=${host.split(".")[0]}; Path=/`,
      });
      response.end("set");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(request.headers.cookie ?? "no-cookie");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://one.localhost:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("a cookie set under one worktree name is absent under the other", async ({ page }) => {
  const one = base;
  const two = base.replace("http://one.", "http://two.");
  await page.goto(`${one}/set`);
  await expect(page.locator("body")).toHaveText("set");

  await page.goto(`${two}/get`);
  await expect(page.locator("body")).toHaveText("no-cookie");

  await page.goto(`${one}/get`);
  await expect(page.locator("body")).toHaveText("sid=one");
});
