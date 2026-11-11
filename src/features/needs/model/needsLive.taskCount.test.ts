// The live task read and Home's opening count are the same list.
import { beforeEach, expect, it, vi } from "vitest";

const TASK = {
  id: "t1",
  projectId: "hivra",
  title: "Which font for the landing page?",
  status: "In progress",
  source: "agent",
  needsYou: true,
  createdAt: 1,
};

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "tasks_list") return [TASK];
    if (cmd === "decisions_list" || cmd === "pr_watch_list" || cmd === "gate_cards") return [];
    return null;
  }),
}));

import { loadNeedsYouCount, type HomeSource } from "../../home/model/load";
import { mockHubData } from "../../hub/model/mockData";
import { setHubDataSource } from "../../hub/model/hubData";
import type { HubProject } from "../../hub/model/types";
import { factsFromParts, refreshNeedsRemote, resetNeedsLiveForTest, type NeedsParts } from "./needsLive";
import { needsYouQuiet } from "./needsYou";

const NOW = 1_700_000_000_000;
const HUB_PROJECTS: HubProject[] = [
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "folder", folder: "/work/hivra" },
];

function parts(): NeedsParts {
  return {
    remote: { decisions: [], cards: [], watches: [] },
    rows: [],
    projects: HUB_PROJECTS.map((project) => ({ id: project.id, name: project.name, folder: project.folder ?? null })),
    chats: [],
    pages: [],
    delegations: [],
  };
}

beforeEach(() => {
  resetNeedsLiveForTest();
  setHubDataSource({ ...mockHubData, listProjects: () => HUB_PROJECTS });
});

it("the live task read and the opening count are both one", async () => {
  await refreshNeedsRemote();
  const list = needsYouQuiet(factsFromParts(parts()), NOW);
  const source = {
    projects: () => [{ id: "hivra", name: "Hivra", folder: "/work/hivra" }],
    decisions: async () => [],
    tasks: async (key: string) => (key === "hivra" ? [TASK] : []),
  } as unknown as HomeSource;
  const opening = await loadNeedsYouCount(source);
  expect(list).toHaveLength(1);
  expect(opening).toBe(1);
  expect(opening).toBe(list.length);
});
