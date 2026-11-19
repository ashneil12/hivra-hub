// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDisk, type LocalHubDisk } from "../../hub/model/localHub/localHub";
import { briefRelativePath, draftId, type ProgrammeRow } from "../model/programme";
import { SCOUT_DEFAULTS } from "../model/settings";
import { changeScoutDoc, SCOUT_DOC_KEY } from "../model/store";
import { useMorningDrafts } from "./useMorningDrafts";

function row(title: string, createdAt: number): ProgrammeRow {
  const id = draftId("firstmate", title);
  return {
    id,
    wp: "",
    title,
    briefPath: briefRelativePath(id),
    branch: "",
    status: "queued",
    securityPark: false,
    draft: true,
    priority: 0,
    notes: "",
    projectId: "crew",
    createdAt,
    updatedAt: createdAt,
  };
}

function record(title: string, createdAt: number) {
  const next = row(title, createdAt);
  return {
    settings: { ...SCOUT_DEFAULTS, enabled: true },
    rows: [next],
    briefs: { [next.id]: `Source: firstmate (MIT).\n${title}\n` },
  };
}

function Probe({ disk }: { disk: LocalHubDisk }) {
  const drafts = useMorningDrafts(disk);
  return createElement(
    "ul",
    null,
    drafts.map((draft) => createElement("li", { key: draft.id }, draft.title)),
  );
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("morning draft hook", () => {
  it("shows the saved drafts, then a newer write from the other window", async () => {
    const disk = memoryDisk({ [SCOUT_DOC_KEY]: record("Show the queue", 10) });
    await act(async () => {
      root.render(createElement(Probe, { disk }));
    });
    expect(container.textContent).toContain("Show the queue");

    await act(async () => {
      await changeScoutDoc(disk, (doc) => ({
        ...doc,
        rows: [...doc.rows, row("Board notes", 20)],
        briefs: { ...doc.briefs, [draftId("firstmate", "Board notes")]: "Source: Orbit.\n" },
      }));
    });
    expect(container.textContent).toContain("Board notes");
  });

  it("keeps the list already shown when the next read times out", async () => {
    let calls = 0;
    let watch: (key: string, rev: number) => void = () => undefined;
    const disk: LocalHubDisk = {
      async read() {
        return null;
      },
      readDoc() {
        calls += 1;
        if (calls === 1) return Promise.resolve({ value: record("Show the queue", 10), rev: 1 });
        return Promise.reject(new Error("timed out"));
      },
      async write() {
        return 1;
      },
      watch(onChange) {
        watch = onChange;
        return () => undefined;
      },
    };
    await act(async () => {
      root.render(createElement(Probe, { disk }));
    });
    expect(container.textContent).toContain("Show the queue");
    await act(async () => {
      watch(SCOUT_DOC_KEY, 2);
    });
    expect(container.textContent).toContain("Show the queue");
    expect(calls).toBe(2);
  });

  it("drops a late read once a newer one has landed", async () => {
    const pending: Array<(value: { value: unknown; rev: number }) => void> = [];
    let watch: (key: string, rev: number) => void = () => undefined;
    const disk: LocalHubDisk = {
      async read() {
        return null;
      },
      readDoc() {
        return new Promise((resolve) => pending.push(resolve));
      },
      async write() {
        return 1;
      },
      watch(onChange) {
        watch = onChange;
        return () => undefined;
      },
    };
    await act(async () => {
      root.render(createElement(Probe, { disk }));
    });
    expect(pending).toHaveLength(1);
    act(() => watch(SCOUT_DOC_KEY, 2));
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[1]?.({ value: record("Board notes", 20), rev: 2 });
    });
    expect(container.textContent).toContain("Board notes");
    await act(async () => {
      pending[0]?.({ value: record("Show the queue", 10), rev: 1 });
    });
    expect(container.textContent).toContain("Board notes");
    expect(container.textContent).not.toContain("Show the queue");
  });
});
