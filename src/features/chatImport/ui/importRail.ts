// What the sidebar's small card says while the "bring my chats over" setup is under way, and which part of the setup
// a click brings the person back to.

import type { ImportState } from "../model/runner";
import type { SetupState } from "../model/setupStage";

/** The sidebar card asks the app to open the setup card again on one of its parts (`detail.part`). */
export const OPEN_IMPORT_SETUP_EVENT = "monocode:open-import-setup";

export type SetupPart = "choose" | "rules";

export type LearnView = { phase: string; read: number; target: number; proposals: unknown[] };

export type RailCard = {
  title: string;
  line: string;
  /** The part of the setup a click opens. Absent while there is nothing for the person to do. */
  open?: SetupPart;
  /** Work is going on behind the app. */
  busy: boolean;
  key: string;
};

const n = (value: number) => value.toLocaleString("en-GB");

export function railCard(setup: SetupState, state: ImportState, learn: LearnView): RailCard | null {
  switch (setup.stage) {
    case "sweep":
      return { title: "Finding your past chats", line: state.seen ? `${n(state.seen)} found so far` : "Looking", busy: true, key: "sweep" };
    case "choose": {
      const chats = state.groups.reduce((sum, group) => sum + group.chats, 0);
      if (state.phase !== "ready") return { title: "Finding your past chats", line: "Looking", busy: true, key: "sweep" };
      return {
        title: "Your chats are found",
        line: chats ? `${n(chats)} chats. Choose what comes in` : "None on this computer",
        open: "choose",
        busy: false,
        key: "choose",
      };
    }
    case "importing":
      return { title: "Bringing in your chats", line: `${n(state.done)} of ${n(state.toImport)}`, busy: true, key: "importing" };
    case "reading":
      return {
        title: "Reading how you work",
        line: learn.phase === "asking" ? "Writing suggestions" : `${n(learn.read)} of ${n(learn.target || learn.read)} chats`,
        busy: true,
        key: "reading",
      };
    case "rules": {
      const count = learn.proposals.length;
      return {
        title: `${n(count)} suggested ${count === 1 ? "rule is" : "rules are"} ready`,
        line: "Go through them",
        open: "rules",
        busy: false,
        key: "rules",
      };
    }
    default:
      return null;
  }
}
