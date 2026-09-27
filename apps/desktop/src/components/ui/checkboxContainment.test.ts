/**
 * The visually-hidden input must not escape the row it belongs to.
 *
 * `sr-only` is `position: absolute`. Without a positioned ancestor the input
 * is placed against the *initial containing block*, so a column of them in a
 * tall scrolling panel stretches the document itself — and the browser will
 * then scroll the document to whichever one takes focus. That is what turned
 * the agent editor into a blank window when a tool was ticked.
 *
 * Asserted on the source rather than in a DOM, because the fix is one class
 * on one element and a rendered test would need jsdom to implement CSS
 * containing blocks, which it does not.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("./Checkbox.tsx", import.meta.url), "utf8");

describe("Checkbox", () => {
  it("still hides the input rather than removing it", () => {
    // The accessibility promise this component is built on: a real input,
    // visually hidden. If this ever becomes `hidden` or `display:none` the
    // containment below stops mattering and the control stops being one.
    expect(src).toMatch(/className="peer sr-only"/);
  });

  it("gives the row a containing block, so the hidden input cannot reach past it", () => {
    const label = src.slice(src.indexOf("<label"), src.indexOf("<input"));
    const decls = label.replace(/\/\/[^\n]*/g, "");
    expect(
      decls,
      "sr-only is position:absolute — without this the input is placed against the document",
    ).toMatch(/"relative"/);
  });
});
