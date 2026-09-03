/**
 * Just enough Markdown for what agents actually write (§1, §16.6).
 *
 * Deliberately not a Markdown library, and deliberately not `innerHTML`.
 *
 * Everything rendered here is text a *model* produced, and some of it is text a
 * model copied out of a web page it fetched. A general renderer's job is to
 * turn arbitrary input into arbitrary markup — which is the exact capability
 * this app must not hand to that source. So this parses into a small closed set
 * of nodes, the renderer maps each to a fixed React element, and no path
 * anywhere produces raw HTML. Whatever a page tries to smuggle in arrives as
 * characters and leaves as characters.
 *
 * The subset is what agents in this app write in practice: headings, bold,
 * italic, inline code, fenced code, bullet and numbered lists, and paragraphs.
 * Anything else stays literal — a stray `<div>` or `|table|` is shown as typed
 * rather than half-interpreted, which is the honest failure for a renderer that
 * does not claim to be complete.
 *
 * Links are not linkified on purpose. A URL from a model — especially one it
 * read on a page — is not something to make one click away, and §16.6 already
 * treats fetched text as data. The address is shown, and the reader decides.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string };

export type Block =
  | { kind: "p"; spans: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3; spans: Inline[] }
  | { kind: "code"; text: string; lang: string | null }
  | { kind: "list"; ordered: boolean; items: Inline[][] };

/** Inline code first, so `**` inside backticks stays literal. */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)/;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;

  while (rest.length > 0) {
    const at = rest.search(INLINE);
    if (at === -1) {
      out.push({ kind: "text", text: rest });
      break;
    }
    if (at > 0) out.push({ kind: "text", text: rest.slice(0, at) });

    const match = INLINE.exec(rest.slice(at));
    const token = match?.[0] ?? "";
    if (token.startsWith("`")) {
      out.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      out.push({ kind: "bold", text: token.slice(2, -2) });
    } else {
      out.push({ kind: "italic", text: token.slice(1, -1) });
    }
    rest = rest.slice(at + token.length);
  }

  return out.filter((span) => span.kind !== "text" || span.text.length > 0);
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const FENCE = /^\s*```(\w*)\s*$/;

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];

  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "p", spans: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i += 1;
      // An unclosed fence runs to the end rather than swallowing the reply into
      // nothing — a model that forgets the closing ``` is common, and losing
      // the rest of what it said would be the worse failure.
      while (i < lines.length && !FENCE.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({ kind: "code", text: body.join("\n"), lang: fence[1] || null });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: Math.min(3, heading[1]!.length) as 1 | 2 | 3,
        spans: parseInline(heading[2]!),
      });
      i += 1;
      continue;
    }

    const ordered = NUMBERED.test(line);
    if (ordered || BULLET.test(line)) {
      flushParagraph();
      const items: Inline[][] = [];
      const pattern = ordered ? NUMBERED : BULLET;
      while (i < lines.length && pattern.test(lines[i]!)) {
        items.push(parseInline(pattern.exec(lines[i]!)![1]!));
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return blocks;
}
