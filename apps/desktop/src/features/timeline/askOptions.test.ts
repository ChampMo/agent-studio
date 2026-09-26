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
    },
    known: true,
    futureVersion: false,
  } as never;
}

function rowFor(payload: Record<string, unknown>): AskRow {
  const rows = buildTranscript([ask(payload)], () => null, () => null);
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
