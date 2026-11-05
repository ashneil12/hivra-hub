import { expect, it } from "vitest";
import { removeProjectFromWindow } from "./removeProject";

it("does not drop the window until the trash accepts the project", async () => {
  let applied = false;
  await expect(
    removeProjectFromWindow({
      purgeData: true,
      trash: async () => {
        throw new Error("still running");
      },
      applyLocal: () => {
        applied = true;
      },
    }),
  ).rejects.toThrow("still running");
  expect(applied).toBe(false);
});

it("drops the window only after the trash accepts", async () => {
  const order: string[] = [];
  await removeProjectFromWindow({
    purgeData: true,
    trash: async () => {
      order.push("trash");
    },
    applyLocal: () => {
      order.push("local");
    },
  });
  expect(order).toEqual(["trash", "local"]);
});

it("an archive does not wait on the trash", async () => {
  const order: string[] = [];
  await removeProjectFromWindow({
    purgeData: false,
    trash: async () => {
      order.push("trash");
    },
    applyLocal: () => {
      order.push("local");
    },
  });
  expect(order).toEqual(["local"]);
});
