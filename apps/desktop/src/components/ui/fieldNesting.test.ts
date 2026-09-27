/**
 * `Field` renders a `<label>`, so it may never wrap another control's label.
 *
 * `ToolPicker` put thirteen `Checkbox` rows — each its own `<label htmlFor>` —
 * inside one `Field`. HTML forbids that, and React builds the tree through the
 * DOM API, so the parser never auto-closes it the way it would in hand-written
 * markup: the invalid nesting really existed. Measured live, `label label`
 * matched 13 elements.
 *
 * It was not cosmetic. A `<label>` with no `htmlFor` activates its first
 * labelable descendant, so **clicking the word "Tools" toggled `read_file`** —
 * a group heading that silently granted a tool. Measured, and put back:
 *
 *     before  0000000000000
 *     after   1000000000000   indexesToggled: [0]
 *
 * `FieldGroup` is the same markup with `role="group"` and `aria-labelledby`,
 * which is also what a screen reader needed: with no `htmlFor` the word
 * "Tools" was folded into the first checkbox's accessible name.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const SRC = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

describe("Field", () => {
  it("is never given a control that brings its own label", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      let at = src.indexOf("<Field");
      while (at !== -1) {
        const end = src.indexOf("</Field>", at);
        if (end === -1) break;
        const block = src.slice(at, end);
        // A nested <Field> or a <Checkbox> both render their own <label>.
        if (/<Checkbox\b/.test(block) || /<Field\b[\s\S]*<Field\b/.test(block)) {
          offenders.push(
            `${file.slice(SRC.length)}:${src.slice(0, at).split("\n").length}`,
          );
        }
        at = src.indexOf("<Field", at + 1);
      }
    }
    expect(
      offenders,
      "Field renders a <label>; use FieldGroup for a set of controls",
    ).toEqual([]);
  });

  it("FieldGroup names the set instead of the first control in it", () => {
    const src = readFileSync(join(SRC, "components/ui/primitives.tsx"), "utf8");
    const from = src.indexOf("export function FieldGroup");
    expect(from, "FieldGroup is gone").toBeGreaterThan(-1);
    // To the next top-level declaration, not the first "\n}" — that one ends
    // the destructured props type, so slicing there reads a signature and not
    // a body. The first version of this test did exactly that and failed
    // against correct code.
    const next = src.indexOf("\nexport function", from + 1);
    const body = src.slice(from, next === -1 ? src.length : next);
    expect(body).toMatch(/role="group"/);
    expect(body).toMatch(/aria-labelledby=\{id\}/);
    expect(body, "a group heading must not be a <label>").not.toMatch(/<label/);
  });
});
