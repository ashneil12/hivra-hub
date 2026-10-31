// @vitest-environment happy-dom
// r101 (2): the Lead gets the live count of its Inbox asks with Ash's status question, so "waiting on you" equals the
// card (B5 842b said 2 while the card showed 3). (8): it points to them with short names, never relists options.
import { beforeEach, expect, it } from "vitest";
import { mockHubData } from "./mockData";
import { setHubDataSource } from "./hubData";
import type { HubProject } from "./types";
import { noteChats, resetWaitingChats, setWorkerQuestionRouter } from "./waitingChats";
import { asksHowThingsStand, INBOX_COUNT_PREFIX, withInboxCount } from "./inboxCountNote";

const PROJECTS: HubProject[] = [{ id: "tally", name: "Tally", shortName: "Tally", iconShape: "folder", folder: "/p/tally" }];
type Chat = Parameters<typeof noteChats>[0][number];
const REPLY = [
  "Needs Ash: Which project is the onboarding, price page, and dashboard?\nMy pick: Hold them.",
  "Needs Ash: Share link on Nibbii, view-only or editable?\nMy pick: View-only.",
  "Needs Ash: Which keys for a new chat?\nMy pick: Cmd+N.",
].join("\n\n");
const lead: Chat = { id: "lead1", cwd: "/p/tally", title: "Tally lead", harness: "claude", busy: false, blocks: [{ role: "user", text: "dump", startedAt: 1 }, { role: "assistant", text: REPLY }] as Chat["blocks"] };

beforeEach(() => {
  localStorage.clear();
  resetWaitingChats();
  setHubDataSource({ ...mockHubData, listProjects: () => PROJECTS });
  setWorkerQuestionRouter(undefined);
});

it("reads Ash's status questions", () => {
  expect(asksHowThingsStand("wat happened to the stuff i dumped earlier")).toBe(true);
  expect(asksHowThingsStand("where are we")).toBe(true);
  expect(asksHowThingsStand("fix the send button")).toBe(false);
});

it("adds the live Inbox count for that Lead with short names and no options, only to a status question", () => {
  noteChats([lead]);
  const isLead = (id: string) => id === "lead1";
  const wire = withInboxCount("lead1", "wat happened to the stuff i dumped earlier", isLead);
  expect(wire).toContain(INBOX_COUNT_PREFIX);
  expect(wire).toContain("holds 3 asks from you");
  expect(wire).toContain('"waiting on you" is exactly 3');
  expect(wire).toContain("Share link on Nibbii");
  expect(wire).not.toMatch(/My pick|View-only\./);
  expect(wire).toMatch(/never list their options or picks again/);
  expect(withInboxCount("lead1", "fix the send button", isLead)).toBe("fix the send button");
  expect(withInboxCount("other", "where are we", isLead)).toBe("where are we");
  expect(withInboxCount("lead2", "where are we", () => true)).toMatch(/leave "waiting on you" out/);
});
