// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, it } from "vitest";
import { StackList, type StackView } from "./StackList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows each name, the fake services and one mode line", async () => {
  const stacks: StackView[] = [
    {
      id: "saaaa1111",
      worktree: "/tmp/one",
      composeProject: "hivra-saaaa1111",
      url: "http://shop-wp-90.localhost:7400",
      running: true,
      stale: false,
      names: [
        { hostname: "shop-wp-90.localhost", url: "http://shop-wp-90.localhost:7400" },
        {
          hostname: "github-wp-90.localhost",
          url: "http://github-wp-90.localhost:7400",
          service: "github",
        },
      ],
      emulated: ["github"],
      mode: "Tests use fake GitHub",
    },
    {
      id: "sbbbb2222",
      worktree: "/tmp/two",
      composeProject: "hivra-sbbbb2222",
      url: "http://shop-wp-91.localhost:7400",
      running: true,
      stale: false,
      names: [{ hostname: "shop-wp-91.localhost", url: "http://shop-wp-91.localhost:7400" }],
      emulated: [],
      mode: "No outside services",
    },
  ];
  const host = document.createElement("div");
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(StackList, { stacks, onStop: () => undefined }));
  });
  const names = host.querySelector('[aria-label="Names"]');
  expect(names?.textContent).toContain("shop-wp-90.localhost");
  expect(names?.textContent).toContain("github-wp-90.localhost (fake github)");
  expect(host.textContent).toContain("Tests use fake GitHub");
  expect(host.querySelectorAll("a").length).toBe(2);
  expect([...host.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
    "http://shop-wp-90.localhost:7400",
    "http://shop-wp-91.localhost:7400",
  ]);
  act(() => root?.unmount());
  host.remove();
});
