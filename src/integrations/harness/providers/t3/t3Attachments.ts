// What a person attached, as T3 takes it. A picture a model can look at is uploaded to the engine and travels as a
// file of the message; anything else (a document, a folder, a picture with no data) is named by its path in the
// message, the way this app's own adapters hand it to a CLI that reads files itself.
import {
  attachmentPathText,
  isVisionImage,
  normalizeImageMime,
  promptText,
} from "../../../../features/sessions/model/attachments";
import type { Attachment } from "../../../../features/sessions/model/session";

/** T3's own limit for one picture (`PROVIDER_SEND_TURN_MAX_IMAGE_BYTES`). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type T3Upload = { type: "image"; name: string; mimeType: string; sizeBytes: number; dataUrl: string };
/** An attachment the engine holds (`ChatAttachment` in T3's contracts). */
export type T3Attachment = { type: string; id: string; name: string; mimeType: string; sizeBytes: number };

const uploadable = (file: Attachment): file is Attachment & { data: string } =>
  file.kind === "image" && !!file.data && isVisionImage(file.mimeType) && file.size <= MAX_IMAGE_BYTES;

/** The turn's text with every attachment that stays a path, and the pictures to upload. */
export function t3AttachmentParts(text: string, attachments: Attachment[]): { text: string; uploads: T3Upload[] } {
  const uploads = attachments.filter(uploadable).map((file): T3Upload => {
    const mimeType = normalizeImageMime(file.mimeType);
    return {
      type: "image",
      name: file.name.trim().slice(0, 255) || "image",
      mimeType,
      sizeBytes: file.size,
      dataUrl: `data:${mimeType};base64,${file.data}`,
    };
  });
  const paths = attachments.filter((file) => !uploadable(file)).map(attachmentPathText);
  return { text: [promptText(text, attachments), ...paths].filter(Boolean).join("\n\n"), uploads };
}
