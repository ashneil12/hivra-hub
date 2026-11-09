// WP-51: the Settings wrapper. The screen itself does not import Tauri.

import { invoke } from "@tauri-apps/api/core";
import { useMemo } from "react";
import { learnSkillLesson, takeBackSkillLesson } from "../../selfBuild/model/skillLearn";
import { parseDoc, type MemoryDoc } from "../model/doc";
import { LearnFromChats } from "./LearnFromChats";
import { learnPorts } from "./learnHost";
import { MemoryReview, type ImportRow, type MemoryPorts } from "./MemoryReview";
import { MemoryTierSetting } from "./MemoryTierChoice";

type Loaded = { revision: number; doc: unknown };
type Listed = { id: string; project: string; conversationId: string; source: string; status: string; markdown: string };

function realPorts(): MemoryPorts {
  return {
    load: async () => {
      const loaded = await invoke<Loaded>("memory_review_load");
      const doc = parseDoc(loaded.doc);
      doc.revision = typeof loaded.revision === "number" ? loaded.revision : 0;
      return doc;
    },
    save: (revision, doc: MemoryDoc) => invoke<boolean>("memory_review_cas", { revision, doc }),
    proposals: async () => {
      const rows = await invoke<Listed[]>("history_import_list_proposals");
      return rows.map((row): ImportRow => ({ id: row.id, project: row.project, markdown: row.markdown, status: row.status }));
    },
    reviewImport: (id, decision) => invoke<boolean>("history_import_review_proposal", { id, decision }),
    writeSkill: async (name, lesson) => {
      await learnSkillLesson({ skill: name, lesson, by: "memory" });
    },
    undoSkill: (name, lesson) => takeBackSkillLesson(name, lesson),
  };
}

export function MemorySettingsScreen() {
  const ports = useMemo(() => realPorts(), []);
  // WP-83: proposals from past chats, beside the memory review.
  const learn = useMemo(() => learnPorts(), []);
  return (
    <>
      {/* WP-103: how Hivra remembers, above what it remembers. */}
      <div className="mb-6">
        <MemoryTierSetting />
      </div>
      <MemoryReview ports={ports} />
      <LearnFromChats ports={learn} />
    </>
  );
}
