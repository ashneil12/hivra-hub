import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  allowVideoStream,
  readChatImage,
  REMOTE_PATH_PREFIX,
} from "../../../platform/tauri/fs";
import {
  isImagePath,
  sniffImageMime,
  videoMimeForPath,
} from "../../files/model/filePreview";
import { chatMediaRoots, mayShowChatMedia } from "../model/chatMedia";

/** Whether a path names a file `LocalMedia` can show. */
export function isLocalMediaPath(path: string): boolean {
  return isImagePath(path) || videoMimeForPath(path) !== null;
}

type Media = { url: string; kind: "image" | "video" };

/**
 * A local image or video, shown in place of the reply's link to it. The reply
 * is untrusted, so only a file inside the chat's own folder `cwd` (or the
 * app's generated-images folder) is ever loaded, and Rust checks that again
 * against the real path, symlinks followed. Anything else, and anything
 * unreadable, falls back to the link it replaced, and a path outside the
 * folder asks for nothing at all. Files load once they scroll near view, so a
 * long history doesn't read every file up front. Local videos stream through
 * the asset protocol, which allows just that file, so their size doesn't
 * matter; images, and files on a connected machine, are read whole within the
 * preview limit. Images are sniffed and videos take only an explicit video
 * MIME, as in the file viewer, so neither can become a document.
 */
export function LocalMedia({
  path,
  cwd,
  label,
  onOpen,
  fallback,
}: {
  path: string;
  /** The chat's own folder, which the file must lie inside. */
  cwd: string | undefined;
  label: string;
  onOpen?: () => void;
  fallback: ReactNode;
}) {
  const allowed = mayShowChatMedia(path, cwd);
  const boxRef = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const [media, setMedia] = useState<Media | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    if (!allowed || !box || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "400px" },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [allowed, near]);

  useEffect(() => {
    if (!allowed || !near) return;
    let cancelled = false;
    let created: string | null = null;
    setMedia(null);
    setFailed(false);
    const fail = () => {
      if (!cancelled) setFailed(true);
    };
    const roots = chatMediaRoots(cwd);
    if (videoMimeForPath(path) && !path.startsWith(REMOTE_PATH_PREFIX)) {
      allowVideoStream(path, roots).then((allowedPath) => {
        if (!cancelled)
          setMedia({ url: convertFileSrc(allowedPath), kind: "video" });
      }, fail);
      return () => {
        cancelled = true;
      };
    }
    readChatImage(path, roots).then((bytes) => {
      if (cancelled) return;
      const video = videoMimeForPath(path);
      const mime = video ?? sniffImageMime(bytes);
      if (!mime) {
        setFailed(true);
        return;
      }
      created = URL.createObjectURL(new Blob([bytes], { type: mime }));
      setMedia({ url: created, kind: video ? "video" : "image" });
    }, fail);
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [allowed, near, path, cwd]);

  if (!allowed || failed) return <>{fallback}</>;
  // One fixed 16:9 box from placeholder to playback, so loading never moves
  // the chat; media fits inside it, letterboxed.
  return (
    <span
      ref={boxRef}
      data-local-media={path}
      className="my-2 block aspect-video w-80 max-w-full overflow-hidden rounded-xl border border-content/10 bg-content/5"
    >
      {!media ? null : media.kind === "video" ? (
        <video
          src={media.url}
          controls
          playsInline
          preload="metadata"
          aria-label={label}
          className="block size-full bg-black object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <img
          src={media.url}
          alt={label}
          title={onOpen ? "Open image" : undefined}
          draggable={false}
          onClick={onOpen}
          onError={() => setFailed(true)}
          className={`block size-full object-contain ${onOpen ? "cursor-zoom-in" : ""}`}
        />
      )}
    </span>
  );
}
