import { describe, expect, it } from "vitest";
import { resolveDataDir } from "../../../../plugins/hivra-mirror/src/config.ts";
import { applyMapped, attachSession, emptyBook, removeSession } from "../../../../plugins/hivra-mirror/src/book.ts";
import { onHook } from "../../../../plugins/hivra-mirror/src/hook.ts";
import { commitPlan, defaultSetting, planChange, touchesPersonClaude } from "../../../../plugins/hivra-mirror/src/install.ts";
import { mapEvent } from "../../../../plugins/hivra-mirror/src/mapper.ts";
import { dailyDataDir, devConfigDir, personClaudeDir } from "../../../../plugins/hivra-mirror/src/paths.ts";
import { discover, hivraStarted, shouldMirror } from "../../../../plugins/hivra-mirror/src/protocol.ts";
import { loadTranscript, transcriptEvents } from "../../../../plugins/hivra-mirror/src/transcript.ts";

const home = "/Users/Ash Neil";
const pluginDir = "/Work/hivra/plugins/hivra-mirror";

function ctx(kind: "daily" | "dev" = "daily", platform: NodeJS.Platform = "darwin") {
  return {
    home,
    kind,
    platform,
    pluginDir,
    inherited: { PATH: "/usr/bin", HOME: home, ANTHROPIC_API_KEY: "sk-ant-secret" } as Record<string, string>,
  };
}

describe("turning terminal sessions on", () => {
  it("is off by default, and turning it on plans the install command once", () => {
    const state = defaultSetting();
    expect(state).toEqual({ enabled: false, installed: false, version: 0 });
    const first = planChange(state, true, 0, ctx());
    expect(first.stale).toBe(false);
    expect(first.command).toEqual({
      program: "claude",
      args: ["plugin", "install", pluginDir],
      env: { PATH: "/usr/bin", HOME: home },
    });
    expect(first.preview.join("\n")).toContain("hivra-mirror");
    expect(first.preview.join("\n")).toContain("No login and no token");
    expect(first.command?.env.ANTHROPIC_API_KEY).toBeUndefined();
    const on = commitPlan(state, first, true);
    const second = planChange(on, true, on.version, ctx());
    expect(second.command).toBeNull();
    expect(second.next).toEqual(on);
  });

  it("does not install when the expected version is stale, and a failed install can be tried again", () => {
    const on = { enabled: true, installed: true, version: 2 };
    const stale = planChange(on, false, 1, ctx());
    expect(stale.stale).toBe(true);
    expect(stale.command).toBeNull();
    expect(stale.next).toEqual(on);
    const first = planChange(defaultSetting(), true, 0, ctx());
    expect(commitPlan(defaultSetting(), first, false)).toEqual(defaultSetting());
    const again = planChange(defaultSetting(), true, 0, ctx());
    expect(again.command?.args[0]).toBe("plugin");
    expect(again.retry).toBe(false);
    expect(again.command).not.toBeNull();
  });

  it("uninstalls once, and a dev copy never points at the person's Claude config", () => {
    const on = commitPlan(defaultSetting(), planChange(defaultSetting(), true, 0, ctx()), true);
    const off = planChange(on, false, on.version, ctx());
    expect(off.command?.args).toEqual(["plugin", "uninstall", "hivra-mirror"]);
    const again = planChange(commitPlan(on, off, true), false, on.version + 1, ctx());
    expect(again.command).toBeNull();
    const dev = planChange(defaultSetting(), true, 0, ctx("dev", "win32"));
    const config = dev.command?.env.CLAUDE_CONFIG_DIR ?? "";
    expect(config).toBe(devConfigDir(home, "win32"));
    expect(touchesPersonClaude(home, dev.command?.env ?? {}, "win32")).toBe(false);
    expect(config.includes("settings.json")).toBe(false);
    expect(personClaudeDir(home, "win32").endsWith(".claude")).toBe(true);
    expect(config.toLowerCase().includes(`${"\\"} .claude${"\\"}`.replace(/ /g, "")) || config.includes("/.claude/")).toBe(false);
  });
});

describe("finding Hivra", () => {
  it("does not mirror a session Hivra started, including when only the parent pid gives it away", () => {
    expect(shouldMirror({ MONOCODE_HARNESS_PARENT: "4242" })).toBe(false);
    expect(shouldMirror({ MONOCODE_HARNESS_PARENT: "   " })).toBe(true);
    expect(shouldMirror({})).toBe(true);
    expect(hivraStarted({ MONOCODE_HARNESS_PARENT: "4242" }, [], null)).toBe(true);
    expect(hivraStarted({}, [7, 8], 8)).toBe(true);
    expect(hivraStarted({}, [7], 8)).toBe(false);
  });

  it("treats a missing copy, a dead pid, a bad port and a remote host as something to retry", () => {
    expect(discover({ running: null, alive: false })).toMatchObject({ mirror: false, retry: true });
    expect(discover({ running: { pid: 4 }, alive: false })).toMatchObject({ reason: "not running" });
    expect(discover({ running: { pid: 4, mirrorHost: "127.0.0.1" }, alive: true })).toMatchObject({ reason: "no port" });
    expect(discover({ running: { pid: 4, mirrorPort: 9, mirrorHost: "203.0.113.5" }, alive: true })).toMatchObject({
      reason: "not this Mac",
    });
    expect(discover({ running: "nope", alive: true })).toMatchObject({ retry: true });
    expect(discover({ running: { pid: 4, mirrorPort: 4311, mirrorHost: "localhost" }, alive: true })).toEqual({
      mirror: true,
      host: "127.0.0.1",
      port: 4311,
    });
  });

  it("keeps a dev copy off the daily data folder, and builds each platform's folder without a hard-coded slash", () => {
    const daily = dailyDataDir(home, "darwin");
    expect(daily).toBe("/Users/Ash Neil/Library/Application Support/com.ash.monocode-hub");
    expect(dailyDataDir("C:\\Users\\Ash Neil", "win32")).toBe(
      "C:\\Users\\Ash Neil\\AppData\\Roaming\\com.ash.monocode-hub",
    );
    expect(dailyDataDir("/home/ásh", "linux")).toBe("/home/ásh/.local/share/com.ash.monocode-hub");
    const dev = resolveDataDir({
      home,
      platform: "darwin",
      kind: "dev",
      configDir: devConfigDir(home, "darwin"),
      target: null,
    });
    expect(dev).toMatchObject({ ok: false, retry: true });
    const escaped = resolveDataDir({
      home,
      platform: "darwin",
      kind: "dev",
      configDir: devConfigDir(home, "darwin"),
      target: { dataDir: "/tmp/../daily" },
    });
    expect(escaped.ok).toBe(false);
    const dailyDespiteTarget = resolveDataDir({
      home,
      platform: "darwin",
      kind: "daily",
      target: { dataDir: "/tmp/dev-data" },
    });
    expect(dailyDespiteTarget).toEqual({ ok: true, dir: daily });
    expect(devConfigDir(home, "darwin")).not.toContain("/.claude");
  });
});

describe("mirrored events become chat blocks", () => {
  it("maps text, tool calls, diffs and permission prompts, and ignores empty or unknown ones", () => {
    const user = mapEvent({ kind: "user", sessionId: "s", id: "u1", text: "hello" });
    expect(user).toMatchObject({ kind: "blocks", blocks: [{ id: "u1", role: "user", text: "hello" }] });
    expect(mapEvent({ kind: "user", sessionId: "s", id: "empty", text: "  " })).toEqual({ kind: "ignore" });
    expect(mapEvent({ kind: "nope", sessionId: "s" })).toEqual({ kind: "ignore" });
    expect(mapEvent(null)).toEqual({ kind: "ignore" });
    const assistant = mapEvent({
      type: "assistant",
      session_id: "s",
      uuid: "a1",
      message: {
        content: [
          { type: "text", text: "On it." },
          { type: "tool_use", id: "t1", name: "Edit", input: { diff: "--- a\n+++ b\n@@\n-old\n+new\n" } },
        ],
      },
    });
    expect(assistant).toMatchObject({
      kind: "blocks",
      blocks: [
        { id: "a1", role: "assistant", text: "On it." },
        {
          id: "t1",
          role: "tool",
          text: "Edit",
          tool: { preview: { kind: "write", lines: [{ kind: "del", text: "old" }, { kind: "add", text: "new" }] } },
        },
      ],
    });
    const permission = mapEvent({
      hook_event_name: "PermissionRequest",
      session_id: "s",
      request_id: "fake-ask-1",
      tool_name: "Bash",
    });
    expect(permission).toMatchObject({
      kind: "blocks",
      state: "waiting",
      permission: { requestId: "fake-ask-1", tool: "Bash" },
      blocks: [{ role: "approval", text: "Allow Bash?", approval: { call: { tool: "Bash" } } }],
    });
  });

  it("updates a block with the same id, drops a late event after the session is gone, and attaches once", () => {
    let book = applyMapped(emptyBook(), { kind: "session", id: "s", folder: "/work/notes", title: "Notes" }, 1);
    book = applyMapped(book, { kind: "assistant", sessionId: "s", id: "b", text: "one" }, 2);
    book = applyMapped(book, { kind: "assistant", sessionId: "s", id: "b", text: "two" }, 3);
    expect(book.sessions[0]?.blocks).toEqual([{ id: "b", role: "assistant", text: "two" }]);
    book = removeSession(book, "s");
    const late = applyMapped(book, { kind: "user", sessionId: "s", id: "later", text: "too late" }, 4);
    expect(late.sessions).toEqual([]);
    expect(late.removed).toEqual(["s"]);
    let live = applyMapped(emptyBook(), { kind: "session", id: "s", folder: "/work/nöte", title: "Notes" }, 1);
    const first = attachSession(live, "s", "task-1");
    const second = attachSession(first.book, "s", "task-1");
    expect(first.activity?.text).toBe("Terminal session Notes (/work/nöte)");
    expect(second.duplicate).toBe(true);
    expect(second.book.activities).toHaveLength(1);
    live = removeSession(first.book, "s");
    expect(attachSession(live, "s", "task-1").error).toBe("That session is gone.");
    expect(attachSession(first.book, "s", "  ").error).toBe("That task isn't there.");
  });

  it("reads earlier turns from the transcript, and does not read a path that climbs out", () => {
    const text = '{"type":"user","message":{"content":[{"type":"text","text":"earlier"}]}}\r\nnot json\r\n\r\n{"type":"assistant","uuid":"a","message":{"content":[{"type":"text","text":"back"}]}}\n';
    const events = transcriptEvents(text);
    expect(events).toHaveLength(2);
    expect(mapEvent({ ...(events[0] as object), sessionId: "s" })).toMatchObject({
      blocks: [{ role: "user", text: "earlier" }],
    });
    let reads = 0;
    const climbed = loadTranscript("C:\\work\\..\\secret.jsonl", () => {
      reads += 1;
      return "nope";
    });
    expect(climbed).toEqual({ text: null, refused: true });
    expect(reads).toBe(0);
    expect(loadTranscript("/work/missing.jsonl", () => {
      throw new Error("missing");
    })).toEqual({ text: null, refused: false });
  });
});

describe("the hook stays quiet", () => {
  it("does nothing when Hivra started the session", () => {
    const send = () => {
      throw new Error("sent");
    };
    const readFile = () => {
      throw new Error("read");
    };
    const result = onHook({
      env: { MONOCODE_HARNESS_PARENT: "9" },
      ancestors: [],
      running: { pid: 9, mirrorPort: 1, mirrorHost: "127.0.0.1" },
      alive: true,
      event: { kind: "user", sessionId: "s", text: "hi", transcript: "/tmp/t.jsonl" },
      readFile,
      send,
    });
    expect(result).toEqual({ silent: true, frames: [], output: null });
  });

  it("stays silent when Hivra is not running, and the session still gets no error", () => {
    const result = onHook({
      env: {},
      ancestors: [],
      running: null,
      alive: false,
      event: { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "hi" },
      readFile: () => {
        throw new Error("read");
      },
      send: () => {
        throw new Error("sent");
      },
    });
    expect(result.silent).toBe(true);
    expect(result.output).toBeNull();
  });

  it("sends the transcript once the port answers, and a refused path is not read", () => {
    const seen: string[] = [];
    const result = onHook({
      env: {},
      ancestors: [1],
      running: { pid: 4, mirrorPort: 9, mirrorHost: "127.0.0.1" },
      alive: true,
      event: {
        hook_event_name: "UserPromptSubmit",
        session_id: "s",
        prompt: "now",
        transcript_path: "/work/space name/t.jsonl",
      },
      readFile: () => '{"type":"user","message":{"content":[{"type":"text","text":"earlier"}]}}\n',
      send: (frames) => {
        seen.push(...frames.map((frame) => JSON.stringify(frame)));
        return { ok: true, steers: [] };
      },
    });
    expect(result.silent).toBe(false);
    expect(seen.some((line) => line.includes("earlier"))).toBe(true);
    expect(seen.some((line) => line.includes("now"))).toBe(true);
    let reads = 0;
    const quiet = onHook({
      env: {},
      ancestors: [],
      running: { pid: 4, mirrorPort: 9, mirrorHost: "127.0.0.1" },
      alive: true,
      event: { kind: "user", sessionId: "s", id: "u", text: "hi", transcript: "/work/../secret" },
      readFile: () => {
        reads += 1;
        return "nope";
      },
      send: () => ({ ok: true, steers: [] }),
    });
    expect(reads).toBe(0);
    expect(quiet.silent).toBe(false);
  });

  it("treats a send that throws, or a port that does not answer, as silence rather than a failed session", () => {
    const base = {
      env: {},
      ancestors: [] as number[],
      running: { pid: 4, mirrorPort: 9, mirrorHost: "127.0.0.1" },
      alive: true,
      event: { kind: "user", sessionId: "s", id: "u", text: "hi" },
      readFile: () => "",
    };
    expect(onHook({ ...base, send: () => { throw new Error("down"); } }).silent).toBe(true);
    expect(onHook({ ...base, send: () => ({ ok: false, steers: [] }) }).silent).toBe(true);
  });
});
