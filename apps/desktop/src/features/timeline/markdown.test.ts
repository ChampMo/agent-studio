import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "./markdown";

describe("inline", () => {
  it("reads bold, italic and code", () => {
    expect(parseInline("a **b** c `d` e *f*")).toEqual([
      { kind: "text", text: "a " },
      { kind: "bold", text: "b" },
      { kind: "text", text: " c " },
      { kind: "code", text: "d" },
      { kind: "text", text: " e " },
      { kind: "italic", text: "f" },
    ]);
  });

  it("leaves markup inside backticks alone", () => {
    // The reason inline code is matched first. An agent writing about the
    // syntax — "use `**bold**`" — must not have it eaten.
    expect(parseInline("use `**bold**` here")).toEqual([
      { kind: "text", text: "use " },
      { kind: "code", text: "**bold**" },
      { kind: "text", text: " here" },
    ]);
  });

  it("leaves an unmatched marker as text", () => {
    expect(parseInline("2 * 3 is 6")).toEqual([{ kind: "text", text: "2 * 3 is 6" }]);
  });
});

describe("blocks", () => {
  it("reads headings, paragraphs and both kinds of list", () => {
    const blocks = parseBlocks(
      ["## Report", "", "It works.", "", "- one", "- two", "", "1. first", "2. second"].join(
        "\n",
      ),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "p", "list", "list"]);
    expect(blocks[2]).toMatchObject({ kind: "list", ordered: false });
    expect(blocks[3]).toMatchObject({ kind: "list", ordered: true });
  });

  it("keeps a fenced block verbatim, markup and all", () => {
    const blocks = parseBlocks(["```js", "const a = **1**;", "```"].join("\n"));
    expect(blocks).toEqual([
      { kind: "code", text: "const a = **1**;", lang: "js" },
    ]);
  });

  it("runs an unclosed fence to the end rather than losing the reply", () => {
    // Models forget the closing fence often. Swallowing everything after it
    // into nothing would be the worse failure of the two.
    const blocks = parseBlocks(["text", "```", "still here"].join("\n"));
    expect(blocks.at(-1)).toEqual({ kind: "code", text: "still here", lang: null });
  });

  it("joins wrapped lines into one paragraph", () => {
    const blocks = parseBlocks("one\ntwo\n\nthree");
    expect(blocks).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "one two" }] },
      { kind: "p", spans: [{ kind: "text", text: "three" }] },
    ]);
  });

  it("leaves anything it does not claim to handle as literal text", () => {
    // The honest failure for a renderer that is deliberately partial: show a
    // table or a tag as typed rather than half-interpreting it.
    const blocks = parseBlocks("| a | b |\n<div>hi</div>");
    expect(blocks).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "| a | b | <div>hi</div>" }] },
    ]);
  });

  it("produces no node type a renderer could turn into markup", () => {
    // The guard that matters: every block is one of a closed set, so nothing
    // downstream ever needs `innerHTML` and a fetched page cannot smuggle
    // anything through (§16.6).
    const kinds = new Set(
      parseBlocks("# h\n\ntext `c` **b**\n\n- x\n\n```\ncode\n```").map((b) => b.kind),
    );
    for (const kind of kinds) {
      expect(["p", "heading", "code", "list"]).toContain(kind);
    }
  });
});
