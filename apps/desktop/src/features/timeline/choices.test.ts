/**
 * Buttons made out of an agent's own sentence.
 *
 * The failure that matters is a false positive: prose split into buttons offers
 * a choice nobody made, and one press sends it. So most of this file is about
 * refusing, and the one real-world case at the top is the question that
 * prompted the feature — copied off the log, parentheses and all.
 */
import { describe, expect, it } from "vitest";

import { MAX_LABEL, parseAsk } from "./choices";

const choicesIn = (q: string) => parseAsk(q).choices;

const REAL =
  "The workspace contains only index.html, styles.css, and app.js — no " +
  "requirements/spec file. Which feature set should I audit the code against? " +
  "Options: (a) paste the original feature list/requirements here, or (b) tell " +
  "me to treat the app's own implemented behaviors as the requirements (add " +
  "book, delete book, change status, filter by status, summary counts, " +
  "localStorage persistence with fallback), or (c) there is a spec elsewhere " +
  "I should look at. Note: I can fully verify the localStorage corruption/" +
  "older-version handling regardless of your answer.";

describe("a real question off the log", () => {
  const found = choicesIn(REAL);

  it("finds all three", () => {
    expect(found.map((c) => c.marker)).toEqual(["a", "b", "c"]);
  });

  it("keeps the parentheses inside an option", () => {
    // (b) contains its own bracketed list. A parser that treated any "(x)" as
    // a marker would cut this in half.
    expect(found[1]!.text).toContain("(add book, delete book");
  });

  it("trims the connector the list leaves behind", () => {
    // "…here, or" is grammar joining the options, not part of one.
    expect(found[0]!.text).toBe(
      "paste the original feature list/requirements here",
    );
  });

  it("stops the last option at the end of its sentence", () => {
    // The closing remark is the agent talking to you, not a fourth option, and
    // it must not end up inside the answer.
    expect(found[2]!.text).toBe("there is a spec elsewhere I should look at");
    expect(found[2]!.text).not.toContain("Note:");
  });
});

describe("the list is lifted out of the question", () => {
  it("removes the options and the word introducing them", () => {
    // Leaving them above the buttons says everything twice, and the copy you
    // read first is the one that is not clickable.
    const { text } = parseAsk(REAL);
    expect(text).not.toContain("(a)");
    expect(text).not.toContain("paste the original feature list");
    expect(text).not.toContain("Options:");
  });

  it("keeps the question itself", () => {
    expect(parseAsk(REAL).text).toContain(
      "Which feature set should I audit the code against?",
    );
  });

  it("keeps what was said after the list", () => {
    // A closing remark is not an option, and it is nowhere else on screen.
    expect(parseAsk(REAL).text).toContain("Note: I can fully verify");
  });

  it("leaves the question untouched when there is nothing to lift", () => {
    const plain = "Which folder should I look in?";
    expect(parseAsk(plain).text).toBe(plain);
  });
});

describe("what it refuses", () => {
  it("refuses a lone marker in ordinary prose", () => {
    expect(choicesIn("I looked at the file (b) and it seems fine.")).toEqual(
      [],
    );
  });

  it("refuses markers that do not run in order", () => {
    // A list that skips one was probably never a list.
    expect(choicesIn("Try (a) this or (c) that.")).toEqual([]);
  });

  it("refuses a single option", () => {
    // One option is not a choice.
    expect(choicesIn("Shall I (a) carry on?")).toEqual([]);
  });

  it("refuses the whole list when one option is a paragraph", () => {
    // Truncating would put the agent's words on a button with the end cut off,
    // and pressing it would send something it never offered.
    const long = "x".repeat(MAX_LABEL + 1);
    expect(choicesIn(`(a) fine, or (b) ${long}`)).toEqual([]);
  });

  it("refuses a question with no list at all", () => {
    expect(choicesIn("Which folder should I look in?")).toEqual([]);
  });

  it("refuses an empty option", () => {
    expect(choicesIn("(a) (b) ")).toEqual([]);
  });
});

describe("other shapes agents write", () => {
  it("reads a numbered list", () => {
    expect(
      choicesIn("Pick one. 1. keep going 2. stop here").map((c) => c.text),
    ).toEqual(["keep going", "stop here"]);
  });

  it("reads bare letters with a closing bracket", () => {
    expect(choicesIn("a) rebuild it b) leave it").map((c) => c.text)).toEqual([
      "rebuild it",
      "leave it",
    ]);
  });

  it("reads options on their own lines", () => {
    const q =
      "How should I proceed?\n(a) overwrite the file\n(b) write a new one";
    expect(choicesIn(q).map((c) => c.text)).toEqual([
      "overwrite the file",
      "write a new one",
    ]);
  });

  it("prefers letters when a question has both", () => {
    // "1." here is a step in the option's own text, not a competing list.
    const q = "(a) run step 1. first, or (b) skip it";
    expect(choicesIn(q).map((c) => c.marker)).toEqual(["a", "b"]);
  });
});
