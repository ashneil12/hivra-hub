import { describe, expect, it } from "vitest";
import { memoryGateway } from "./gateway";

function paragraph(text: string) {
  return {
    id: text,
    type: "paragraph",
    props: {},
    children: [],
    content: [{ type: "text", text, styles: {} }],
  };
}

const mention = {
  id: "b1",
  type: "paragraph",
  props: {},
  children: [],
  content: [{ type: "mention", props: { kind: "task", targetId: "task-1", name: "Write the spec" } }],
};

describe("memoryGateway", () => {
  it("does not version a blank page, and a duplicate snapshot is not a new version", async () => {
    const docs = memoryGateway();
    const created = await docs.create({ id: "page-1", title: "", body: "" });
    expect(created.status).toBe("saved");
    if (created.status !== "saved") return;
    expect(created.page.version).toBe(0);
    expect(created.page.title).toBe("Untitled");
    expect(await docs.versions("page-1")).toEqual([]);

    const edited = await docs.update({
      id: "page-1",
      title: "",
      body: "Hello",
      blocksJson: "[]",
      expectedVersion: 0,
      snapshot: true,
    });
    expect(edited.status).toBe("saved");
    expect(await docs.versions("page-1")).toHaveLength(1);

    const again = await docs.update({
      id: "page-1",
      title: "",
      body: "Hello",
      blocksJson: "[]",
      expectedVersion: edited.status === "saved" ? edited.page.version : 0,
      snapshot: true,
    });
    expect(again.status).toBe("saved");
    expect(await docs.versions("page-1")).toHaveLength(1);
  });

  it("restores an older version as a new version and returns that text", async () => {
    const docs = memoryGateway();
    const one = JSON.stringify([paragraph("one")]);
    const two = JSON.stringify([paragraph("two")]);
    await docs.create({ id: "page-1", title: "Plan", body: "one", blocksJson: one });
    const second = await docs.update({
      id: "page-1",
      title: "Plan",
      body: "two",
      blocksJson: two,
      expectedVersion: 1,
      snapshot: true,
    });
    expect(second.status).toBe("saved");
    const restored = await docs.restore({
      id: "page-1",
      version: 1,
      expectedVersion: second.status === "saved" ? second.page.version : 0,
    });
    expect(restored.status).toBe("saved");
    if (restored.status !== "saved") return;
    expect(restored.page.body).toBe("one");
    const rows = await docs.versions("page-1");
    expect(rows.map((row) => row.kind)).toEqual(["auto", "auto", "restore"]);
    expect(rows).toHaveLength(3);
  });

  it("refuses to move a page into itself", async () => {
    const docs = memoryGateway();
    await docs.create({ id: "parent", title: "Parent", body: "p" });
    await docs.create({ id: "child", title: "Child", body: "c", parentId: "parent" });
    await expect(docs.move({ id: "parent", parentId: "child", index: 0, expectedVersion: 1 })).rejects.toThrow(
      "A page cannot move into itself",
    );
  });

  it("does not report a mention the page already has, and a missing task is not found", async () => {
    const docs = memoryGateway();
    await docs.create({ id: "page-1", title: "Plan", body: "one" });
    const first = await docs.update({
      id: "page-1",
      title: "Plan",
      body: "one",
      blocksJson: JSON.stringify([mention]),
      expectedVersion: 1,
      snapshot: true,
    });
    expect(first.status).toBe("saved");
    if (first.status !== "saved") return;
    expect(first.newMentions.map((item) => item.targetId)).toEqual(["task-1"]);
    const second = await docs.update({
      id: "page-1",
      title: "Plan",
      body: "one more",
      blocksJson: JSON.stringify([mention]),
      expectedVersion: first.page.version,
      snapshot: true,
    });
    expect(second.status).toBe("saved");
    if (second.status !== "saved") return;
    expect(second.newMentions).toEqual([]);
    expect(await docs.resolve("task", "task-1")).toMatchObject({ found: false });
  });
});
