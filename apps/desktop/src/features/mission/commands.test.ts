/**
 * One box, two meanings, and the rule that keeps them apart.
 *
 * The load-bearing assertion in this file is the negative one: a line that
 * starts with `/` and is not a command this build knows is a **message**, not
 * an error. `/usr/local/bin is missing` has to reach the team. A composer that
 * answered it with "unknown command" would be refusing to pass on something
 * the person plainly meant to say — and the cost of getting this wrong is
 * silent, because they would simply think the app was broken.
 */
import { describe, expect, it } from "vitest";

import {
  COMMANDS,
  available,
  matches,
  menuFilter,
  nameFilter,
  parse,
  whoMatches,
} from "./commands";

const ALL = COMMANDS;

describe("what a typed line means", () => {
  it("is a message, normally", () => {
    expect(parse("fix the spacing on the hero")).toEqual({
      kind: "message",
      text: "fix the spacing on the hero",
      to: null,
    });
  });

  it("recognises a command this build knows", () => {
    expect(parse("/plan rewrite the About page", ALL)).toEqual({
      kind: "command",
      id: "plan",
      rest: "rewrite the About page",
    });
  });

  it("takes a command with nothing after it", () => {
    expect(parse("/rewind", ALL)).toEqual({
      kind: "command",
      id: "rewind",
      rest: "",
    });
  });

  // ---- the rule that matters ----

  it("sends a path that looks like a command", () => {
    const out = parse("/usr/local/bin is missing", ALL);
    expect(out.kind).toBe("message");
    expect(out).toMatchObject({ text: "/usr/local/bin is missing" });
  });

  it("sends an unknown slash word rather than refusing it", () => {
    expect(parse("/deploy now", ALL)).toMatchObject({
      kind: "message",
      text: "/deploy now",
    });
  });

  it("sends a command that is not usable right now", () => {
    // `/rewind` before a run exists is a person typing a word. Refusing to
    // send it teaches nothing and loses what they wrote.
    const usable = available({ hasMission: false, running: false });
    expect(parse("/rewind", usable)).toMatchObject({ kind: "message" });
  });
});

describe("addressing one teammate", () => {
  it("pulls the name off the front", () => {
    expect(parse("@Wren check that file again")).toEqual({
      kind: "message",
      text: "check that file again",
      to: "Wren",
    });
  });

  it("leaves an @ that is not a name alone", () => {
    // No text after it, so nothing was addressed to anybody.
    expect(parse("@everyone")).toEqual({
      kind: "message",
      text: "@everyone",
      to: null,
    });
  });

  it("does not decide whether the name exists", () => {
    // `Mailbox.resolve` is the one answer to that (§2.1). A second check here
    // would disagree with it the day a team is renamed.
    expect(parse("@Nobody hello")).toMatchObject({ to: "Nobody" });
  });
});

describe("which commands are offered", () => {
  it("hides fork and rewind before a run exists", () => {
    expect(
      available({ hasMission: false, running: false }).map((c) => c.id),
    ).toEqual(["plan"]);
  });

  it("hides rewind while the team is using the files", () => {
    const ids = available({ hasMission: true, running: true }).map((c) => c.id);
    expect(ids).toContain("fork");
    expect(ids).not.toContain("rewind");
  });

  it("offers everything on a stopped run", () => {
    expect(
      available({ hasMission: true, running: false }).map((c) => c.id),
    ).toEqual(["plan", "fork", "rewind"]);
  });
});

describe("the menu", () => {
  it("opens on a bare slash and filters as you type", () => {
    expect(menuFilter("/")).toBe("");
    expect(menuFilter("/re")).toBe("re");
    expect(matches("re", ALL).map((c) => c.id)).toEqual(["rewind"]);
  });

  it("closes once the name is settled", () => {
    // A space means the argument is being typed and the list is in the way.
    expect(menuFilter("/plan ")).toBeNull();
    expect(menuFilter("hello")).toBeNull();
  });

  it("finds a command by what it does, not only by its name", () => {
    expect(matches("files", ALL).map((c) => c.id)).toContain("rewind");
  });
});

describe("the @ list", () => {
  const TEAM = [
    "Project Manager (PM)",
    "Developer (Dev)",
    "Tester (QA Engineer)",
  ];

  it("opens on a bare @ and offers everyone", () => {
    expect(nameFilter("@")).toBe("");
    expect(whoMatches("", TEAM)).toEqual(TEAM);
  });

  it("narrows by the start of a name before anywhere in it", () => {
    // "Dev" starts Developer and appears nowhere else; "QA" appears only
    // inside Tester's name, so the fallback is what finds it.
    expect(whoMatches("dev", TEAM)).toEqual(["Developer (Dev)"]);
    expect(whoMatches("qa", TEAM)).toEqual(["Tester (QA Engineer)"]);
  });

  it("closes once a name has been chosen", () => {
    // The space is what ends the name, so the list stops covering the message.
    expect(nameFilter("@Developer (Dev) ")).toBeNull();
    expect(nameFilter("hello")).toBeNull();
  });

  it("offers nothing rather than everyone when the name fits nobody", () => {
    expect(whoMatches("zzz", TEAM)).toEqual([]);
  });
});

describe("a name with a space in it", () => {
  // The roster on this machine really reads like this, and the picker inserts
  // the whole thing.
  const TEAM = [
    "Project Manager (PM)",
    "Developer (Dev)",
    "Tester (QA Engineer)",
  ];

  it("keeps the whole name out of the message", () => {
    // The bug this test exists for: stopping at the first space took
    // "Developer" as the recipient and left "(Dev)" at the front of what the
    // agent would read. Found by picking a name from the list and looking at
    // the result, not by testing the bare-word form.
    expect(
      parse("@Developer (Dev) check the line lengths", COMMANDS, TEAM),
    ).toEqual({
      kind: "message",
      text: "check the line lengths",
      to: "Developer (Dev)",
    });
  });

  it("prefers the longer name when one is a prefix of another", () => {
    const overlapping = ["Dev", "Developer (Dev)"];
    expect(
      parse("@Developer (Dev) hello", COMMANDS, overlapping),
    ).toMatchObject({
      to: "Developer (Dev)",
    });
  });

  it("still takes a hand-typed short name", () => {
    // `Mailbox.resolve` is what turns this into a person; the client only has
    // to pass on what was typed.
    expect(parse("@Dev hurry up", COMMANDS, TEAM)).toMatchObject({
      to: "Dev",
      text: "hurry up",
    });
  });

  it("is a plain message when the name is all there is", () => {
    // Nothing was said to them, so nothing is addressed anywhere.
    expect(parse("@Developer (Dev)", COMMANDS, TEAM)).toMatchObject({
      to: null,
      text: "@Developer (Dev)",
    });
  });
});
