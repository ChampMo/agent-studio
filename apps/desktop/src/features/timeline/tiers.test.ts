/**
 * The fold has to be safe before it is useful.
 *
 * A timeline that hides things quietly is no longer something you can check a
 * run against, which is the whole reason the transcript is one-row-per-event.
 * So the property that matters is not "fewer rows" — it is that expanding
 * every group gives back exactly what went in, in the same order.
 */
import { describe, expect, it } from "vitest";

import { FOLD_WINDOW_MS, addressedToUser, groupRows, isGroup, tierOf, ungroup, windowed } from "./tiers";
import type { Row } from "./transcript";

let n = 0;
const at = (ms: number) => new Date(Date.parse("2026-09-03T10:00:00Z") + ms).toISOString();

function did(agentId: string, ms = 0, tone: Row extends { tone: infer T } ? T : never = "idle" as never): Row {
  n += 1;
  return {
    id: `d${n}`, seq: n, ts: at(ms), kind: "did",
    agentId, name: agentId.toUpperCase(), text: "calls grep", tone,
  } as Row;
}

function said(agentId: string, ms = 0): Row {
  n += 1;
  return {
    id: `s${n}`, seq: n, ts: at(ms), kind: "said", side: "left",
    agentId, name: agentId.toUpperCase(), text: "hello", streaming: false,
    showHeader: true, to: "the team",
  } as Row;
}

function note(ms = 0): Row {
  n += 1;
  return { id: `n${n}`, seq: n, ts: at(ms), kind: "note", text: "round ended", tone: "done" } as Row;
}

describe("what tier a row is", () => {
  it("puts a question that stops the run above everything", () => {
    const ask = { id: "a1", seq: 1, ts: at(0), kind: "ask", requestId: "r", question: "?", ask: "approval", options: null, name: "PM", agentId: "pm" } as Row;
    expect(tierOf(ask)).toBe("blocking");
  });

  it("treats words as dialogue and tool calls as activity", () => {
    expect(tierOf(said("dev"))).toBe("dialogue");
    expect(tierOf(did("dev"))).toBe("activity");
  });

  it("treats a failed tool call as activity too", () => {
    // This reverses the rule the file was written with. A `read_file` that met
    // a binary is a failure the agent read, shrugged at and worked around —
    // and standing in red across the whole width it claimed the run was in
    // trouble when the run was fine. What genuinely stopped something is an
    // `error` event, and that still stands on its own.
    expect(tierOf(did("dev", 0, "stop" as never))).toBe("activity");
  });

  it("never folds a frame it could not read", () => {
    const broken = { id: "b1", seq: 1, ts: at(0), kind: "broken", reason: "bad json" } as unknown as Row;
    expect(tierOf(broken)).toBe("milestone");
  });
});

describe("folding background activity", () => {
  it("gives back exactly what went in", () => {
    const rows = [said("dev"), did("dev", 1000), did("dev", 2000), did("dev", 3000), note(4000)];
    const grouped = groupRows(rows);
    expect(ungroup(grouped)).toEqual(rows);
  });

  it("says how many are behind the fold", () => {
    const rows = [did("dev", 0), did("dev", 1000), did("dev", 2000)];
    const [group] = groupRows(rows);
    expect(isGroup(group!) && group.count).toBe(3);
  });

  it("does not fold a single row into a group of one", () => {
    // A chevron that costs a click and saves a line is worse than the line.
    const rows = [said("dev"), did("dev", 100), said("dev", 200)];
    expect(groupRows(rows).some(isGroup)).toBe(false);
  });

  it("never spans two agents", () => {
    const grouped = groupRows([did("dev", 0), did("dev", 100), did("qa", 200), did("qa", 300)]);
    const groups = grouped.filter(isGroup);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.agentId)).toEqual(["dev", "qa"]);
  });

  it("splits when the work stops for a while", () => {
    // Two separate pieces of work must not read as one line.
    const grouped = groupRows([
      did("dev", 0),
      did("dev", 1000),
      did("dev", FOLD_WINDOW_MS + 2000),
      did("dev", FOLD_WINDOW_MS + 3000),
    ]);
    expect(grouped.filter(isGroup)).toHaveLength(2);
  });

  it("folds a failed call with the work it was part of", () => {
    const rows = [
      did("dev", 0),
      did("dev", 100),
      did("dev", 200, "stop" as never),
      did("dev", 300),
      did("dev", 400),
    ];
    const grouped = groupRows(rows);
    expect(grouped.filter(isGroup)).toHaveLength(1);
    // Folded, not dropped: it is still there, still red, one click away.
    expect(ungroup(grouped)).toEqual(rows);
  });

  it("leaves a tool call that is still running visible", () => {
    // The spinner is the one row saying something is happening right now.
    // Behind a click it says nothing.
    const running = { ...did("dev", 100), pending: true } as Row;
    const grouped = groupRows([did("dev", 0), running, did("dev", 200)]);
    expect(grouped.filter(isGroup)).toHaveLength(0);
  });

  it("keeps dialogue and milestones out of folds entirely", () => {
    const rows = [said("dev"), note(100), said("dev", 200)];
    expect(groupRows(rows)).toEqual(rows);
  });

  it("survives a timestamp it cannot read", () => {
    const bad = { ...did("dev", 0), ts: "not a date" } as Row;
    const grouped = groupRows([bad, did("dev", 1000), did("dev", 2000)]);
    expect(ungroup(grouped)).toHaveLength(3);
  });
});

describe("only what is for me", () => {
  it("keeps a question the run stopped on", () => {
    const ask = { id: "a", seq: 1, ts: at(0), kind: "ask", requestId: "r", question: "?", ask: "approval", options: null, name: "PM", agentId: "pm" } as Row;
    expect(addressedToUser(ask)).toBe(true);
  });

  it("keeps what was said to you, and drops what was said to the team", () => {
    const toUser = { ...said("dev"), to: "you" } as Row;
    const toTeam = { ...said("dev"), to: "the team" } as Row;
    expect(addressedToUser(toUser)).toBe(true);
    expect(addressedToUser(toTeam)).toBe(false);
  });

  it("keeps your own messages", () => {
    const mine = { ...said("dev"), side: "right" } as Row;
    expect(addressedToUser(mine)).toBe(true);
  });

  it("drops the machine working", () => {
    expect(addressedToUser(did("dev"))).toBe(false);
  });

  it("keeps the frame the rest hangs on", () => {
    // A filtered view with no ending in it reads as a run still going.
    expect(addressedToUser(note(0))).toBe(true);
  });
});

describe("bookkeeping", () => {
  const warning = (ms = 0): Row => {
    n += 1;
    return {
      id: `w${n}`, seq: n, ts: at(ms), kind: "note",
      text: "budget warning — tokens at 327268/400000", tone: "wait", chrome: true,
    } as Row;
  };

  it("folds even when it is on its own", () => {
    // A lone budget warning stood as an amber divider across the whole
    // transcript, saying the number the panel draws live three inches away.
    const grouped = groupRows([said("dev"), warning(100), said("dev", 200)]);
    expect(grouped.filter(isGroup)).toHaveLength(1);
  });

  it("joins the work around it instead of splitting it in two", () => {
    const grouped = groupRows([did("dev", 0), warning(100), did("dev", 200)]);
    expect(grouped.filter(isGroup)).toHaveLength(1);
    expect(ungroup(grouped)).toHaveLength(3);
  });

  it("is still reachable", () => {
    const rows = [said("dev"), warning(100)];
    expect(ungroup(groupRows(rows))).toEqual(rows);
  });
});

describe("what a closed fold says", () => {
  const toolRow = (text: string, tone = "idle"): Row => {
    n += 1;
    return {
      id: `t${n}`, seq: n, ts: at(n * 100), kind: "did",
      agentId: "dev", name: "Dev", text, tone,
    } as Row;
  };

  it("names the files rather than counting the rows", () => {
    // "16 steps" can only be opened. A fold nobody dares leave shut has
    // bought nothing, and then the timeline is 1,170 rows again.
    const [group] = groupRows([
      toolRow("tool ok — wrote 439 bytes to package.json"),
      toolRow("tool ok — wrote 574 bytes to tsconfig.json"),
      toolRow("tool ok — read 22 line(s) of package.json"),
    ]);
    expect(isGroup(group!) && group.wrote).toBe(2);
    expect(isGroup(group!) && group.files).toEqual(["package.json", "tsconfig.json"]);
  });

  it("reads the path out of an edit as well as a write", () => {
    const [group] = groupRows([
      toolRow("tool ok — edited app.js (-228 bytes)"),
      toolRow("tool ok — edited lib/data.ts (+40 bytes)"),
    ]);
    expect(isGroup(group!) && group.files).toEqual(["app.js", "lib/data.ts"]);
  });

  it("shows from the outside that something inside failed", () => {
    const [group] = groupRows([
      toolRow("tool ok — wrote 1 byte to a.ts"),
      toolRow("tool failed — this looks like a binary file", "stop"),
    ]);
    expect(isGroup(group!) && group.failed).toBe(true);
  });

  it("carries the span, so the rows inside need no clock", () => {
    const [group] = groupRows([toolRow("a"), toolRow("b"), toolRow("c")]);
    expect(isGroup(group!) && group.until).not.toBe(group!.ts);
  });
});

describe("only the newest page is drawn", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => said("dev", i * 1000));

  it("keeps the end, because that is where a reader opens", () => {
    const rows = many(300);
    const view = windowed(rows, 120);
    expect(view.items).toHaveLength(120);
    expect(view.items[view.items.length - 1]).toBe(rows[rows.length - 1]);
    expect(view.hidden).toBe(180);
  });

  it("draws everything when there is little enough", () => {
    const rows = many(10);
    expect(windowed(rows, 120)).toEqual({ items: rows, hidden: 0 });
  });

  it("counts what is above rather than dropping it silently", () => {
    // A transcript that quietly starts partway through is one you cannot check
    // a run against — the same rule the fold and the filter follow.
    expect(windowed(many(500), 120).hidden).toBe(380);
  });

  it("gives back everything once the limit passes the total", () => {
    const rows = many(150);
    expect(windowed(rows, 400).items).toEqual(rows);
  });
});
