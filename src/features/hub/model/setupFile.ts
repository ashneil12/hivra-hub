// The v1 setup file (a single .json, before Phase 5). The app no longer writes it; an import still reads it and
// migrates it to the v2 setup document (src/features/portable/model/setupDoc.ts, migrateV1).
import { validGroupChats } from "./hubChats";
import type { Page } from "../../pages/model/pages";
import type { GroupChat, HubProject } from "./types";
import type { SetupSoul } from "./setupSouls";
import type { TemplateId } from "./templates";

export type SetupBot = {
  id: string;
  name: string;
  /** One line on what it does. */
  role: string;
  projectId: string;
  team: "leadership" | "coding";
  skills: number;
  mascot: string;
};
export type SetupConnector = { id: string; name: string; projectId: string };

export type SetupFile = {
  format: "monocode-hub-setup";
  version: 1;
  projects: (HubProject & { template: TemplateId })[];
  bots?: SetupBot[];
  chats?: GroupChat[];
  /** Which services the bots use. Never carries passwords or keys. */
  connectors?: SetupConnector[];
  /** Kept Pages. They come back with no permissions; Ash allows their asks again. */
  pages?: Page[];
  /** Each Mono's soul: role, rules, memory, workflows and skills. Monos that aren't seated wait for Ash's OK. */
  souls?: SetupSoul[];
};

export function parseSetup(text: string): SetupFile {
  let data: Partial<SetupFile>;
  try {
    data = JSON.parse(text) as Partial<SetupFile>;
  } catch {
    throw new Error("That file isn't a Monocode setup export.");
  }
  if (data.format !== "monocode-hub-setup" || !Array.isArray(data.projects)) throw new Error("That file isn't a Monocode setup export.");
  return {
    format: "monocode-hub-setup",
    version: 1,
    projects: data.projects,
    bots: Array.isArray(data.bots) ? data.bots : [],
    connectors: Array.isArray(data.connectors) ? data.connectors : [],
    pages: Array.isArray(data.pages) ? data.pages : [],
    souls: Array.isArray(data.souls) ? data.souls : [],
    chats: validGroupChats(data.chats),
  };
}
