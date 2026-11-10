// WP-123: the app's own commands for giving a fork its own copy of a generated image.
import { invoke } from "@tauri-apps/api/core";
import { deleteGeneratedImages, saveGeneratedImage, statFiles } from "../../../platform/tauri/fs";
import type { ForkImageAsset, ForkImagePort } from "./threadFork";

/** True only when the file check ran and found no file. A check that could not run says nothing. */
async function originalIsGone(path: string): Promise<boolean> {
  try {
    const [found] = await statFiles([path]);
    return found !== undefined && found.mtimeMs === null;
  } catch {
    return false;
  }
}

/**
 * Read the original's file and save it as a new generated image, so the two chats never share a path. Null when the
 * original is no longer on disk (a fork can carry on without that picture); any other failure is thrown.
 */
export async function copyGeneratedImage(path: string, name: string): Promise<ForkImageAsset | null> {
  let data: string;
  try {
    data = await invoke<string>("read_file_base64", { path });
  } catch (error) {
    if (await originalIsGone(path)) return null;
    throw error;
  }
  return saveGeneratedImage({ data, name });
}

export const forkImagePort: ForkImagePort = {
  copyImage: copyGeneratedImage,
  removeImages: deleteGeneratedImages,
};
