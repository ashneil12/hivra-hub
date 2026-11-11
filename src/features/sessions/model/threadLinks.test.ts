import { describe, expect, it } from "vitest";
import {
  chatLink,
  isLocalPromptText,
  isLocalThreadId,
  parseThreadLink,
  promptLink,
  THREAD_LINK_MESSAGE,
} from "./threadLinks";

const CHAT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function rejected(raw: string) {
  const parsed = parseThreadLink(raw);
  expect(parsed.ok, raw).toBe(false);
  if (parsed.ok) throw new Error("expected a rejection");
  return parsed;
}

describe("local thread links", () => {
  it("builds a chat link and a prompt link that parse back", () => {
    const chat = chatLink(CHAT);
    expect(chat).toBe(`hivra://local/chat/${CHAT}`);
    expect(parseThreadLink(chat!)).toEqual({
      ok: true,
      link: { kind: "chat", sessionId: CHAT },
    });

    const text = "Fix the save bug\nKeep café & co?";
    const prompt = promptLink("exo", text);
    expect(prompt).toMatch(/^hivra:\/\/local\/prompt\/exo\?text=/);
    expect(parseThreadLink(prompt!)).toEqual({
      ok: true,
      link: { kind: "prompt", projectId: "exo", text },
    });
  });

  it("rejects a unicode id and still accepts an empty prompt", () => {
    expect(isLocalThreadId("café")).toBe(false);
    expect(isLocalThreadId("café")).toBe(false);
    expect(chatLink("café")).toBeNull();
    expect(promptLink("café", "hello")).toBeNull();
    expect(rejected(`hivra://local/chat/${encodeURIComponent("café")}`).reason).toBe(
      "unknown",
    );
    const prompt = promptLink("exo", "");
    expect(parseThreadLink(prompt!)).toEqual({
      ok: true,
      link: { kind: "prompt", projectId: "exo", text: "" },
    });
    expect(parseThreadLink(`hivra://local/chat/${CHAT}?`)).toEqual({
      ok: true,
      link: { kind: "chat", sessionId: CHAT },
    });
    expect(parseThreadLink(`HIVRA://LOCAL/chat/${OTHER}`)).toEqual({
      ok: true,
      link: { kind: "chat", sessionId: OTHER },
    });
  });

  it("refuses to build a link for a bad id or a huge prompt", () => {
    expect(chatLink("")).toBeNull();
    expect(chatLink("..")).toBeNull();
    expect(chatLink(".")).toBeNull();
    expect(chatLink("has space")).toBeNull();
    expect(chatLink("a/b")).toBeNull();
    expect(chatLink("-lead")).toBeNull();
    expect(chatLink("a".repeat(129))).toBeNull();
    expect(promptLink("exo", "x".repeat(8001))).toBeNull();
    expect(promptLink("exo", "ok\0no")).toBeNull();
    expect(isLocalPromptText("x".repeat(8000))).toBe(true);
    expect(promptLink("exo", "x".repeat(8000))).not.toBeNull();
  });

  it("rejects an empty link", () => {
    expect(rejected("")).toMatchObject({ reason: "empty", message: THREAD_LINK_MESSAGE.empty });
    expect(rejected("   ")).toMatchObject({ reason: "empty" });
  });

  it("rejects off-machine shapes", () => {
    const samples = [
      "https://example.com/chat/" + CHAT,
      "http://local/chat/" + CHAT,
      "file:///tmp/chat/" + CHAT,
      "javascript:alert(1)",
      `hivra://evil.example/chat/${CHAT}`,
      `hivra://localhost/chat/${CHAT}`,
      `hivra://local:443/chat/${CHAT}`,
      `hivra://user:secret@local/chat/${CHAT}`,
      `hivra:///chat/${CHAT}`,
      `hivra://local.example/chat/${CHAT}`,
      `monocode://local/chat/${CHAT}`,
    ];
    for (const sample of samples) {
      const parsed = rejected(sample);
      expect(parsed.reason, sample).toBe("off-machine");
      expect(parsed.message).toBe(THREAD_LINK_MESSAGE.offMachine);
      expect(parsed.message).not.toMatch(/https?:\/\//);
      expect(JSON.stringify(parsed)).not.toContain(sample);
    }
  });

  it("rejects public, signed, and guest links", () => {
    const samples = [
      `hivra://local/guest/${CHAT}`,
      `hivra://local/share/${CHAT}`,
      `hivra://local/public/${CHAT}`,
      `hivra://local/signed/${CHAT}`,
      `hivra://local/chat/${CHAT}?guest=1`,
      `hivra://local/chat/${CHAT}?sig=abc`,
      `hivra://local/chat/${CHAT}?signature=abc`,
      `hivra://local/prompt/exo?text=hi&token=sekret`,
      `hivra://local/prompt/exo?text=hi&public=1`,
      `hivra://local/prompt/exo?redirect=https://example.com&text=hi`,
    ];
    for (const sample of samples) {
      const parsed = rejected(sample);
      expect(parsed.reason, sample).toBe("public");
      expect(parsed.message).toBe(THREAD_LINK_MESSAGE.public);
      expect(JSON.stringify(parsed)).not.toMatch(/https?:\/\//);
    }
  });

  it("rejects unknown shapes, bad ids, and duplicate text", () => {
    const samples = [
      "not a url",
      `hivra://local/chat/${CHAT} ${OTHER}`,
      `hivra://local/files/${CHAT}`,
      "hivra://local/chat",
      `hivra://local/chat/${CHAT}/extra`,
      "hivra://local/chat/..",
      "hivra://local/chat/%2e%2e",
      "hivra://local/chat/%2Fetc",
      "hivra://local/chat/has%20space",
      `hivra://local/chat/${CHAT}#later`,
      `hivra://local/chat/${CHAT}?text=no`,
      "hivra://local/prompt/exo",
      "hivra://local/prompt/exo?text=one&text=two",
      "hivra://local/prompt/exo?text=hi&extra=1",
      "hivra://local/prompt/exo?foo=1",
      `hivra://local/chat/${CHAT}\nhttps://example.com`,
      "hivra://local/chat/%",
      "hivra://local/chat/-no",
    ];
    for (const sample of samples) {
      const parsed = rejected(sample);
      expect(parsed.reason, sample).toBe("unknown");
      expect(parsed.message).toBe(THREAD_LINK_MESSAGE.unknown);
    }
  });

  it("rejects a prompt that is too long or has a hidden control", () => {
    const long = `hivra://local/prompt/exo?text=${encodeURIComponent("x".repeat(8001))}`;
    expect(rejected(long)).toMatchObject({
      reason: "too-long",
      message: THREAD_LINK_MESSAGE.tooLong,
    });
    const hidden = `hivra://local/prompt/exo?text=${encodeURIComponent("hi\u0000there")}`;
    expect(rejected(hidden).reason).toBe("unknown");
  });

  it("does not echo a private path or a dash that is not a hyphen", () => {
    const parsed = rejected("https://example.com/Users/someone/secret");
    expect(parsed.message).not.toContain("/Users/");
    expect(parsed.message).not.toMatch(/[—–]/);
    for (const message of Object.values(THREAD_LINK_MESSAGE)) {
      expect(message).not.toMatch(/[—–]/);
    }
  });
});
