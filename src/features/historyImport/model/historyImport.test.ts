import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { batchesOf, slicePause } from "./batch";
import { estimateSentence, tokensAtMost } from "./estimate";
import { parseTranscript, unitsFrom } from "./parse";
import { runImport, type RunInput } from "./pipeline";
import { formatDay, previewFrom, rangeText } from "./preview";
import { batchPrompt, sendable } from "./prompt";
import { proposalId } from "./proposals";
import { dropLinesWithoutSource } from "./provenance";
import { emptyState, entry, isSubmitted, normalizeState, parseState, withEntry } from "./state";
import { parseIsoTsMs, projectName } from "./text";
import {
  BATCH_CHAR_LIMIT,
  BATCH_MSG_LIMIT,
  type Conversation,
  type ImportStateFile,
  type ListReport,
  type TranscriptMessage,
  type Unit,
} from "./types";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

const KEY = "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ";
const NOISE = ["TOOL_NOISE_MARKER", "THINKING_NOISE", "THOUGHT_NOISE", "META_NOISE", "SIDECHAIN_NOISE", "API_ERROR_NOISE", "COMPACT_NOISE", "NO_TIME", "SYSTEM_NOISE", "TOOL_NOISE", "data:image/png;base64"];

function joined(units: Unit[]): string {
  return units
    .flatMap((unit) => (unit.kind === "chat" ? unit.conversation.messages.map((message) => message.content) : []))
    .join("\n");
}

function message(partial: Partial<TranscriptMessage> & Pick<TranscriptMessage, "content">): TranscriptMessage {
  return {
    conversationId: "sess-1",
    messageId: "m1",
    role: "user",
    timestamp: 0,
    secret: false,
    ...partial,
  };
}

function disk() {
  let revision = 0;
  let state = emptyState();
  return {
    load: async () => ({ state, revision }),
    async cas(rev: number, next: ImportStateFile) {
      if (rev !== revision) return false;
      state = next;
      revision += 1;
      return true;
    },
    sneak(platform: string, sourceKey: string) {
      state = withEntry(state, platform, sourceKey, entry("submitted", 1));
      revision += 1;
    },
    get: () => state,
  };
}

function citingAsk(seen: string[]) {
  return async (prompt: string) => {
    seen.push(prompt);
    const match = prompt.match(/\[([A-Za-z0-9._:-]+) #([A-Za-z0-9._:-]+)\]/);
    const id = match?.[1] ?? "missing";
    const msg = match?.[2] ?? "m0";
    return {
      ok: true as const,
      text: [`- Noted [src: ${id} #${msg}]`, "- No source here", "- Invented [src: nope #m9]", ""].join("\n"),
    };
  };
}

function harness(store: ReturnType<typeof disk>, units: Unit[], extra: Partial<RunInput> = {}): RunInput {
  const seen: string[] = [];
  const drafts: { id: string; markdown: string }[] = [];
  const input: RunInput = {
    units,
    state: emptyState(),
    revision: 0,
    ask: citingAsk(seen),
    loadState: store.load,
    casState: store.cas,
    writeProposal: async (id, markdown) => {
      drafts.push({ id, markdown });
    },
    cancelled: () => false,
    pause: async () => true,
    now: () => 1_700_000_000_000,
    ...extra,
  };
  return Object.assign(input, { seen, drafts });
}

describe("fixture transcripts", () => {
  it("keeps prose and drops tool noise, sidechains and torn lines", () => {
    const claude = unitsFrom("claude_code", "notes/chat.jsonl", fixture("claude.jsonl"));
    expect(claude).toHaveLength(1);
    expect(claude[0].kind).toBe("chat");
    if (claude[0].kind !== "chat") return;
    expect(claude[0].conversation.id).toBe("sess-1");
    expect(claude[0].conversation.project).toBe("notes");
    expect(claude[0].conversation.messages.map((m) => m.content)).toEqual([
      "I like small commits",
      "Small commits are easier to review.",
      "Thanks",
    ]);
    expect(claude[0].conversation.messages.map((m) => m.messageId)).toEqual(["m1", "m2", "m3"]);
    expect(claude[0].conversation.skippedLines).toBe(1);

    const codex = unitsFrom("codex", "sessions/rollout.jsonl", fixture("codex.jsonl"));
    if (codex[0].kind !== "chat") throw new Error("codex");
    expect(codex[0].conversation.id).toBe("codex-1");
    expect(codex[0].conversation.project).toBe("hub");
    expect(codex[0].conversation.messages.map((m) => m.content)).toEqual(["Always write the test first", "Tests go first."]);

    const hermes = unitsFrom("hermes", "sessions/h.jsonl", fixture("hermes.jsonl"));
    if (hermes[0].kind !== "chat") throw new Error("hermes");
    expect(hermes[0].conversation.sourceKey).toBe("sessions/h.jsonl#h1");
    expect(hermes[0].conversation.project).toBe("hermes-proj");
    expect(hermes[0].conversation.messages.map((m) => m.content).join("\n")).toContain("[media x1]");
    expect(hermes[0].conversation.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    const all = joined([...claude, ...codex, ...hermes]);
    for (const noise of NOISE) expect(all).not.toContain(noise);
  });

  it("reads CRLF and a Windows path", () => {
    const text = fixture("claude.jsonl").replace(/\n/g, "\r\n");
    const units = unitsFrom("claude_code", "C:\\work\\notes\\chat.jsonl", text);
    if (units[0].kind !== "chat") throw new Error("crlf");
    expect(units[0].conversation.messages).toHaveLength(3);
    expect(projectName("C:\\work\\notes", "C:\\work\\notes\\chat.jsonl")).toBe("notes");
    expect(projectName(null, "C:\\work\\notes\\chat.jsonl")).toBe("notes");
  });

  it("treats an empty file as done and garbage as unreadable", () => {
    expect(unitsFrom("claude_code", "empty.jsonl", "  \n")).toEqual([{ kind: "empty", source: "claude_code", sourceKey: "empty.jsonl" }]);
    expect(unitsFrom("claude_code", "bad.jsonl", "hello\n")[0].kind).toBe("unreadable");
  });
});

describe("timestamps", () => {
  it("keeps milliseconds, scales seconds, and treats a naive time as UTC", () => {
    expect(parseIsoTsMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseIsoTsMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseIsoTsMs("2026-01-03T10:00:00")).toBe(parseIsoTsMs("2026-01-03T10:00:00Z"));
    expect(parseIsoTsMs("")).toBeNull();
    expect(parseIsoTsMs("not-a-time")).toBeNull();
    expect(formatDay(Date.parse("2026-01-03T10:00:00Z"))).toBe("3 Jan 2026");
    expect(rangeText(Date.parse("2026-01-03T00:00:00Z"), Date.parse("2026-02-01T00:00:00Z"))).toBe("3 Jan 2026 to 1 Feb 2026");
  });
});

describe("batches", () => {
  it("checks the limit before appending, so one huge message is its own batch", () => {
    const short = Array.from({ length: BATCH_MSG_LIMIT + 1 }, (_, i) => message({ messageId: `m${i + 1}`, content: "x" }));
    const split = batchesOf(short);
    expect(split.map((batch) => batch.length)).toEqual([BATCH_MSG_LIMIT, 1]);
    const huge = message({ content: "y".repeat(BATCH_CHAR_LIMIT + 1) });
    const next = message({ messageId: "m2", content: "z" });
    expect(batchesOf([huge, next]).map((batch) => batch.length)).toEqual([1, 1]);
  });

  it("stops inside a retry wait", async () => {
    let stop = false;
    const slices: number[] = [];
    const stayed = await slicePause(2500, () => stop, async (ms) => {
      slices.push(ms);
      stop = true;
    });
    expect(stayed).toBe(false);
    expect(slices).toEqual([1000]);
  });
});

describe("preview", () => {
  it("counts chats, dates and projects without keeping the header", () => {
    const header = fixture("claude.jsonl").slice(0, 8192);
    const older: ListReport = {
      missing: false,
      active: 1,
      links: 2,
      database: false,
      truncated: false,
      files: [
        { path: "old/chat.jsonl", bytes: 10, mtimeMs: 10, header, tooBig: false },
        { path: "new/chat.jsonl", bytes: 20, mtimeMs: 50, header: header.replaceAll("/work/notes", "/work/newer"), tooBig: false },
        { path: "huge/chat.jsonl", bytes: 99, mtimeMs: 1, header: "SECRET_BODY I like small commits", tooBig: true },
      ],
    };
    const preview = previewFrom("claude_code", [older]);
    const encoded = JSON.stringify(preview);
    expect(encoded).not.toContain("I like small commits");
    expect(encoded).not.toContain("SECRET_BODY");
    expect(encoded).not.toContain("header");
    expect(preview.conversations).toBe(1);
    expect(preview.duplicates).toBe(1);
    expect(preview.projects.map((project) => project.name)).toEqual(["newer"]);
    expect(preview.active).toBe(1);
    expect(preview.links).toBe(2);
    expect(preview.tooBig).toBe(1);
    expect(preview.missing).toBe(false);
  });

  it("says missing, which is not the same as no chats", () => {
    const missing = previewFrom("hermes", [{ missing: true, files: [], active: 0, links: 0, database: true, truncated: false }]);
    expect(missing.missing).toBe(true);
    expect(missing.conversations).toBe(0);
    expect(missing.database).toBe(true);
    const none = previewFrom("codex", [{ missing: false, files: [], active: 0, links: 0, database: false, truncated: false }]);
    expect(none.missing).toBe(false);
    expect(none.conversations).toBe(0);
  });
});

describe("the run", () => {
  it("resumes after a cancel and does not send a finished chat again", async () => {
    const store = disk();
    const units = [
      ...unitsFrom("claude_code", "notes/chat.jsonl", fixture("claude.jsonl")),
      ...unitsFrom("codex", "sessions/rollout.jsonl", fixture("codex.jsonl")),
    ];
    let asks = 0;
    let stop = false;
    const first = harness(store, units, {
      state: (await store.load()).state,
      revision: (await store.load()).revision,
      ask: async (prompt) => {
        asks += 1;
        return citingAsk([])(prompt);
      },
      // After the first chat is saved, not during its model call. A cancel
      // that lands while that call is in flight is a different case.
      cancelled: () => stop,
      onProgress: (event) => {
        if (event.status === "submitted") stop = true;
      },
    });
    const stopped = await runImport(first);
    expect(stopped.cancelled).toBe(true);
    expect(stopped.submitted).toBe(1);
    expect(isSubmitted(store.get(), "claude_code", "notes/chat.jsonl")).toBe(true);
    expect(isSubmitted(store.get(), "codex", "sessions/rollout.jsonl")).toBe(false);
    expect(asks).toBe(1);

    const seen: string[] = [];
    const second = harness(store, units, {
      state: (await store.load()).state,
      revision: (await store.load()).revision,
      ask: citingAsk(seen),
      cancelled: () => false,
    });
    const done = await runImport(second);
    expect(done.cancelled).toBe(false);
    expect(done.skipped).toBe(1);
    expect(done.submitted).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("Always write the test first");
    expect(seen[0]).not.toContain("I like small commits");
    expect(isSubmitted(store.get(), "codex", "sessions/rollout.jsonl")).toBe(true);
  });

  it("sends a cancelled chat from the start the next time", async () => {
    const messages = Array.from({ length: 11 }, (_, i) =>
      message({ messageId: `m${i + 1}`, content: `line ${i + 1}` }),
    );
    const conversation: Conversation = {
      id: "sess-1",
      sourceKey: "long.jsonl",
      source: "claude_code",
      project: "notes",
      title: "",
      messages,
      skippedLines: 0,
      secrets: 0,
    };
    const store = disk();
    let calls = 0;
    let arm = true;
    const seen: string[] = [];
    const once = harness(store, [{ kind: "chat", conversation }], {
      ask: async (prompt) => {
        calls += 1;
        seen.push(prompt);
        return citingAsk([])(prompt);
      },
      cancelled: () => arm && calls >= 1,
    });
    const stopped = await runImport(once);
    expect(stopped.submitted).toBe(0);
    expect(isSubmitted(store.get(), "claude_code", "long.jsonl")).toBe(false);
    expect(calls).toBe(1);

    arm = false;
    const again = harness(store, [{ kind: "chat", conversation }], {
      state: (await store.load()).state,
      revision: (await store.load()).revision,
      ask: async (prompt) => {
        calls += 1;
        seen.push(prompt);
        return citingAsk([])(prompt);
      },
      cancelled: () => false,
    });
    const done = await runImport(again);
    expect(done.submitted).toBe(1);
    expect(calls).toBe(3);
    expect(seen[1]).toContain("line 1");
    expect(seen.at(-1)).toContain("line 11");
  });

  it("drops a secret before the model sees it, and drops a line with no real source", async () => {
    const store = disk();
    const units = unitsFrom("claude_code", "secret.jsonl", fixture("secret-claude.jsonl"));
    if (units[0].kind !== "chat") throw new Error("secret");
    expect(units[0].conversation.messages.map((m) => m.messageId)).toEqual(["m1", "m2"]);
    expect(units[0].conversation.messages[0].secret).toBe(true);
    const prompts: string[] = [];
    const input = harness(store, units, {
      ask: async (prompt) => {
        prompts.push(prompt);
        return {
          ok: true as const,
          text: [
            `- The key is ${KEY} [src: sess-secret #m2]`,
            "- Decides on Tuesday [src: sess-secret #m2]",
            "- Cited the secret message [src: sess-secret #m1]",
            "- No source here",
            "- Invented [src: other #m9]",
            "# How you work",
          ].join("\n"),
        };
      },
    });
    const summary = await runImport(input);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(KEY);
    expect(prompts[0]).not.toContain("[sess-secret #m1]");
    expect(prompts[0]).toContain("I decide on Tuesday");
    expect(summary.secrets).toBe(1);
    expect(summary.proposals).toHaveLength(1);
    const draft = summary.proposals[0].markdown;
    expect(draft).toBe("- Decides on Tuesday [src: sess-secret #m2]");
    expect(draft).not.toContain(KEY);
    expect(draft).not.toContain("No source");
    expect(draft).not.toContain("Invented");
    expect(draft).not.toContain("How you work");
    expect(draft).not.toContain("#m1]");
    expect(summary.proposals[0].meta).toMatchObject({ applied: false, status: "unreviewed", kind: "history-import" });
  });

  it("does not wait out a refusal, and a timeout is not a final failure", async () => {
    const conversation: Conversation = {
      id: "sess-1",
      sourceKey: "one.jsonl",
      source: "claude_code",
      project: "notes",
      title: "",
      messages: [message({ content: "hello" })],
      skippedLines: 0,
      secrets: 0,
    };
    const waits: number[] = [];
    const refused = disk();
    const refusal = await runImport(
      harness(refused, [{ kind: "chat", conversation }], {
        ask: async () => ({ ok: false as const, kind: "refused" as const, reason: "The model turned this down." }),
        pause: async (ms) => {
          waits.push(ms);
          return true;
        },
      }),
    );
    expect(waits).toEqual([]);
    expect(refusal.failed).toBe(1);
    expect(refusal.deferred).toBe(0);
    expect(isSubmitted(refused.get(), "claude_code", "one.jsonl")).toBe(false);

    const slow = disk();
    const backoffs: number[] = [];
    let tries = 0;
    const deferred = await runImport(
      harness(slow, [{ kind: "chat", conversation }], {
        ask: async () => {
          tries += 1;
          return { ok: false as const, kind: "retryable" as const, reason: "no answer" };
        },
        pause: async (ms) => {
          backoffs.push(ms);
          return true;
        },
      }),
    );
    expect(tries).toBe(4);
    expect(backoffs).toEqual([30_000, 60_000, 120_000]);
    expect(deferred.deferred).toBe(1);
    expect(deferred.failed).toBe(0);
    expect(isSubmitted(slow.get(), "claude_code", "one.jsonl")).toBe(false);
  });

  it("cancels during the retry wait and leaves the chat unsubmitted", async () => {
    const store = disk();
    const conversation: Conversation = {
      id: "sess-1",
      sourceKey: "one.jsonl",
      source: "claude_code",
      project: "notes",
      title: "",
      messages: [message({ content: "hello" })],
      skippedLines: 0,
      secrets: 0,
    };
    const summary = await runImport(
      harness(store, [{ kind: "chat", conversation }], {
        ask: async () => ({ ok: false as const, kind: "retryable" as const, reason: "no answer" }),
        pause: async () => false,
      }),
    );
    expect(summary.cancelled).toBe(true);
    expect(summary.submitted).toBe(0);
    expect(store.get().entries).toEqual({});
  });

  it("keeps the other window's key when this write loses the race", async () => {
    const store = disk();
    let sneaked = false;
    const conversation: Conversation = {
      id: "sess-1",
      sourceKey: "mine.jsonl",
      source: "claude_code",
      project: "notes",
      title: "",
      messages: [message({ content: "hello" })],
      skippedLines: 0,
      secrets: 0,
    };
    await runImport(
      harness(store, [{ kind: "chat", conversation }], {
        casState: async (rev, next) => {
          if (!sneaked) {
            sneaked = true;
            store.sneak("claude_code", "theirs.jsonl");
            return false;
          }
          return store.cas(rev, next);
        },
      }),
    );
    expect(isSubmitted(store.get(), "claude_code", "theirs.jsonl")).toBe(true);
    expect(isSubmitted(store.get(), "claude_code", "mine.jsonl")).toBe(true);
  });
});

describe("state and estimate", () => {
  it("migrates a flat file and rejects corrupt JSON", () => {
    const flat = parseState(JSON.stringify({ "claude_code:a": { status: "submitted", timestamp: 5, error: null } }));
    expect(flat.corrupt).toBe(false);
    expect(isSubmitted(flat.state, "claude_code", "a")).toBe(true);
    expect(parseState("{").corrupt).toBe(true);
    expect(parseState("{").state.entries).toEqual({});
    const wrapped = normalizeState({ revision: 2, state: { entries: { "codex:b": { status: "deferred", timestamp: 1, error: null } } } });
    expect(wrapped.entries["codex:b"]?.status).toBe("deferred");
  });

  it("two windows: the stale write loses, the retry keeps both keys", async () => {
    const store = disk();
    const first = await store.load();
    const second = await store.load();
    expect(await store.cas(first.revision, withEntry(first.state, "claude_code", "one", entry("submitted", 1)))).toBe(true);
    expect(await store.cas(second.revision, withEntry(second.state, "claude_code", "two", entry("submitted", 1)))).toBe(false);
    const fresh = await store.load();
    expect(await store.cas(fresh.revision, withEntry(fresh.state, "claude_code", "two", entry("submitted", 1)))).toBe(true);
    const done = await store.load();
    expect(isSubmitted(done.state, "claude_code", "one")).toBe(true);
    expect(isSubmitted(done.state, "claude_code", "two")).toBe(true);
  });

  it("counts tokens as at most one per four bytes, and only prices a known rate", () => {
    expect(tokensAtMost(0)).toBe(0);
    expect(tokensAtMost(1)).toBe(1);
    expect(tokensAtMost(5)).toBe(2);
    expect(estimateSentence(4000, "ollama")).toBe("About 1,000 tokens at most. On this Mac, no model fee.");
    expect(estimateSentence(4000, "xai")).toContain("isn't in the list");
    expect(estimateSentence(4_000_000, "xai", 2)).toBe("About 1,000,000 tokens at most. At $2 per million tokens, that is about $2.00.");
  });

  it("drops a bullet with no source and a made-up one", () => {
    const allowed = new Set(["sess-1#m1"]);
    const cleaned = dropLinesWithoutSource(
      ["# Title", "", "- Kept [src: sess-1 #m1]", "- Bare", "- Fake [src: no #m9]"].join("\n"),
      allowed,
    );
    expect(cleaned.text).toBe("- Kept [src: sess-1 #m1]");
    expect(proposalId("claude_code", "notes/chat.jsonl")).toMatch(/^[a-z0-9-]{1,80}$/);
    expect(sendable([message({ content: "ok" }), message({ content: KEY, secret: true, messageId: "m2" })])).toHaveLength(1);
    expect(batchPrompt(
      {
        id: "sess-1",
        sourceKey: "a",
        source: "claude_code",
        project: "notes",
        title: "",
        messages: [],
        skippedLines: 0,
        secrets: 0,
      },
      [message({ content: "ok" })],
    )).not.toContain(KEY);
  });
});

describe("a cancel, a shared id, and a key-name secret", () => {
  const one = (content: string, sourceKey = "one.jsonl"): Conversation => ({
    id: "sess-1",
    sourceKey,
    source: "claude_code",
    project: "notes",
    title: "",
    messages: [message({ content })],
    skippedLines: 0,
    secrets: 0,
  });

  it("does not offer a private chat, and does not mark it done", async () => {
    const store = disk();
    const asked: string[] = [];
    const summary = await runImport(
      harness(
        store,
        [
          { kind: "chat", conversation: one("secret") },
          { kind: "chat", conversation: { ...one("public", "two.jsonl"), id: "public-sess" } },
        ],
        {
          ask: async (prompt) => {
            asked.push(prompt);
            return citingAsk([])(prompt);
          },
          excludedKeys: new Set(["sess-1"]),
        },
      ),
    );
    expect(summary.total).toBe(1);
    expect(summary.submitted).toBe(1);
    expect(asked.some((prompt) => prompt.includes("secret"))).toBe(false);
    expect(isSubmitted(store.get(), "claude_code", "one.jsonl")).toBe(false);
    expect(isSubmitted(store.get(), "claude_code", "two.jsonl")).toBe(true);
  });

  it("does not save a chat cancelled while the model call is in flight", async () => {
    const store = disk();
    let stop = false;
    const summary = await runImport(
      harness(store, [{ kind: "chat", conversation: one("hello") }], {
        ask: async (prompt) => {
          stop = true;
          return citingAsk([])(prompt);
        },
        cancelled: () => stop,
      }),
    );
    expect(summary.cancelled).toBe(true);
    expect(summary.submitted).toBe(0);
    expect(summary.proposals).toEqual([]);
    expect(store.get().entries).toEqual({});
  });

  it("uses a full hash so two chats do not share an id", () => {
    const hex = createHash("sha256").update("claude_code:notes/chat.jsonl").digest("hex");
    const id = proposalId("claude_code", "notes/chat.jsonl");
    expect(id).toBe(`hi-${hex}`);
    expect(id).toMatch(/^hi-[a-f0-9]{64}$/);
    expect(proposalId("claude_code", "other.jsonl")).not.toBe(id);
  });

  it("does not mark a chat done when that draft id belongs to someone else", async () => {
    const store = disk();
    const summary = await runImport(
      harness(store, [{ kind: "chat", conversation: one("hello", "second.jsonl") }], {
        writeProposal: async () => {
          throw new Error("A draft with that id is already there.");
        },
      }),
    );
    expect(summary.submitted).toBe(0);
    expect(summary.proposals).toEqual([]);
    expect(isSubmitted(store.get(), "claude_code", "second.jsonl")).toBe(false);
  });

  it("marks the same chat done when its draft is already on disk", async () => {
    const store = disk();
    const summary = await runImport(
      harness(store, [{ kind: "chat", conversation: one("hello") }], {
        writeProposal: async () => {
          throw new Error("This chat was already drafted.");
        },
      }),
    );
    expect(summary.submitted).toBe(1);
    expect(isSubmitted(store.get(), "claude_code", "one.jsonl")).toBe(true);
  });

  it("treats the command's string rejection as already drafted, so the next run skips it", async () => {
    const store = disk();
    const summary = await runImport(
      harness(store, [{ kind: "chat", conversation: one("hello") }], {
        writeProposal: async () => {
          throw "This chat was already drafted.";
        },
      }),
    );
    expect(summary.failed).toBe(0);
    expect(summary.submitted).toBe(1);
    expect(isSubmitted(store.get(), "claude_code", "one.jsonl")).toBe(true);

    let asks = 0;
    const loaded = await store.load();
    const again = await runImport(
      harness(store, [{ kind: "chat", conversation: one("hello") }], {
        state: loaded.state,
        revision: loaded.revision,
        ask: async (prompt) => {
          asks += 1;
          return citingAsk([])(prompt);
        },
      }),
    );
    expect(again.skipped).toBe(1);
    expect(again.submitted).toBe(0);
    expect(asks).toBe(0);
  });

  it("still fails when the command rejects with a different string", async () => {
    const store = disk();
    const summary = await runImport(
      harness(store, [{ kind: "chat", conversation: one("hello") }], {
        writeProposal: async () => {
          throw "That draft belongs to a different chat.";
        },
      }),
    );
    expect(summary.submitted).toBe(0);
    expect(summary.failed).toBe(1);
    expect(isSubmitted(store.get(), "claude_code", "one.jsonl")).toBe(false);
  });

  it("drops a key-name secret before it is sent or kept, and keeps a short value", async () => {
    const named = "token=abcdefgh";
    const conversation: Conversation = {
      ...one("I decide on Tuesday"),
      messages: [message({ content: named, messageId: "m1" }), message({ content: "I decide on Tuesday", messageId: "m2" })],
    };
    expect(sendable(conversation.messages).map((item) => item.messageId)).toEqual(["m2"]);
    expect(sendable([message({ content: "token=short" })])).toHaveLength(1);
    const prompts: string[] = [];
    const store = disk();
    const summary = await runImport(
      harness(store, [{ kind: "chat", conversation }], {
        ask: async (prompt) => {
          prompts.push(prompt);
          return {
            ok: true as const,
            text: [`- ${named} [src: sess-1 #m2]`, "- Decides on Tuesday [src: sess-1 #m2]"].join("\n"),
          };
        },
      }),
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(named);
    expect(summary.proposals).toHaveLength(1);
    expect(summary.proposals[0].markdown).toBe("- Decides on Tuesday [src: sess-1 #m2]");
    expect(summary.proposals[0].markdown).not.toContain(named);
  });

  it("marks a hermes file done only once every session in it is submitted", async () => {
    const session = (id: string): Conversation => ({
      id,
      sourceKey: `sessions/h.jsonl#${id}`,
      source: "hermes",
      project: "notes",
      title: "",
      messages: [message({ conversationId: id, content: id })],
      skippedLines: 0,
      secrets: 0,
    });
    const store = disk();
    const both = await runImport(
      harness(store, [
        { kind: "chat", conversation: session("one") },
        { kind: "chat", conversation: session("two") },
      ]),
    );
    expect(both.submitted).toBe(2);
    expect(isSubmitted(store.get(), "hermes", "sessions/h.jsonl#one")).toBe(true);
    expect(isSubmitted(store.get(), "hermes", "sessions/h.jsonl#two")).toBe(true);
    expect(isSubmitted(store.get(), "hermes", "sessions/h.jsonl")).toBe(true);

    const stuck = disk();
    await runImport(
      harness(stuck, [
        { kind: "chat", conversation: session("one") },
        { kind: "chat", conversation: session("two") },
      ], {
        writeProposal: async (_id, _markdown, meta) => {
          if (meta.conversationId === "two") throw new Error("The draft could not be saved.");
        },
      }),
    );
    expect(isSubmitted(stuck.get(), "hermes", "sessions/h.jsonl#one")).toBe(true);
    expect(isSubmitted(stuck.get(), "hermes", "sessions/h.jsonl#two")).toBe(false);
    expect(isSubmitted(stuck.get(), "hermes", "sessions/h.jsonl")).toBe(false);
  });

  it("records a hermes file when every session in it was already submitted", async () => {
    const store = disk();
    store.sneak("hermes", "sessions/h.jsonl#one");
    store.sneak("hermes", "sessions/h.jsonl#two");
    const session = (id: string): Conversation => ({
      id,
      sourceKey: `sessions/h.jsonl#${id}`,
      source: "hermes",
      project: "notes",
      title: "",
      messages: [message({ conversationId: id, content: id })],
      skippedLines: 0,
      secrets: 0,
    });
    const loaded = await store.load();
    const summary = await runImport(
      harness(store, [
        { kind: "chat", conversation: session("one") },
        { kind: "chat", conversation: session("two") },
      ], {
        state: loaded.state,
        revision: loaded.revision,
      }),
    );
    expect(summary.skipped).toBe(2);
    expect(summary.submitted).toBe(0);
    expect(isSubmitted(store.get(), "hermes", "sessions/h.jsonl#one")).toBe(true);
    expect(isSubmitted(store.get(), "hermes", "sessions/h.jsonl#two")).toBe(true);
    expect(isSubmitted(store.get(), "hermes", "sessions/h.jsonl")).toBe(true);
  });
});

describe("readers agree on one dispatch", () => {
  it("parses each source", () => {
    expect(parseTranscript("claude_code", "a.jsonl", fixture("claude.jsonl"))).toHaveLength(1);
    expect(parseTranscript("codex", "a.jsonl", fixture("codex.jsonl"))).toHaveLength(1);
    expect(parseTranscript("hermes", "a.jsonl", fixture("hermes.jsonl"))).toHaveLength(1);
  });
});
