// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { EVERY_PROJECT_LINE, readsEveryProject } from "../../chief/model/scope";
import { setMonoChatOpener } from "../../hub/model/hubNav";
import { listMonos } from "../../monos/model/mono";
import { addChiefOfStaff, chiefScopeLine, openChiefChat, pickChief } from "./chief";

beforeEach(() => localStorage.clear());

it("picks the mono that reads every project, even after a rename", () => {
  const renamed = { id: "c1", name: "Boss", everyProject: true };
  const named = { id: "c2", name: "Coordinator" };
  expect(pickChief([named, renamed])?.id).toBe("c1");
  expect(pickChief([{ id: "c2", name: "Chief of Staff" }])?.id).toBe("c2");
  expect(pickChief([{ id: "x", name: "Ada" }])).toBeUndefined();
});

it("breaks a tie by list order", () => {
  const first = { id: "a", name: "Coordinator", everyProject: true };
  const second = { id: "b", name: "Coordinator", everyProject: true };
  expect(pickChief([first, second])?.id).toBe("a");
});

it("says what the chief can read only when the scope is on", () => {
  const on = { everyProject: true, instructions: `Hello\n${EVERY_PROJECT_LINE}\n` };
  expect(chiefScopeLine(on, 7)).toBe("read all 7 projects");
  expect(chiefScopeLine(on, 1)).toBe("read all 1 project");
  expect(chiefScopeLine({ everyProject: true, instructions: "Hello" }, 7)).toBeUndefined();
  expect(chiefScopeLine(on, Number.NaN)).toBeUndefined();
});

it("adds the starter chief with the scope on, and opens that mono's chat", () => {
  const created = addChiefOfStaff();
  expect(created).toBeDefined();
  expect(created?.id).not.toBe("coordinator");
  expect(created?.name).toBe("Chief of Staff");
  expect(readsEveryProject(created)).toBe(true);
  expect(listMonos().some((mono) => mono.id === created?.id)).toBe(true);
  const opened: string[] = [];
  setMonoChatOpener((id) => opened.push(id));
  openChiefChat(created!.id);
  openChiefChat("  ");
  expect(opened).toEqual([created!.id]);
});
