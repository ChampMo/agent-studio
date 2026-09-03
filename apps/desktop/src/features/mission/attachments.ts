/**
 * Deciding what a dropped file is, before it is uploaded (§12 M9.3).
 *
 * Two kinds go to a model, by two different routes, because there is no single
 * route that works. An **image** travels as a picture, which only a vision
 * model can read. A **text file** has its contents put into the round's
 * instruction, which is the only way a text model reads anything at all.
 *
 * Nothing else is accepted. A PDF, a zip or a spreadsheet cannot be sent to
 * either endpoint as itself, and taking one in to be silently ignored would be
 * the UI saying "attached" about something that never arrived (§1).
 *
 * These rules mirror `attachments/store.py` deliberately, and the point of
 * mirroring them is the *timing*: the backend is still the authority and still
 * refuses, but a file rejected here says so the moment it is dropped rather
 * than after an upload round trip.
 *
 * What decides the kind is the bytes, not the label. Browsers report a `.csv`
 * as `application/vnd.ms-excel` about as often as `text/csv`, hand back an
 * empty string for `.md`, and label a renamed binary by its extension. So a
 * text file is *decoded* to prove it is text.
 */

/** What both APIs accept as a picture. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Both APIs reject larger, and base64 adds a third on top. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** A different number for a different reason: this one goes into the prompt.
 *  A megabyte of CSV would eat the context and then the budget. */
export const MAX_TEXT_BYTES = 256 * 1024;

export type StagedKind = "image" | "text";

export interface Staged {
  name: string;
  mime: string;
  kind: StagedKind;
  /** Base64 without the data-URI prefix, which is what the API takes. */
  data: string;
  bytes: number;
}

export function kindOf(mime: string): StagedKind {
  return IMAGE_TYPES.includes(mime) ? "image" : "text";
}

/**
 * The type to send for a file the browser would not name.
 *
 * `File.type` is empty for plenty of ordinary text — `.md`, `.log`, `.env`,
 * anything without a registered type — and the API needs a non-empty string.
 * Calling an unlabelled file `text/plain` is honest here precisely because the
 * bytes are decoded before it is accepted: if it is not text, it is refused on
 * that basis, not on the strength of this guess.
 */
export function mimeFor(file: { name: string; type: string }): string {
  if (file.type) return file.type;
  return "text/plain";
}

const CHUNK = 0x8000;

/** Base64, chunked — `String.fromCharCode(...bytes)` on a whole megabyte blows
 *  the argument limit and throws, which reads as "the file is broken". */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export type Vetted =
  | { ok: true; staged: Staged }
  | { ok: false; reason: "too-big-image" | "too-big-text" | "not-readable"; limit?: number };

/**
 * Whether this file can be attached, and as what.
 *
 * Pure and byte-level so it can be tested without a `File`, and so the rule
 * that decides is the same one whether a file arrived by picker or by drop.
 */
export function vet(name: string, mime: string, bytes: Uint8Array): Vetted {
  const kind = kindOf(mime);

  if (kind === "image") {
    if (bytes.length > MAX_IMAGE_BYTES) {
      return { ok: false, reason: "too-big-image", limit: MAX_IMAGE_BYTES };
    }
  } else {
    if (bytes.length > MAX_TEXT_BYTES) {
      return { ok: false, reason: "too-big-text", limit: MAX_TEXT_BYTES };
    }
    try {
      // `fatal` is the whole check: it throws on any byte sequence that is not
      // valid UTF-8, which is what separates a text file from everything else.
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, reason: "not-readable" };
    }
  }

  return {
    ok: true,
    staged: { name, mime, kind, data: toBase64(bytes), bytes: bytes.length },
  };
}
