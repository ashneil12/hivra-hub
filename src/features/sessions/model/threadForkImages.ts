// WP-123: the app's own commands for giving a fork its own copy of a generated image.
import { invoke } from "@tauri-apps/api/core";
import { deleteGeneratedImages, saveGeneratedImage } from "../../../platform/tauri/fs";
import type { ForkImageAsset, ForkImagePort } from "./threadFork";

/** Read the original's file and save it as a new generated image, so the two chats never share a path. */
export async function copyGeneratedImage(path: string, name: string): Promise<ForkImageAsset> {
  const data = await invoke<string>("read_file_base64", { path });
  return saveGeneratedImage({ data, name });
}

export const forkImagePort: ForkImagePort = {
  copyImage: copyGeneratedImage,
  removeImages: deleteGeneratedImages,
};
