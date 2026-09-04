/**
 * The stylesheet's load-bearing rules, asserted rather than assumed.
 *
 * These are not style opinions. Each one here has been deleted once by an edit
 * that was aimed at something else, and each time the symptom was somewhere
 * far away from the cause:
 *
 * `html, body, #root { height: 100% }` went missing while three theme blocks
 * were being rewritten. Without it `body` grows to fit its content, so every
 * panel that scrolls internally instead runs off the bottom of the window and
 * **no scrollbar appears anywhere in the app**. It was reported as "where did
 * the scrollbar go", which is four steps from a missing height.
 *
 * A stylesheet is the one place in this codebase with no types and no compiler,
 * so the only thing standing between a careless edit and a broken window is a
 * test that reads the file.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "index.css"), "utf8");

/** Every token the two themes must both declare, so one cannot gain a colour
 *  the other has never heard of. */
function block(after: string): Set<string> {
  const from = css.indexOf(after);
  expect(from, `missing block: ${after}`).toBeGreaterThan(-1);
  const end = css.indexOf("\n}", from);
  return new Set(
    [...css.slice(from, end).matchAll(/--[\w-]+(?=\s*:)/g)].map((m) => m[0]),
  );
}

describe("the shell's frame", () => {
  it("gives html, body and #root a height", () => {
    // Without this nothing in the app scrolls.
    expect(css).toMatch(
      /html,\s*\n\s*body,\s*\n\s*#root\s*\{[^}]*height:\s*100%/,
    );
  });

  it("keeps the document itself from scrolling", () => {
    expect(css).toMatch(
      /html,\s*\n\s*body,\s*\n\s*#root\s*\{[^}]*overflow:\s*hidden/,
    );
  });
});

describe("the two themes", () => {
  const light = block(':root[data-theme="light"] {');
  const system = block(':root:not([data-theme="dark"]) {');
  const dark = block("@theme {");

  it("declare the same tokens in the explicit block and the media query", () => {
    // The one people forget: two light themes that do not match, only one of
    // which is ever looked at.
    expect([...system].sort()).toEqual([...light].sort());
  });

  it("cover every colour the dark theme defines", () => {
    // A token the dark theme has and the light one does not is a colour that
    // silently keeps its dark value on a light ground.
    const missing = [...dark]
      .filter(
        (name) =>
          name.startsWith("--color-") ||
          name.startsWith("--room-") ||
          name.startsWith("--coat-"),
      )
      .filter((name) => !light.has(name));
    // The aliases are deliberately declared once and resolve through the token
    // they point at, so they are the only permitted gap.
    expect(missing).toEqual([
      "--color-search",
      "--color-write",
      "--color-wait",
    ]);
  });
});

describe("the bright pair is for marks, not text", () => {
  // `--color-accent-bright` and `--color-attn-bright` are the vivid versions,
  // for things that have a shape: a progress fill, a status dot, an icon, the
  // underline under the chosen tab. On white they measure 2.9:1 and 1.8:1 —
  // the first fails AA for text and the second is close to unreadable.
  //
  // A comment beside the declaration asks people to remember. This does not
  // ask.
  const sources = readdirSync(join(__dirname), {
    recursive: true,
    encoding: "utf8",
  })
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
    .map((f) => [f, readFileSync(join(__dirname, f), "utf8")] as const);

  it("is never used as a text colour", () => {
    const offenders = sources
      .filter(([, body]) => /\btext-(accent|attn)-bright\b/.test(body))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("is never used as a border colour either", () => {
    // Same reasoning one step out: a 1.8:1 hairline against the page is a
    // border that is there in the markup and not on the screen.
    const offenders = sources
      .filter(([, body]) => /\bborder-(accent|attn)-bright\b/.test(body))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});

/**
 * The violet means one thing.
 *
 * `--color-ai-*` says "a model wrote this and you have not checked it".
 * `--color-attn` says "it is your turn". Both only work because they are
 * spent nowhere else — a colour used for decoration stops meaning anything,
 * and then the one time it matters nobody reads it.
 *
 * The rules below are the ones that a future edit could quietly undo without
 * anything looking wrong on the day it happens.
 */
describe("the AI treatment", () => {
  it("declares its tokens in every theme", () => {
    // Same guarantee the rest of the palette has: one theme cannot gain a
    // colour the other has never heard of.
    for (const token of [
      "--color-ai-a",
      "--color-ai-b",
      "--color-ai-ink",
      "--color-ai-wash",
      "--color-ai-glow",
    ]) {
      expect(
        css.split(`${token}:`).length - 1,
        `${token} must be declared in all three theme blocks`,
      ).toBe(3);
    }
  });

  it("only turns while something is running", () => {
    // An effect that runs all day is one nobody sees on the day it means
    // something. The spin belongs to `working` and to nothing else.
    const spins = [...css.matchAll(/animation:\s*ai-spin[^;]*;/g)];
    expect(spins).toHaveLength(1);
    const before = css.slice(0, css.indexOf("animation: ai-spin"));
    expect(before).toMatch(/\.ai-panel\[data-state="working"\]::before\s*\{\s*$/m);
  });

  it("keeps the state when the motion is refused", () => {
    // Someone who has asked for less movement still has to be able to see
    // that something is running. The opacity is set outside the motion query;
    // only the rotation is inside it.
    const opacity = css.indexOf(
      '.ai-panel[data-state="working"]::before {\n  opacity: 1;\n}',
    );
    expect(opacity, "the working state must set its own opacity").toBeGreaterThan(-1);
    // At the top level: every `@media` opened before this point has closed
    // again, so no motion preference can take the intensity away.
    const opened = css.slice(0, opacity).split("@media").length - 1;
    const closed = css.slice(0, opacity).split("\n}\n").length - 1;
    expect(closed, "the opacity rule sits inside a media query").toBeGreaterThanOrEqual(
      opened,
    );
  });

  it("guards its animations rather than leaning on the blanket rule", () => {
    // The global reduced-motion rule sets `animation-duration: 0.01ms`. On an
    // infinite rotation that is not "stopped", it is a strobe — so every
    // animation here is declared inside a `no-preference` query instead, the
    // same way `fish-bite-*` is.
    for (const name of ["ai-spin", "ai-land", "ai-slide"]) {
      const use = css.indexOf(`animation: ${name}`);
      expect(use, `${name} is never used`).toBeGreaterThan(-1);
      const guard = css.lastIndexOf(
        "@media (prefers-reduced-motion: no-preference)",
        use,
      );
      expect(guard, `${name} runs outside a no-preference guard`).toBeGreaterThan(-1);
      // …and the guard must not have closed before the animation is declared.
      expect(css.slice(guard, use)).not.toMatch(/\n\}\n\n/);
    }
  });
});

/**
 * The violet is not used anywhere else.
 *
 * This is the rule that decides whether the whole thing keeps working, and it
 * is the easiest one to break by accident: `text-ai-ink` on a heading looks
 * harmless and costs the app the one signal it had for "a model wrote this".
 */
describe("where the AI colour may appear", () => {
  const allowed = new Set([
    "components/ui/AiPanel.tsx",
    "index.css",
    "themeTokens.test.ts",
  ]);

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.(ts|tsx|css)$/.test(entry.name) ? [full] : [];
    });
  }

  it("appears only in the panel that owns it", () => {
    const offenders = walk(__dirname)
      .filter((file) => /-ai-(a|b|ink|wash|glow)\b/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(__dirname.length + 1).split("\\").join("/"))
      .filter((rel) => !allowed.has(rel));

    // If this fails, the question to ask is not "how do I allow this file" but
    // "does that thing really mean *a model wrote this and nobody has checked
    // it*". If it does not, it needs a different colour.
    expect(offenders).toEqual([]);
  });
});

/**
 * The gradient border does not become a scroll container.
 *
 * `overflow: hidden` clips *and* makes the box scrollable, and the rotating
 * `::before` hangs 45% above the top — so the browser scrolling to a focused
 * control slid the opaque inner box up and left the gradient showing as a
 * solid block below the panel. Measured on the broken version:
 * `scrollTop: 151, scrollHeight: 575, clientHeight: 397`.
 */
describe("the gradient border's clipping", () => {
  it("clips without becoming scrollable", () => {
    const from = css.indexOf("@utility ai-panel {");
    expect(from).toBeGreaterThan(-1);
    // Comments stripped first: the rule's own explanation names the thing it
    // is warning against, and matching prose is not reading the CSS.
    const body = css
      .slice(from, css.indexOf("\n}", from))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(body).toMatch(/overflow:\s*clip/);
    expect(body, "overflow: hidden makes it scrollable again").not.toMatch(
      /overflow:\s*hidden/,
    );
  });
});

/**
 * The throbber stops turning when asked, and still says something.
 *
 * Same trap as the AI panel's spin: the blanket reduced-motion rule sets
 * `animation-duration: 0.01ms`, and on an infinite rotation that is a strobe,
 * not a stop.
 */
describe("the throbber", () => {
  it("spins only inside a no-preference guard", () => {
    const use = css.indexOf("animation: throb");
    expect(use, "the throbber never spins").toBeGreaterThan(-1);
    const guard = css.lastIndexOf(
      "@media (prefers-reduced-motion: no-preference)",
      use,
    );
    expect(guard).toBeGreaterThan(-1);
    expect(css.slice(guard, use)).not.toMatch(/\n\}\n\n/);
  });

  it("ticks in as many steps as it has bars", () => {
    // A smooth rotation of twelve discrete bars beats against its own geometry
    // and reads as a wobble.
    expect(css).toMatch(/animation:\s*throb\s+[\d.]+m?s\s+steps\(12,\s*end\)/);
  });
});
