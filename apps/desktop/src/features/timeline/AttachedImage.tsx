/**
 * An attached image, shown in the transcript (§12 M9.3).
 *
 * Fetched by id rather than embedded: the log carries the name, the size and a
 * digest, never the picture, because `mission_events` is append-only forever
 * and a few screenshots inlined as base64 would make it unbounded (§9.3).
 *
 * And fetched rather than pointed at with a plain `<img src>`, because the
 * session token is a header. Putting it in a URL would leak it into anything
 * that logs one (§9.1), so the bytes come back through the same authenticated
 * request as everything else and are wrapped in a blob.
 *
 * The object URL is revoked on unmount. One that is never released holds the
 * image in memory for the life of the page, and a long transcript has many.
 */
import { useEffect, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { api } from "../../transport/rest";

export function AttachedImage({ id, alt }: { id: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    void api
      .readAttachmentUrl(id)
      .then((next) => {
        objectUrl = next;
        if (cancelled) {
          URL.revokeObjectURL(next);
          return;
        }
        setUrl(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  // 410 from the backend: the row is there and the bytes are not. Said plainly
  // rather than left as a broken image icon.
  if (failed) {
    return <span className="text-[11px] text-stop">{strings.timeline.imageGone}</span>;
  }
  if (!url) return null;

  return (
    <img
      src={url}
      alt={alt}
      className="mt-1 max-h-48 rounded-md border border-line object-contain"
    />
  );
}
