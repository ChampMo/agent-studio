/**
 * A list of paths is what a file manager gives you. What the app knows and it
 * does not is who changed what, when, and in which order.
 */
import { describe, expect, it } from "vitest";

import { countChanges, fileTrails } from "./fileHistory";
import type { SequencedEntry } from "../../stores/eventStore";

let n = 0;
function ev(type: string, payload: Record<string, unknown>, ts = "2026-09-03T10:00:00Z") {
  n += 1;
  return {
    event: {
      v: 1,
      id: `e-${n}`,
      missionId: "m-1",
      seq: n,
      ts,
      draft: { type, payload },
    },
    known: true,
    futureVersion: false,
  } as unknown as SequencedEntry;
}

const nameOf = (id: string) => ({ dev: "Developer", qa: "Tester" })[id] ?? id;

function wrote(call: string, path: string, agentId: string, ts: string, ok = true) {
  return [
    ev("agent.tool.start", { callId: call, tool: "write_file", agentId, input: { path } }, ts),
    ev(
      "agent.tool.end",
      { callId: call, ok, summary: ok ? `wrote 100 bytes to ${path}` : "refused" },
      ts,
    ),
  ];
}

function edited(call: string, path: string, agentId: string, ts: string) {
  return [
    ev("agent.tool.start", { callId: call, tool: "edit_file", agentId, input: { path } }, ts),
    ev("agent.tool.end", { callId: call, ok: true, summary: `edited ${path} (+12 bytes)` }, ts),
  ];
}

describe("what happened to each file", () => {
  it("gathers every change to one path in the order it happened", () => {
    const trails = fileTrails(
      [
        ...wrote("c1", "app/page.tsx", "dev", "2026-09-03T10:00:00Z"),
        ...edited("c2", "app/page.tsx", "qa", "2026-09-03T10:05:00Z"),
      ],
      nameOf,
    );
    expect(trails).toHaveLength(1);
    expect(trails[0]!.changes.map((c) => [c.verb, c.name])).toEqual([
      ["wrote", "Developer"],
      ["edited", "Tester"],
    ]);
  });

  it("keeps the backend's own sentence rather than rephrasing it", () => {
    // It is the record. A paraphrase would be a second version of it.
    const [trail] = fileTrails(wrote("c1", "lib/data.ts", "dev", "2026-09-03T10:00:00Z"), nameOf);
    expect(trail!.changes[0]!.summary).toBe("wrote 100 bytes to lib/data.ts");
  });

  it("puts the most recently touched file first", () => {
    const trails = fileTrails(
      [
        ...wrote("c1", "old.ts", "dev", "2026-09-03T10:00:00Z"),
        ...wrote("c2", "new.ts", "dev", "2026-09-03T11:00:00Z"),
      ],
      nameOf,
    );
    expect(trails.map((t) => t.path)).toEqual(["new.ts", "old.ts"]);
  });

  it("keeps a write that failed, and says the file is not there", () => {
    // A file missing because writing it failed looks exactly like a file
    // nobody tried to write. This is the only thing that tells them apart.
    const [trail] = fileTrails(
      wrote("c1", "blocked.ts", "dev", "2026-09-03T10:00:00Z", false),
      nameOf,
    );
    expect(trail!.changes[0]!.ok).toBe(false);
    expect(trail!.exists).toBe(false);
  });

  it("does not un-write a file because a later edit failed", () => {
    const trails = fileTrails(
      [
        ...wrote("c1", "app.ts", "dev", "2026-09-03T10:00:00Z"),
        ev("agent.tool.start", { callId: "c2", tool: "edit_file", agentId: "dev", input: { path: "app.ts" } }),
        ev("agent.tool.end", { callId: "c2", ok: false, summary: "no such text" }),
      ],
      nameOf,
    );
    expect(trails[0]!.exists).toBe(true);
    expect(trails[0]!.changes).toHaveLength(2);
  });

  it("ignores tools that do not change files", () => {
    const trails = fileTrails(
      [
        ev("agent.tool.start", { callId: "c1", tool: "read_file", agentId: "dev", input: { path: "x.ts" } }),
        ev("agent.tool.end", { callId: "c1", ok: true, summary: "read 10 lines" }),
      ],
      nameOf,
    );
    expect(trails).toEqual([]);
  });

  it("ignores a call whose end never arrived", () => {
    // A run cancelled mid-write leaves a dangling start. Counting it would put
    // a file on the list that may not exist.
    const trails = fileTrails(
      [ev("agent.tool.start", { callId: "c1", tool: "write_file", agentId: "dev", input: { path: "x.ts" } })],
      nameOf,
    );
    expect(trails).toEqual([]);
  });

  it("counts changes, not files", () => {
    const trails = fileTrails(
      [
        ...wrote("c1", "a.ts", "dev", "2026-09-03T10:00:00Z"),
        ...edited("c2", "a.ts", "dev", "2026-09-03T10:01:00Z"),
        ...wrote("c3", "b.ts", "dev", "2026-09-03T10:02:00Z"),
      ],
      nameOf,
    );
    expect(trails).toHaveLength(2);
    expect(countChanges(trails)).toBe(3);
  });
});
