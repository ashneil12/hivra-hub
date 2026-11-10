// Tests for the loopback relay that holds the OpenRouter key for a sandboxed bench (scripts/bench-or-relay.mjs), and for
// the run around it: the profile it builds, the launcher grant it needs, and the guard that refuses an unsandboxed one.
//
// Nothing here touches the network beyond 127.0.0.1, Ash's Keychain, or his launcher: the upstream is a fake HTTP server
// this file starts, the key is a made-up string, and every launcher path is a file in a temporary folder.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { RELAY_NO_KEY, RELAY_TOKEN_ENV, RELAY_URL_ENV, startOpenRouterRelay } from "./bench-or-relay.mjs";
import { agentCommand, cliReadOnlyPaths, namedLoopbackPorts } from "./bench-sandbox.mjs";
import { unsandboxedAgents } from "./bench-guard.mjs";
import { childEnv } from "./hub-realtest-claude.mjs";
import { claudeWrapperScript, runBench } from "./hub-realtest.mjs";

/** Not a key: every test here makes up its own, and none of them is ever a real one. */
const FAKE_KEY = "sk-or-fake-not-a-real-key-0123456789";
const REAL = "/Users/example";

/** A fake upstream on 127.0.0.1. `handler(req, res, body)` answers; every request it got is kept in `seen`. */
function upstream(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, host: req.headers.host, headers: req.headers, body: body.toString("utf8") });
      handler(req, res, body, seen.length);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        seen,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * One call to a relay, with the pieces a test cares about: status, headers, the whole body and the read boundaries.
 * `rawPath` puts those exact bytes in the request line, which a caller could do and `new URL` would otherwise rewrite.
 */
function ask(url, { token, body, method = "POST", headers = {}, rawPath = null } = {}) {
  return new Promise((resolve, reject) => {
    const sent = { "content-type": "application/json", ...headers };
    if (token !== undefined) sent.authorization = `Bearer ${token}`;
    const target = new URL(url);
    const path = rawPath ?? `${target.pathname}${target.search}`;
    const req = http.request({ host: target.hostname, port: Number(target.port), path, method, headers: sent }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, chunks: chunks.map((chunk) => chunk.toString("utf8")), text: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/**
 * A relay in front of a fake upstream that records every request and answers 200. `upstreamPath` is appended to the
 * upstream base, the way the real OpenRouter address ends in `/api`.
 */
async function withRelay(run, { upstreamPath = "" } = {}) {
  const up = await upstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const relay = await startOpenRouterRelay({ readKey: () => FAKE_KEY, upstream: `${up.url}${upstreamPath}`, model: "relay/one" });
  try {
    await run(relay, up);
  } finally {
    await relay.close();
    await up.close();
  }
}

/** One authenticated call the relay must not forward. The default body tries both ways of naming a model. `null` sends no body. */
async function refused(method, rawPath, body = { model: "attacker/choice", models: ["attacker/other"], messages: [{ role: "user", content: "hi" }] }) {
  let answer;
  await withRelay(async (relay, up) => {
    answer = await ask(relay.url, {
      token: relay.token,
      method,
      rawPath,
      ...(body === null ? {} : { body }),
    });
    assert.equal(up.seen.length, 0, `${method} ${rawPath} was forwarded`);
    assert.equal(answer.text.includes(FAKE_KEY), false, "a refusal echoed the key");
  });
  return answer;
}

const POST_ONLY = "this relay only forwards POST\n";
const PATHS_ONLY = "this relay only forwards /v1/messages and /v1/messages/count_tokens\n";

/** Try to connect to a loopback port; resolves with the connection's error (never rejects on a refusal). */
function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.on("connect", () => {
      socket.destroy();
      reject(new Error(`port ${port} still accepts connections`));
    });
    socket.on("error", (error) => {
      socket.destroy();
      resolve(error);
    });
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error(`connecting to ${port} timed out`));
    });
  });
}

/** Everything this process prints while `body` runs, so a test can prove the key never reached a log line. */
async function withCapturedOutput(body) {
  const written = [];
  const original = { log: console.log, error: console.error, warn: console.warn, write: process.stdout.write };
  const note = (...args) => {
    written.push(args.map((item) => String(item)).join(" "));
  };
  console.log = (...args) => {
    note(...args);
    return original.log.apply(console, args);
  };
  console.error = (...args) => {
    note(...args);
    return original.error.apply(console, args);
  };
  console.warn = (...args) => {
    note(...args);
    return original.warn.apply(console, args);
  };
  process.stdout.write = (...args) => {
    note(...args);
    return original.write.apply(process.stdout, args);
  };
  try {
    return { value: await body(), written };
  } finally {
    Object.assign(console, { log: original.log, error: original.error, warn: original.warn });
    process.stdout.write = original.write;
  }
}

test("a call with the wrong token, or none, is refused and nothing is forwarded", async () => {
  const up = await upstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const relay = await startOpenRouterRelay({ readKey: () => FAKE_KEY, upstream: up.url, model: "relay/one" });
  try {
    const wrong = await ask(`${relay.url}/v1/messages`, { token: "not-this-run", body: { model: "x" } });
    assert.equal(wrong.status, 401);
    assert.equal(up.seen.length, 0);
    const none = await ask(`${relay.url}/v1/messages`, { body: { model: "x" } });
    assert.equal(none.status, 401);
    // The other half of the pair the CLI may send, also wrong.
    const headers = await ask(`${relay.url}/v1/messages`, { body: { model: "x" }, headers: { "x-api-key": "not-this-run" } });
    assert.equal(headers.status, 401);
    // A right `x-api-key` is a right token.
    const byHeader = await ask(`${relay.url}/v1/messages`, { body: { model: "x" }, headers: { "x-api-key": relay.token } });
    assert.equal(byHeader.status, 200);
    assert.equal(up.seen.length, 1);
  } finally {
    await relay.close();
    await up.close();
  }
});

test("the right token is swapped for the key, and the model is rewritten", async () => {
  const up = await upstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const keyReads = [];
  const relay = await startOpenRouterRelay({
    readKey: () => {
      keyReads.push(1);
      return FAKE_KEY;
    },
    upstream: up.url,
    model: "relay/one",
  });
  try {
    const answer = await ask(`${relay.url}/v1/messages?beta=true`, { token: relay.token, body: { model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] } });
    assert.equal(answer.status, 200);
    assert.equal(answer.text, '{"ok":true}');
    assert.equal(up.seen.length, 1);
    const got = up.seen[0];
    // The query on an allowed path is kept.
    assert.equal(got.url, "/v1/messages?beta=true");
    // The key, never the inbound token.
    assert.equal(got.headers.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(JSON.stringify(got.headers).includes(relay.token), false);
    // The one model, whatever the caller asked for.
    assert.equal(JSON.parse(got.body).model, "relay/one");
    assert.match(got.body, /"content":"hi"/);
    // The key that this run minted is 24 random bytes, in hex.
    assert.match(relay.token, /^[0-9a-f]{48}$/);
    // A body that isn't a JSON object is forwarded byte for byte.
    const notJson = await ask(`${relay.url}/v1/messages`, { token: relay.token, headers: { "content-type": "text/plain" }, body: undefined });
    assert.equal(up.seen.length, 2);
    assert.equal(up.seen[1].body, "");
    // A caller writes the request line itself, so it is untrusted. `..` that still names an allowed path cannot climb
    // out of the upstream's host, and a path that names another host is refused rather than followed.
    const climbed = await ask(relay.url, { token: relay.token, rawPath: "/../../v1/messages", body: { model: "x" } });
    assert.equal(climbed.status, 200);
    assert.equal(up.seen.length, 3);
    assert.equal(up.seen[2].host, up.url.replace("http://", ""));
    assert.equal(up.seen[2].url, "/v1/messages");
    const escaped = await ask(relay.url, { token: relay.token, rawPath: "http://elsewhere.example/v1/messages", body: { model: "x" } });
    assert.equal(escaped.status, 403);
    assert.equal(escaped.text, PATHS_ONLY);
    assert.equal(escaped.text.includes("elsewhere.example"), false);
    assert.equal(up.seen.length, 3);
    // The key is read once, at start, and never again: five calls did not touch the Keychain five times.
    assert.equal(keyReads.length, 1);
  } finally {
    await relay.close();
    await up.close();
  }
});

for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]) {
  test(`${method} /v1/messages is refused and nothing is forwarded`, async () => {
    // No body: Node answers 400 itself for some of these methods when a body is attached, and the relay never sees the call.
    const answer = await refused(method, "/v1/messages", null);
    assert.equal(answer.status, 405);
    assert.equal(answer.headers.allow, "POST");
    // HEAD has no body. Every other refusal says what is allowed, and never the caller's path.
    if (method !== "HEAD") assert.equal(answer.text, POST_ONLY);
  });
}

test("a method Node will not parse is not forwarded", async () => {
  // FOO never reaches the relay: Node answers 400 first. The refusal is still that nothing is forwarded.
  const answer = await refused("FOO", "/v1/messages", null);
  assert.equal(answer.status, 400);
  assert.equal(answer.text.includes(FAKE_KEY), false);
});

for (const rawPath of [
  "/v1/models",
  "/v1/chat/completions",
  "/v1/completions",
  "/api/v1/messages",
  "/v1/messages/",
  "/v1/messages/count_tokens/",
  "/v1/Messages",
  "/v1/messages/count_Tokens",
  "/",
  "/v1/messages/../models",
  "/v1/messages-evil",
  "/v1/messages/count_tokens/extra",
  "/not-a-path",
  "/../../v1/models",
  "/v1/%2e%2e/models",
  "//evil.example/v1/messages",
  "http://elsewhere.example/v1/messages",
]) {
  test(`POST ${rawPath} is refused and nothing is forwarded`, async () => {
    const answer = await refused("POST", rawPath);
    assert.equal(answer.status, 403);
    // The whole answer is the fixed sentence, so the caller's path (a host, `..`, anything) is not echoed.
    assert.equal(answer.text, PATHS_ONLY);
  });
}

test("a wrong token on a bad path is still a 401, and nothing is forwarded", async () => {
  await withRelay(async (relay, up) => {
    const answer = await ask(relay.url, { token: "not-this-run", method: "GET", rawPath: "/v1/models", body: { model: "x" } });
    assert.equal(answer.status, 401);
    assert.equal(up.seen.length, 0);
    assert.equal(answer.text.includes("/v1/models"), false);
  });
});

test("a refused call does not stop the relay answering a later post", async () => {
  await withRelay(async (relay, up) => {
    const method = await ask(relay.url, { token: relay.token, method: "DELETE", rawPath: "/v1/messages" });
    assert.equal(method.status, 405);
    const path = await ask(relay.url, { token: relay.token, rawPath: "/v1/models", body: { model: "x" } });
    assert.equal(path.status, 403);
    const ok = await ask(`${relay.url}/v1/messages`, { token: relay.token, body: { messages: [{ role: "user", content: "still here" }] } });
    assert.equal(ok.status, 200);
    assert.equal(up.seen.length, 1);
    assert.equal(JSON.parse(up.seen[0].body).model, "relay/one");
    assert.equal(JSON.parse(up.seen[0].body).messages[0].content, "still here");
  });
});

test("a JSON body with no model is forwarded with the pinned model", async () => {
  await withRelay(async (relay, up) => {
    const missing = await ask(`${relay.url}/v1/messages`, { token: relay.token, body: { messages: [{ role: "user", content: "hi" }] } });
    assert.equal(missing.status, 200);
    const first = JSON.parse(up.seen[0].body);
    assert.equal(first.model, "relay/one");
    assert.equal(first.messages[0].content, "hi");
    // An empty object is still a body with no model.
    const empty = await ask(`${relay.url}/v1/messages`, { token: relay.token, body: {} });
    assert.equal(empty.status, 200);
    assert.deepEqual(JSON.parse(up.seen[1].body), { model: "relay/one" });
  });
});

test("a models list is dropped and the pinned model is set", async () => {
  await withRelay(async (relay, up) => {
    // `models` on its own is how a caller would pick a model once `model` is pinned.
    const onlyList = await ask(`${relay.url}/v1/messages`, {
      token: relay.token,
      body: { models: ["attacker/one", "attacker/two"], messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(onlyList.status, 200);
    const first = JSON.parse(up.seen[0].body);
    assert.equal(first.model, "relay/one");
    assert.equal("models" in first, false);
    assert.equal(first.messages[0].content, "hi");
    // A string is the same field. The caller's model does not survive either.
    const both = await ask(`${relay.url}/v1/messages`, {
      token: relay.token,
      body: { model: "attacker/choice", models: "attacker/other", max_tokens: 16 },
    });
    assert.equal(both.status, 200);
    const second = JSON.parse(up.seen[1].body);
    assert.equal(second.model, "relay/one");
    assert.equal("models" in second, false);
    assert.equal(second.max_tokens, 16);
  });
});

test("an encoded climb that still names an allowed path is forwarded as that path", async () => {
  await withRelay(async (relay, up) => {
    const answer = await ask(relay.url, { token: relay.token, rawPath: "/%2e%2e/v1/messages?beta=true", body: { model: "attacker/choice" } });
    assert.equal(answer.status, 200);
    assert.equal(up.seen.length, 1);
    assert.equal(up.seen[0].url, "/v1/messages?beta=true");
    assert.equal(JSON.parse(up.seen[0].body).model, "relay/one");
  });
});

test("POST /v1/messages/count_tokens is forwarded with the pinned model and no models list", async () => {
  await withRelay(async (relay, up) => {
    const answer = await ask(`${relay.url}/v1/messages/count_tokens?beta=true`, {
      token: relay.token,
      body: { models: ["attacker/one"], messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(answer.status, 200);
    assert.equal(up.seen.length, 1);
    assert.equal(up.seen[0].method, "POST");
    assert.equal(up.seen[0].url, "/v1/messages/count_tokens?beta=true");
    const got = JSON.parse(up.seen[0].body);
    assert.equal(got.model, "relay/one");
    assert.equal("models" in got, false);
    assert.equal(got.messages[0].content, "hi");
  });
});

test("the two paths stay under the upstream prefix when a request climbs with ..", async () => {
  await withRelay(
    async (relay, up) => {
      const plain = await ask(`${relay.url}/v1/messages?beta=true`, { token: relay.token, body: { model: "x", messages: [] } });
      assert.equal(plain.status, 200);
      assert.equal(up.seen[0].url, "/api/v1/messages?beta=true");
      assert.equal(JSON.parse(up.seen[0].body).model, "relay/one");
      // `/../../v1/messages` is still the messages call, but it must not climb out of `/api`.
      const climbed = await ask(relay.url, { token: relay.token, rawPath: "/../../v1/messages", body: { model: "x" } });
      assert.equal(climbed.status, 200);
      assert.equal(up.seen.length, 2);
      assert.equal(up.seen[1].url, "/api/v1/messages");
      assert.equal(up.seen[1].host, up.url.replace("http://", ""));
      const count = await ask(relay.url, { token: relay.token, rawPath: "/../../v1/messages/count_tokens", body: { model: "x" } });
      assert.equal(count.status, 200);
      assert.equal(up.seen[2].url, "/api/v1/messages/count_tokens");
    },
    { upstreamPath: "/api" },
  );
});

test("a streamed answer reaches the caller chunk by chunk, not in one buffered piece", async () => {
  const up = await upstream((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    res.write("data: one\n\n");
    setTimeout(() => {
      res.write("data: two\n\n");
      res.end();
    }, 50);
  });
  const relay = await startOpenRouterRelay({ readKey: () => FAKE_KEY, upstream: up.url, model: "relay/one" });
  try {
    const answer = await ask(`${relay.url}/v1/messages`, { token: relay.token, body: { model: "claude-sonnet-5" } });
    assert.equal(answer.status, 200);
    // The content type is the upstream's.
    assert.equal(answer.headers["content-type"], "text/event-stream");
    // Two writes, 50 ms apart, are two reads: nothing held the first one back waiting for the second.
    assert.ok(answer.chunks.length >= 2, `expected 2+ reads, got ${answer.chunks.length}`);
    assert.match(answer.chunks[0], /data: one/);
    assert.doesNotMatch(answer.chunks[0], /data: two/);
    assert.equal(answer.chunks.join(""), "data: one\n\ndata: two\n\n");
  } finally {
    await relay.close();
    await up.close();
  }
});

test("the key never reaches anything the relay itself writes, even against an upstream that echoes the call back", async () => {
  // A hostile/broken upstream: the first call answers with everything it received (the key included), the second hangs
  // up without answering at all.
  let calls = 0;
  const up = await upstream((req, res, body) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(200, { "content-type": "application/json", "x-echo-authorization": String(req.headers.authorization ?? "") });
      res.end(JSON.stringify({ received: { headers: req.headers, body: body.toString("utf8") } }));
      return;
    }
    res.destroy();
  });
  const relay = await startOpenRouterRelay({ readKey: () => FAKE_KEY, upstream: up.url, model: "relay/one" });
  try {
    const { written } = await withCapturedOutput(async () => {
      const refused = await ask(`${relay.url}/v1/messages`, { token: "wrong", body: { model: "x" } });
      assert.equal(refused.status, 401);
      assert.equal(refused.text.includes(FAKE_KEY), false, "a refusal echoed the key");
      for (const value of Object.values(refused.headers)) assert.equal(String(value).includes(FAKE_KEY), false, "a refusal's header carried the key");

      const echoed = await ask(`${relay.url}/v1/messages`, { token: relay.token, body: { model: "claude-sonnet-5" } });
      assert.equal(echoed.status, 200);
      // The upstream echoed the key back in a header: the relay scrubs what it hands its caller, so it comes back as
      // "[key]". The BODY is the one thing it passes through untouched (an SSE answer must not be buffered), so an
      // upstream that echoes the key into a body is the upstream's own doing; nothing the relay writes carries it.
      assert.equal(echoed.headers["x-echo-authorization"], "Bearer [key]");
      assert.equal(echoed.text.includes(FAKE_KEY), true, "the pass-through body is the upstream's bytes, unrewritten");

      const broken = await ask(`${relay.url}/v1/messages`, { token: relay.token, body: { model: "claude-sonnet-5" } });
      assert.equal(broken.status, 502);
      assert.match(broken.text, /^the relay could not reach OpenRouter/);
      assert.equal(broken.text.includes(FAKE_KEY), false, "the 502 echoed the key");
      for (const value of Object.values(broken.headers)) assert.equal(String(value).includes(FAKE_KEY), false, "the 502's header carried the key");
      return true;
    });
    assert.equal(written.some((line) => line.includes(FAKE_KEY)), false, "the key reached a log line");
  } finally {
    await relay.close();
    await up.close();
  }

  // A reader whose own error message carries the key: the plain refusal is what comes out, and never that message.
  const leaked = [];
  const real = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    leaked.push(String(chunk));
    return real.call(process.stderr, chunk, ...rest);
  };
  try {
    await assert.rejects(
      () =>
        startOpenRouterRelay({
          readKey: () => {
            throw new Error(`security: the Keychain answered ${FAKE_KEY}`);
          },
        }),
      { message: RELAY_NO_KEY },
    );
  } finally {
    process.stderr.write = real;
  }
  assert.equal(leaked.some((line) => line.includes(FAKE_KEY)), false);
});

test("an unreachable upstream is a 502 in plain words, and the relay keeps serving", async () => {
  // A port nothing listens on: opened, then closed.
  const dead = await upstream(() => undefined);
  const deadUrl = dead.url;
  await dead.close();
  const relay = await startOpenRouterRelay({ readKey: () => FAKE_KEY, upstream: deadUrl, model: "relay/one" });
  try {
    const first = await ask(`${relay.url}/v1/messages`, { token: relay.token, body: { model: "x" } });
    assert.equal(first.status, 502);
    assert.match(first.text, /^the relay could not reach OpenRouter \(the network may be down\); nothing was sent\n$/);
    assert.equal(first.text.includes(FAKE_KEY), false);
    // Still up, and still answering on its own terms: a wrong token is a 401, not a crash.
    const after = await ask(`${relay.url}/v1/messages`, { token: "wrong", body: { model: "x" } });
    assert.equal(after.status, 401);
    assert.equal(relay.server.listening, true);
  } finally {
    await relay.close();
  }
});

test("no key is a plain refusal, and no port is opened to hear it on", async () => {
  const realListen = http.Server.prototype.listen;
  let listens = 0;
  http.Server.prototype.listen = function countingListen(...args) {
    listens += 1;
    return realListen.apply(this, args);
  };
  try {
    await assert.rejects(() => startOpenRouterRelay({ readKey: () => "" }), { message: RELAY_NO_KEY });
    assert.equal(listens, 0);
    await assert.rejects(() => startOpenRouterRelay({ readKey: () => "   " }), { message: RELAY_NO_KEY });
    assert.equal(listens, 0);
    // A reader that throws is an empty key too: nothing it said is surfaced.
    await assert.rejects(
      () =>
        startOpenRouterRelay({
          readKey: () => {
            throw new Error("security: item not found");
          },
        }),
      { message: RELAY_NO_KEY },
    );
    assert.equal(listens, 0);
    // The same call with a key does listen, so the counter above is really counting (the fake upstream listens too, so
    // the count is taken either side of the relay's own call).
    const up = await upstream((req, res) => res.end("{}"));
    const before = listens;
    const relay = await startOpenRouterRelay({ readKey: () => FAKE_KEY, upstream: up.url });
    assert.equal(listens, before + 1);
    await relay.close();
    await up.close();
  } finally {
    http.Server.prototype.listen = realListen;
  }
});

test("the relay listens on 127.0.0.1 alone, on a port the OS picked, and frees it when it closes", async () => {
  const up = await upstream((req, res) => res.end("{}"));
  const relay = await startOpenRouterRelay({ readKey: () => FAKE_KEY, upstream: up.url });
  try {
    assert.equal(relay.host, "127.0.0.1");
    assert.equal(relay.server.address().address, "127.0.0.1");
    assert.ok(Number.isInteger(relay.port) && relay.port > 0);
    assert.equal(relay.url, `http://127.0.0.1:${relay.port}`);
  } finally {
    await relay.close();
    await up.close();
  }
  const refused = await connect(relay.port);
  assert.equal(refused.code, "ECONNREFUSED");
});

test("an OpenRouter run's profile opens the relay port only, grants the launcher file only, and guards that launcher", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "or-relay-profile-"));
  const launcher = `${REAL}/.local/bin/claude-openrouter`;
  const devConfig = `${REAL}/.monocode-hub-dev/claude-config`;
  const relayPort = 45999;
  const env = {
    REALTEST_REAL_HOME: REAL,
    HOME: home,
    REALTEST_STATE: home,
    REALTEST_ALLOWED: "[]",
    // What the run's wrapper exports for an OpenRouter run (bench-or-relay.mjs's port, in the form this list reads).
    REALTEST_GATEWAY: `127.0.0.1:${relayPort}`,
    REALTEST_SANDBOX_EXEC: "/usr/bin/sandbox-exec",
  };
  const launch = agentCommand(launcher, ["-p"], env, { spawnSync: () => ({ status: 0, stdout: "", stderr: "" }), existsSync: () => true, uid: 501 });
  assert.equal(launch.ok, true);
  const ports = [...launch.profile.matchAll(/remote ip "localhost:(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(ports, [relayPort], "the profile must name the relay port and nothing else");
  // The ports the other bridges leave open for the local gateway are shut for this run.
  assert.equal(launch.profile.includes(":8317"), false);
  assert.equal(launch.profile.includes(":8318"), false);
  assert.deepEqual(namedLoopbackPorts(env, { observe: false }).map((item) => item.port), [relayPort]);

  // The launcher file, and nothing of the gateway's beside it.
  const readOnly = cliReadOnlyPaths({ realHome: REAL, cli: launcher, devConfig });
  assert.deepEqual([...new Set(readOnly.filter((item) => item.path.includes("claude-openrouter")).map((item) => item.path))], [launcher]);
  assert.equal(readOnly.some((item) => item.path.includes("claude-gpt")), false);
  assert.ok(launch.profile.includes(launcher));
  assert.equal(launch.profile.includes("claude-gpt"), false);
  assert.equal(launch.profile.includes("proxy-key"), false);
  assert.equal(launch.profile.includes("launcher.py"), false);
  // The DeepSeek launcher still gets its gateway files: this change took nothing from the other bridges.
  const deep = cliReadOnlyPaths({ realHome: REAL, cli: `${REAL}/.local/bin/claude-deepseek`, devConfig });
  assert.ok(deep.some((item) => item.path.endsWith("/proxy-key")));
  assert.ok(deep.some((item) => item.path.endsWith("/launcher.py")));

  // An unsandboxed start of the OpenRouter launcher is refused, exactly like claude-deepseek.
  const row = (pid, ppid, command) => `  ${pid} ${ppid} ${command}`;
  const watch = (sandboxed) => ({
    rootPid: 100,
    wrapper: "/private/var/bench/bin/claude",
    sandboxOf: (pids) => ({ ok: true, byPid: new Map(pids.map((pid) => [pid, sandboxed])) }),
  });
  assert.equal(unsandboxedAgents(row(300, 100, `${launcher} -p`), watch(false)).reason, "unsandboxed agent: claude-openrouter");
  assert.equal(unsandboxedAgents(row(300, 100, `${launcher} -p`), watch(true)), null);
  assert.equal(unsandboxedAgents(row(300, 100, `${REAL}/.local/bin/claude-deepseek -p`), watch(false)).reason, "unsandboxed agent: claude-deepseek");

  fs.rmSync(home, { recursive: true, force: true });
});

test("the wrapper script hands the launcher the relay's url and token, and the credential strip keeps them", () => {
  const script = claudeWrapperScript({
    state: "/tmp/state",
    realClaude: `${REAL}/.local/bin/claude-openrouter`,
    config: "/tmp/cfg",
    model: "sonnet",
    effort: "medium",
    memoryDir: "/tmp/mem",
    openrouter: true,
    relay: { url: "http://127.0.0.1:45999", token: "deadbeef", gateway: "127.0.0.1:45999" },
    node: "/usr/bin/node",
    script: "/tmp/wrap.mjs",
  });
  assert.match(script, /export CLAUDE_OPENROUTER_RELAY_URL='http:\/\/127\.0\.0\.1:45999'/);
  assert.match(script, /export CLAUDE_OPENROUTER_RELAY_TOKEN='deadbeef'/);
  assert.match(script, /export REALTEST_GATEWAY='127\.0\.0\.1:45999'/);
  // No relay, no lines: a DeepSeek or Grok run is untouched.
  const plain = claudeWrapperScript({ state: "/tmp/state", realClaude: "/x/claude-deepseek", config: "/tmp/cfg", model: "claude-fable-5", effort: "medium", memoryDir: "/tmp/mem", node: "/usr/bin/node", script: "/tmp/wrap.mjs" });
  assert.equal(plain.includes(RELAY_URL_ENV), false);
  assert.equal(plain.includes(RELAY_TOKEN_ENV), false);
  assert.equal(plain.includes("REALTEST_GATEWAY"), false);

  // The two relay names survive the credential strip; every credential still goes.
  const env = {
    PATH: "/usr/bin",
    [RELAY_URL_ENV]: "http://127.0.0.1:45999",
    [RELAY_TOKEN_ENV]: "deadbeef",
    ANTHROPIC_API_KEY: "sk-not-real",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-not-real",
    CLAUDE_CODE_SUBAGENT_MODEL: "sonnet",
  };
  const kept = childEnv(env, { openrouter: true, grok: false });
  assert.equal(kept[RELAY_URL_ENV], "http://127.0.0.1:45999");
  assert.equal(kept[RELAY_TOKEN_ENV], "deadbeef");
  assert.equal(kept.ANTHROPIC_API_KEY, undefined);
  assert.equal(kept.ANTHROPIC_BASE_URL, undefined);
  assert.equal(kept.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(kept.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
});

test("the bench closes the relay when it throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "or-relay-runner-"));
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "or-relay-runner-evidence-"));
  const launcher = path.join(dir, "claude-openrouter");
  fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const closed = [];
  const fake = { host: "127.0.0.1", port: 45999, url: "http://127.0.0.1:45999", token: "tok", server: null, close: async () => closed.push("closed") };
  const spec = {
    version: 1,
    project: { id: "tally", name: "Tally" },
    // A copy of a repo that isn't one: the bench reaches this a few steps after the relay has started, and throws.
    copies: [{ id: "gone", name: "Gone", source: path.join(dir, "not-a-repo") }],
    scenarios: [],
    budget: {},
  };
  await assert.rejects(
    () =>
      runBench(
        { openrouterSub: true, slot: "or-relay-test", only: [], grade: false, keep: false, maxTurns: 1, maxMinutes: 1, maxRequests: 1, claudeConfigs: [] },
        { spec, evidenceDir: evidence, label: "relay-runner-test", startRelay: async () => fake, bridges: { openrouter: () => launcher } },
      ),
    /not a git repo/,
  );
  assert.deepEqual(closed, ["closed"]);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(evidence, { recursive: true, force: true });
});
