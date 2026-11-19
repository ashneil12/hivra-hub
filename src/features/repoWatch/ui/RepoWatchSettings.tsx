import { invoke } from "@tauri-apps/api/core";
import { pickFiles, pickFolders, readTextFile } from "../../../platform/tauri/fs";
import type { PinIo } from "../model/pinStore";
import { RepoWatchPage } from "./RepoWatchPage";

function tauriPinIo(): PinIo {
  return {
    async read(projectRoot) {
      const text = await invoke<string>("repo_watch_load", { project: projectRoot });
      return { text };
    },
    write(projectRoot, text, expectedRevision) {
      return invoke<boolean>("repo_watch_cas", {
        project: projectRoot,
        expected: expectedRevision,
        body: text,
      });
    },
  };
}

/** Settings → Repo watch. The page itself takes a store so tests never touch the disk. */
export function RepoWatchSettings({ projectRoot }: { projectRoot: string }) {
  return (
    <RepoWatchPage
      projectRoot={projectRoot}
      io={tauriPinIo()}
      pickFile={async () => {
        const picked = await pickFiles("Import a pin file", [{ name: "Pin file", extensions: ["json"] }]);
        return picked?.[0] ?? null;
      }}
      pickFolder={async () => {
        const picked = await pickFolders("Import pins from a folder");
        return picked[0] ?? null;
      }}
      readPicked={readTextFile}
    />
  );
}
