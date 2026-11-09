// WP-105: the setup file really is in force. These tests are the positive proof that the guard fires
// through vitest's setupFiles, not just when called directly: each one makes the blocked call on purpose.

import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { allowNetworkForThisTest, GUARD_ERROR_NAME, setGuardHomeForTest } from "./harnessGuard";

describe("the guard is installed", () => {
  it("blocks fetch to a non-loopback host", () => {
    expect(() => fetch("https://example.com/")).toThrow(/blocks the network/);
    // The test caught the error, so teardown still fails it; clear the record so this file passes.
    allowNetworkForThisTest();
  });

  it("blocks node:http, node:https and node:net to a non-loopback host", () => {
    for (const call of [
      () => request("http://example.com/"),
      () => connect({ host: "example.com", port: 80 }),
      () => connect(443, "example.com"),
    ]) {
      expect(call).toThrow();
    }
    allowNetworkForThisTest();
  });

  it("lets a loopback call through to the connection attempt", async () => {
    // Port 1 on loopback is closed, so this fails to connect; the point is that the guard did not refuse it.
    await new Promise<void>((resolve) => {
      const socket = connect(1, "127.0.0.1");
      socket.on("error", () => resolve());
      socket.on("connect", () => {
        socket.destroy();
        resolve();
      });
    });
  });

  it("blocks a write into an agent folder, with a stand-in home so the real one is never touched", () => {
    const standIn = join(tmpdir(), "wp105-guard-home");
    setGuardHomeForTest(standIn);
    let threw: unknown;
    try {
      writeFileSync(join(standIn, ".claude", "should-not-exist-wp105"), "x");
    } catch (error) {
      threw = error;
    } finally {
      setGuardHomeForTest(null);
    }
    const detail = threw instanceof Error ? threw.message : String(threw);
    expect(threw, detail).toBeInstanceOf(Error);
    expect((threw as Error).name, detail).toBe(GUARD_ERROR_NAME);
  });
});
