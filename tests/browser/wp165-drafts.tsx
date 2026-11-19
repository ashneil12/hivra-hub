// WP-165. The morning list of overnight drafts, and the setting while it is still off.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { defaultArrangement } from "../../src/features/home/model/arrangement";
import { HomeScreen } from "../../src/features/home/ui/HomeScreen";
import { MorningDrafts } from "../../src/features/overnightScout/ui/MorningDrafts";
import { OvernightScoutSetting } from "../../src/features/overnightScout/ui/OvernightScoutSetting";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

installFakeTauri("drafts", (command) => {
  if (command === "plugin:hub|local_hub_read") return { value: null, rev: 0 };
  if (command === "plugin:hub|local_hub_write") return 1;
  return null;
});

const quiet = {
  date: "Thursday 19 November",
  chief: {
    missing: false,
    name: "Example: Chief of Staff",
    options: [],
    onAdd: () => undefined,
    onOpenChat: () => undefined,
    onOption: () => undefined,
  },
  needs: [],
  needsTotal: 0,
  builders: [],
  working: [],
  workingTotal: 0,
  done: [],
  onSeeNeeds: () => undefined,
  arrangement: defaultArrangement(),
  catalog: [],
  known: true,
  failed: false,
  onOpen: () => undefined,
  onHide: () => undefined,
  onShow: () => undefined,
  onPin: () => undefined,
  onUnpin: () => undefined,
  onAsk: () => undefined,
};

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    createElement(
      "div",
      null,
      createElement(
        "div",
        { "data-quiet-home": "" },
        createElement(HomeScreen, quiet),
      ),
      createElement(
        "div",
        { "data-draft-home": "" },
        createElement(HomeScreen, {
          ...quiet,
          drafts: createElement(MorningDrafts, {
            drafts: [
              {
                id: "draft-auth",
                title: "Example: Auth for the desk",
                parked: true,
                brief: "Already taken: auth.\n",
              },
              {
                id: "draft-queue",
                title: "Example: Show the queue",
                parked: false,
                brief: "Source: firstmate (MIT).\n",
              },
            ],
          }),
        }),
      ),
      createElement(OvernightScoutSetting),
    ),
  );
}
