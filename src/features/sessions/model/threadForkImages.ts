// WP-123: the app's own commands for giving a fork its own copy of a generated image.
import { invoke } from "@tauri-apps/api/core";
import { deleteGeneratedImages } from "../../../platform/tauri/fs";
import type { ForkImageAsset, ForkImagePort } from "./threadFork";

/**
 * Have the app copy a generated image into a new file of its own, so the two chats never share a path. The app
 * does the copy itself and only from its generated-images folder: a block's path comes from a saved chat, and an
 * imported or edited chat can name any file on the Mac, so it is never read into the page here. Null when there is
 * no such image to copy (the original is gone, or the path is not one of the app's own images); a fork carries on
 * without that picture. Any other failure is thrown.
 *
 * This asks the app on this Mac directly: a path that names a connected machine is not one of its images either.
 */
export async function copyGeneratedImage(path: string, name: string): Promise<ForkImageAsset | null> {
  return invoke<ForkImageAsset | null>("copy_generated_image", { path, name });
}

export const forkImagePort: ForkImagePort = {
  copyImage: copyGeneratedImage,
  removeImages: async (paths) => {
    await deleteGeneratedImages(paths);
  },
};
