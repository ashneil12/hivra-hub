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
import { subscribeMonos } from "../../monos/model/mono";
import { mayShowChatMedia } from "../model/chatMedia";

/** Whether a path names a file `LocalMedia` can show. */
export function isLocalMediaPath(path: string): boolean {
  return isImagePath(path) || videoMimeForPath(path) !== null;
}

type Media = { url: string; kind: "image" | "video" };

/**
 * A local image or video, shown in place of the reply's link to it. The reply
 * is untrusted, so Rust decides what may load: it takes the chat's id, works
 * out from the app's records which folders that chat may show media from, and
 * checks the real path, symlinks followed (see `model/chatMedia.ts`). Anything
 * it refuses, and anything unreadable, falls back to the link it replaced. A
 * file on a connected machine loads only from the chat's own project there. A
 * chat with no id (one on a connected machine) asks for no local file. Files
 * load once they scroll near view, so a long history doesn't read every file
 * up front. Local videos stream through
 * the asset protocol, which allows just that file, so their size doesn't
 * matter; images, and files on a connected machine, are read whole within the
 * preview limit. Images are sniffed and videos take only an explicit video
 * MIME, as in the file viewer, so neither can become a document.
 */
export function LocalMedia({
  path,
  sessionId,
  cwd,
  label,
  onOpen,
  fallback,
}: {
  path: string;
  /** The saved chat that shows it, which Rust holds the file to. */
  sessionId: string | undefined;
  /** The chat's own folder, which a file on a connected machine must lie inside. */
  cwd: string | undefined;
  label: string;
  onOpen?: () => void;
  fallback: ReactNode;
}) {
  const allowed = mayShowChatMedia(path, cwd, sessionId);
  const boxRef = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const [media, setMedia] = useState<Media | null>(null);
  const [failed, setFailed] = useState(false);
  // What Rust allows depends on records that change (the chat is saved a moment
  // after it starts, a Mono is given a project), so a refused file is asked for
  // again when the roster changes, or the chat's id does.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!failed) return;
    return subscribeMonos(() => setAttempt((count) => count + 1));
  }, [failed]);

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
    // `allowed` is true for a local path only when there is a chat to ask for.
    const chat = sessionId ?? "";
    if (videoMimeForPath(path) && !path.startsWith(REMOTE_PATH_PREFIX)) {
      allowVideoStream(path, chat).then((allowedPath) => {
        if (!cancelled)
          setMedia({ url: convertFileSrc(allowedPath), kind: "video" });
      }, fail);
      return () => {
        cancelled = true;
      };
    }
    readChatImage(path, chat).then((bytes) => {
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
  }, [allowed, near, path, sessionId, attempt]);

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
