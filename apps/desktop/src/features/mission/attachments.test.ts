import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  kindOf,
  mimeFor,
  toBase64,
  vet,
} from "./attachments";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("what kind of thing was dropped", () => {
  it("calls the four image types images and everything else text", () => {
    expect(kindOf("image/png")).toBe("image");
    expect(kindOf("image/webp")).toBe("image");
    expect(kindOf("text/csv")).toBe("text");
    // The label a browser puts on a .csv about half the time.
    expect(kindOf("application/vnd.ms-excel")).toBe("text");
  });

  it("names a file the browser would not name", () => {
    // `.md`, `.log`, `.env` all arrive with an empty type, and the API needs a
    // non-empty string. Honest because the bytes are decoded afterwards.
    expect(mimeFor({ name: "NOTES.md", type: "" })).toBe("text/plain");
    expect(mimeFor({ name: "a.png", type: "image/png" })).toBe("image/png");
  });
});

describe("vetting a file before it is uploaded", () => {
  it("accepts text and reports its kind", () => {
    const result = vet("data.csv", "text/csv", utf8("a,b\n1,2\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.staged.kind).toBe("text");
    expect(result.staged.bytes).toBe(8);
  });

  it("accepts an image without trying to decode it", () => {
    // Bytes that are deliberately not valid UTF-8. An image must not be put
    // through the text check — every PNG would fail it.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0xfd]);
    const result = vet("a.png", "image/png", png);
    expect(result.ok).toBe(true);
  });

  it("refuses a binary that is not an image", () => {
    // A PDF, a zip, a renamed .exe: cannot go to either endpoint as itself,
    // and accepting it silently would be the UI claiming it was sent.
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe]);
    const result = vet("report.pdf", "application/pdf", pdf);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-readable");
  });

  it("keeps the two size limits apart, because they exist for different reasons", () => {
    const bigImage = vet("big.png", "image/png", new Uint8Array(MAX_IMAGE_BYTES + 1));
    expect(bigImage.ok).toBe(false);
    if (!bigImage.ok) expect(bigImage.reason).toBe("too-big-image");

    // Well under the image cap, and still too big for a prompt.
    const bigText = vet("big.csv", "text/csv", utf8("x".repeat(MAX_TEXT_BYTES + 1)));
    expect(bigText.ok).toBe(false);
    if (!bigText.ok) expect(bigText.reason).toBe("too-big-text");
  });

  it("survives text that is not ASCII", () => {
    // The regression that a naive byte-by-byte check would cause: Thai, an
    // em dash and an emoji are all perfectly good UTF-8.
    const result = vet("th.md", "text/markdown", utf8("สวัสดี — ok 🎉"));
    expect(result.ok).toBe(true);
  });
});

describe("encoding", () => {
  it("round-trips through base64", () => {
    expect(atob(toBase64(utf8("hello")))).toBe("hello");
  });

  it("handles a payload past the chunk size without throwing", () => {
    // `String.fromCharCode(...bytes)` on this many arguments blows the call
    // stack, which used to surface as "the file is broken".
    const big = new Uint8Array(0x8000 * 3 + 17).fill(65);
    expect(atob(toBase64(big)).length).toBe(big.length);
  });
});
