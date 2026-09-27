/**
 * A question arrives with the answers the agent could see, and which it would
 * take.
 *
 * Reported from a real run: an agent asked a dense paragraph — one checkout
 * flow or two, with four consequences spelled out — under a bare text box. The
 * person had to re-derive a decision the agent had already spent a turn on.
 *
 * `parseAsk` could not help: it reads options out of prose and refuses what it
 * is unsure of, so a question written as a paragraph offers nothing. The
 * answer is a field rather than a better parser — what the agent meant, not a
 * reading of what it wrote.
 *
 * The recommendation is the **agent's**. Nothing here invents one, and one
 * that does not name an option on offer is dropped rather than shown, because
 * it would point at a button nobody drew.
 */
import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../../transport/events.generated";
import { offerFor } from "./choices";
import { buildTranscript, type AskRow } from "./transcript";

let seq = 0;
function ask(payload: Record<string, unknown>) {
  seq += 1;
  return {
    event: {
      v: 1,
      id: `e-${seq}`,
      missionId: "m-1",
      seq,
      ts: "2026-09-26T00:00:00Z",
      draft: { type: "agent.request", payload },
    } as unknown as EventEnvelope,
    known: true,
    futureVersion: false,
  };
}

const nameOf = (id: string) => (id === "a-1" ? "Willow" : id);

function rowFor(payload: Record<string, unknown>): AskRow {
  const rows = buildTranscript([ask(payload)], {}, nameOf);
  const row = rows.find((r) => r.kind === "ask");
  if (!row || row.kind !== "ask") throw new Error("no ask row");
  return row;
}

const BASE = {
  agentId: "a-1",
  requestId: "req-1",
  kind: "question",
  question: "One checkout flow or two?",
};

describe("the answers an agent offered", () => {
  it("keeps the options and the recommendation it gave", () => {
    const row = rowFor({
      ...BASE,
      options: ["one flow", "two flows"],
      recommended: "two flows",
    });
    expect(row.options).toEqual(["one flow", "two flows"]);
    expect(row.recommended).toBe("two flows");
  });

  it("has no recommendation when the agent made none", () => {
    const row = rowFor({ ...BASE, options: ["one flow", "two flows"] });
    expect(row.recommended).toBeNull();
  });

  it("drops a recommendation that names nothing on offer", () => {
    // Otherwise the card marks a button that was never drawn.
    const row = rowFor({
      ...BASE,
      options: ["one flow", "two flows"],
      recommended: "three flows",
    });
    expect(row.recommended).toBeNull();
  });

  it("drops a recommendation when no options came with it", () => {
    const row = rowFor({ ...BASE, recommended: "two flows" });
    expect(row.options).toBeNull();
    expect(row.recommended).toBeNull();
  });

  it("reads a question recorded before the field existed", () => {
    // §8: an older run has neither, and still renders as the question it was.
    const row = rowFor(BASE);
    expect(row.options).toBeNull();
    expect(row.recommended).toBeNull();
    expect(row.question).toBe("One checkout flow or two?");
  });
});

describe("what the card prints, beside what it offers", () => {
  // The agent writes its reasons into the prose, one line per option, and
  // *also* fills in `options` — which is exactly what the tool description
  // now asks it to do. `parseAsk` would lift that prose list out, on the
  // promise that every word it removes is on a button. The buttons are the
  // short structured labels, so that promise is not kept, and what goes
  // missing is the agent's argument.
  const REASONED =
    "I can fix this three ways: 1. rename the column, which is a breaking " +
    "change for anyone reading it. 2. add a view over it, which costs a " +
    "migration but nothing downstream. 3. leave it and document the quirk. " +
    "Which do you want?";

  it("prints a structured question whole, reasons and all", () => {
    const { asked, offered } = offerFor(REASONED, [
      "rename",
      "view",
      "document",
    ]);
    expect(asked).toBe(REASONED);
    expect(asked).toContain("breaking change");
    expect(asked).toContain("costs a migration");
    expect(offered.map((o) => o.text)).toEqual(["rename", "view", "document"]);
  });

  it("still lifts the list out when the options were only prose", () => {
    // Unchanged for every run recorded before the field existed: the buttons
    // are the very strings removed, so nothing is lost by moving them.
    const { asked, offered } = offerFor(REASONED, null);
    expect(offered.map((o) => o.text.slice(0, 6))).toEqual([
      "rename",
      "add a ",
      "leave ",
    ]);
    expect(asked).not.toContain("rename the column");
    expect(asked).toContain("I can fix this three ways");
  });

  it("gives a structured option no marker, because the question has none", () => {
    const { offered } = offerFor("Table or prose?", ["a table", "prose"]);
    expect(offered.map((o) => o.marker)).toEqual([null, null]);
  });
});

describe("a note the person sent, and who read it", () => {
  // The composer says "waiting for the next step" and then the line simply
  // vanishes. On a real run the note had been read, investigated and filed as
  // a QA case, and the honest reading of the screen was that nothing
  // happened. §7.3: reading a note is something an agent *did*, not said.
  function rowsFor(payload: Record<string, unknown>) {
    seq += 1;
    const entry = {
      event: {
        v: 1,
        id: `e-${seq}`,
        missionId: "m-1",
        seq,
        ts: "2026-09-27T00:00:00Z",
        draft: { type: "user.note.read", payload },
      } as unknown as EventEnvelope,
      known: true,
      futureVersion: false,
    };
    return buildTranscript([entry], {}, (id) => (id === "a-1" ? "Rowan" : id));
  }

  it("names the agent and quotes the note", () => {
    const rows = rowsFor({
      agentId: "a-1",
      taskId: "t3",
      excerpt: "the cursor is missing on index.html",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("did");
    const text = (rows[0] as { text: string }).text;
    expect(text).toContain("Rowan");
    expect(text).toContain("read your note");
    expect(text).toContain("the cursor is missing on index.html");
  });

  it("still says something when the log carries no excerpt", () => {
    // §8: a row this build cannot fully read is still a row.
    const rows = rowsFor({ agentId: "a-1" });
    expect(rows).toHaveLength(1);
    expect((rows[0] as { text: string }).text).toContain("Rowan");
  });

  it("is a quiet line, not a speech bubble", () => {
    // Dressing an action as dialogue is inventing dialogue.
    const rows = rowsFor({ agentId: "a-1", excerpt: "fix it" });
    expect(rows[0]!.kind).not.toBe("said");
  });
});
