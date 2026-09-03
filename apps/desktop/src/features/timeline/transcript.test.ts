import { describe as suite, expect, it } from "vitest";
import { buildTranscript } from "./transcript";
import type { SequencedEntry } from "../../stores/eventStore";
import type { EventEnvelope } from "../../transport/events.generated";

let seq = 0;

function entry(
  type: string,
  payload: Record<string, unknown>,
  { known = true, futureVersion = false } = {},
): SequencedEntry {
  seq += 1;
  return {
    event: {
      id: `evt-${seq}`,
      seq,
      ts: "2026-08-31T12:00:00+00:00",
      missionId: "m1",
      v: 1,
      draft: { type, payload },
    } as unknown as EventEnvelope,
    known,
    futureVersion,
  };
}

const nameOf = (id: string) => (id === "a1" ? "Source Scout" : id);

suite("the transcript", () => {
  it("puts the person on the right and the agent on the left", () => {
    const rows = buildTranscript(
      [
        entry("user.message", { content: "find the retry budget" }),
        entry("agent.message", { agentId: "a1", content: "it is in config.py" }),
      ],
      {},
      nameOf,
    );

    expect(rows.map((r) => r.kind)).toEqual(["said", "said"]);
    expect(rows[0]).toMatchObject({ side: "right", text: "find the retry budget" });
    expect(rows[1]).toMatchObject({ side: "left", name: "Source Scout" });
  });

  it("shows one header for a run of turns from the same agent", () => {
    const rows = buildTranscript(
      [
        entry("agent.message", { agentId: "a1", content: "one" }),
        entry("agent.message", { agentId: "a1", content: "two" }),
      ],
      {},
      nameOf,
    );

    expect(rows[0]).toMatchObject({ showHeader: true });
    expect(rows[1]).toMatchObject({ showHeader: false });
  });

  it("starts a new header when something happened in between", () => {
    // An action between two messages means the second one has earned its name
    // back — otherwise a tool call looks like it came from nobody.
    const rows = buildTranscript(
      [
        entry("agent.message", { agentId: "a1", content: "one" }),
        entry("agent.tool.start", { agentId: "a1", tool: "grep" }),
        entry("agent.message", { agentId: "a1", content: "two" }),
      ],
      {},
      nameOf,
    );

    expect(rows.map((r) => r.kind)).toEqual(["said", "did", "said"]);
    expect(rows[2]).toMatchObject({ showHeader: true });
  });

  it("keeps an event type it has never heard of", () => {
    // §8: the chat view is a shape, not a filter. A newer backend's event still
    // has to appear, or the record silently stops being the record.
    const rows = buildTranscript(
      [entry("agent.danced", { agentId: "a1" }, { known: false })],
      {},
      nameOf,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "note", unknownType: "agent.danced" });
  });

  it("keeps a frame it could not read at all", () => {
    const rows = buildTranscript([], {}, nameOf, [{ reason: "not JSON" }]);
    expect(rows[0]).toMatchObject({ kind: "broken", reason: "not JSON" });
  });

  it("loses nothing: every event produces exactly one row", () => {
    const events = [
      entry("mission.started", { goal: "g" }),
      entry("user.message", { content: "hello" }),
      entry("agent.status", { agentId: "a1", status: "thinking" }),
      entry("agent.thought", { agentId: "a1", text: "hmm" }),
      entry("agent.tool.start", { agentId: "a1", tool: "grep" }),
      entry("agent.tool.end", { agentId: "a1", tool: "grep", ok: true }),
      entry("agent.message", { agentId: "a1", content: "done" }),
      entry("mission.progress", { taskId: "t", state: "done", done: 1, total: 1 }),
      entry("artifact.created", { kind: "file", path: "out.md" }),
      entry("budget.warning", { kind: "tokens", used: 9, limit: 10 }),
      entry("agent.request", { agentId: "a1", question: "may I?" }),
      entry("agent.request.resolved", { resolvedBy: "user", answer: "yes" }),
      entry("error", { code: "x", message: "boom" }),
      entry("mission.ended", { reason: "completed" }),
    ];

    expect(buildTranscript(events, {}, nameOf)).toHaveLength(events.length);
  });


  it("loses nothing even while something is still in flight", () => {
    // The busy row is a derivation appended after the log, like the streaming
    // bubble — it must never replace or absorb an event's own row.
    const events = [
      entry("agent.status", { agentId: "a1", status: "working" }),
      entry("agent.tool.start", { agentId: "a1", callId: "c1", tool: "grep" }),
    ];
    const rows = buildTranscript(events, {}, nameOf);

    expect(rows.filter((r) => r.kind !== "busy")).toHaveLength(events.length);
    expect(rows.filter((r) => r.kind === "busy")).toHaveLength(1);
  });
});

suite("showing that something is happening", () => {
  it("gives a question its own row, so it can be answered where it was asked", () => {
    const rows = buildTranscript(
      [
        entry("agent.request", {
          agentId: "a1",
          requestId: "req-1",
          kind: "approval",
          question: "Run bash?",
        }),
      ],
      {},
      nameOf,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "ask",
      requestId: "req-1",
      ask: "approval",
      question: "Run bash?",
      name: "Source Scout",
      agentId: "a1",
    });
  });

  it("does not decide whether a question is still waiting", () => {
    // The row records that it was asked. Whether anyone is still waiting is
    // `approvalStore`'s answer, and it has it from the backend — scanning the
    // log for a matching `resolved` here would be a second implementation of
    // the same fact, and wrong for a question asked by a process that is gone.
    const rows = buildTranscript(
      [
        entry("agent.request", { agentId: "a1", requestId: "req-1", question: "ok?" }),
        entry("agent.request.resolved", { requestId: "req-1", answer: "approve" }),
      ],
      {},
      nameOf,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe("ask");
    expect(rows[0]).not.toHaveProperty("pending");
    expect(rows[0]).not.toHaveProperty("answered");
  });

  it("marks a tool call that has started and not ended", () => {
    const rows = buildTranscript(
      [entry("agent.tool.start", { agentId: "a1", callId: "c1", tool: "bash" })],
      {},
      nameOf,
    );

    expect(rows[0]).toMatchObject({ kind: "did", pending: true });
  });

  it("clears it when the end arrives", () => {
    // Reaching back matters most on a *replay*: every call in a finished run
    // completed, and a spinner frozen over last week's log would be the record
    // claiming something is still happening (§1).
    const rows = buildTranscript(
      [
        entry("agent.tool.start", { agentId: "a1", callId: "c1", tool: "bash" }),
        entry("agent.tool.end", { agentId: "a1", callId: "c1", ok: true }),
      ],
      {},
      nameOf,
    );

    expect(rows[0]).toMatchObject({ pending: false });
  });

  it("spins for an agent that is thinking", () => {
    const rows = buildTranscript(
      [entry("agent.status", { agentId: "a1", status: "thinking" })],
      {},
      nameOf,
    );

    expect(rows.at(-1)).toMatchObject({
      kind: "busy",
      name: "Source Scout",
      status: "thinking",
      spinning: true,
    });
  });

  it("does not spin for an agent waiting on a person", () => {
    // `waiting` is stopped, not slow. A spinner would claim progress that is
    // not happening — and the thing it is waiting for is the reader.
    for (const status of ["idle", "waiting", "blocked"]) {
      const rows = buildTranscript(
        [entry("agent.status", { agentId: "a1", status })],
        {},
        nameOf,
      );
      expect(rows.some((r) => r.kind === "busy")).toBe(false);
    }
  });

  it("shows a status it has never heard of, in the words it was published in", () => {
    // §8. The agent said something is happening; this build does not know
    // what. Hiding it would be worse than saying the word.
    const rows = buildTranscript(
      [entry("agent.status", { agentId: "a1", status: "compiling" })],
      {},
      nameOf,
    );

    expect(rows.at(-1)).toMatchObject({
      kind: "busy",
      status: "compiling",
      spinning: true,
    });
  });

  it("takes the latest status, not the first", () => {
    const rows = buildTranscript(
      [
        entry("agent.status", { agentId: "a1", status: "thinking" }),
        entry("agent.status", { agentId: "a1", status: "idle" }),
      ],
      {},
      nameOf,
    );

    expect(rows.some((r) => r.kind === "busy")).toBe(false);
  });

  it("stops everything when the mission ends", () => {
    // A cancelled run leaves a dangling `agent.tool.start` and a last status of
    // `thinking` — both true of the moment they were written. The ending is
    // what says it is over, the same terminal reset the scene uses.
    const rows = buildTranscript(
      [
        entry("agent.status", { agentId: "a1", status: "thinking" }),
        entry("agent.tool.start", { agentId: "a1", callId: "c1", tool: "bash" }),
        entry("mission.ended", { reason: "cancelled" }),
      ],
      {},
      nameOf,
    );

    expect(rows.some((r) => r.kind === "busy")).toBe(false);
    // The tool row specifically — the status row above it is also a `did` and
    // carries no `pending` at all.
    const call = rows.find((r) => r.kind === "did" && "pending" in r);
    expect(call).toMatchObject({ pending: false });
  });

  it("does not double up on an agent whose text is already streaming", () => {
    // The bubble has a cursor in it. Two indicators for one agent would be two
    // claims about the same thing.
    const rows = buildTranscript(
      [entry("agent.status", { agentId: "a1", status: "working" })],
      { "msg-1": { agentId: "a1", text: "partial" } },
      nameOf,
    );

    expect(rows.some((r) => r.kind === "busy")).toBe(false);
    expect(rows.some((r) => r.kind === "said" && r.streaming)).toBe(true);
  });

  it("attributes streaming text to whoever is typing it", () => {
    const rows = buildTranscript([], { "msg-1": { agentId: "a1", text: "part" } }, nameOf);

    expect(rows[0]).toMatchObject({
      kind: "said",
      side: "left",
      name: "Source Scout",
      text: "part",
      streaming: true,
      seq: null,
    });
  });

  it("marks a failed tool call apart from a successful one", () => {
    const rows = buildTranscript(
      [
        entry("agent.tool.end", { agentId: "a1", tool: "bash", ok: false }),
        entry("agent.tool.end", { agentId: "a1", tool: "read_file", ok: true }),
      ],
      {},
      nameOf,
    );

    expect(rows[0]).toMatchObject({ tone: "stop" });
    expect(rows[1]).not.toMatchObject({ tone: "stop" });
  });

  it("says whose endpoint ran a search it cannot see inside", () => {
    // §16.8: a provider-side search is not a tool this app ran, and the row
    // must not imply it was.
    const rows = buildTranscript(
      [
        entry("agent.tool.start", {
          agentId: "a1",
          tool: "web_search",
          origin: "provider",
        }),
      ],
      {},
      nameOf,
    );

    expect((rows[0] as { text: string }).text).toContain("endpoint ran");
  });
});

/**
 * The three longest things on the timeline were printed in the shape reserved
 * for the shortest: a run's whole closing report, a paragraph-long answer, and
 * the goal repeated directly above the user's own message saying it.
 *
 * Nothing is dropped — every event still makes exactly one row — but the row
 * carries a line, and the paragraph opens on demand.
 */
suite("notes that are paragraphs", () => {
  const note = (rows: ReturnType<typeof buildTranscript>, contains: string) =>
    rows.find((r) => r.kind === "note" && r.text.includes(contains)) as
      | Extract<ReturnType<typeof buildTranscript>[number], { kind: "note" }>
      | undefined;

  it("does not repeat the goal that the user's own message already says", () => {
    const rows = buildTranscript(
      [entry("mission.started", { kind: "mission", goal: "Build the thing", workspaceRoot: "C:/ws" })],
      {},
      (id) => id,
      [],
    );
    const started = note(rows, "Started");
    expect(started!.text).not.toContain("Build the thing");
    expect(started!.detail).toBe("Build the thing");
  });

  it("shows an ending as a line, with the report behind it", () => {
    const rows = buildTranscript(
      [entry("mission.ended", { reason: "completed", summary: "All three files are written and verified." })],
      {},
      (id) => id,
      [],
    );
    const ended = note(rows, "Round finished");
    expect(ended!.text).not.toContain("All three files");
    expect(ended!.detail).toContain("All three files");
  });

  it("drops the report when it is the message directly above it", () => {
    // The summary *is* the leader's last message. Attaching it put the same
    // paragraphs on screen twice, one under the other.
    const said = "All three files are written and verified, and the build passes.";
    const rows = buildTranscript(
      [
        entry("agent.message", { agentId: "a1", content: said }),
        entry("mission.ended", { reason: "completed", summary: said }),
      ],
      {},
      (id) => id,
      [],
    );
    expect(note(rows, "Round finished")!.detail).toBeUndefined();
  });

  it("still shows it when the ending says something the message did not", () => {
    const rows = buildTranscript(
      [
        entry("agent.message", { agentId: "a1", content: "Working on it." }),
        entry("mission.ended", { reason: "failed", summary: "Nothing was produced; three tasks never started at all." }),
      ],
      {},
      (id) => id,
      [],
    );
    expect(note(rows, "Round finished")!.detail).toContain("never started");
  });

  it("marks task progress and a budget warning as bookkeeping", () => {
    const rows = buildTranscript(
      [
        entry("mission.progress", { taskId: "t1", label: "Write it", state: "pending", done: 0, total: 3 }),
        entry("mission.progress", { taskId: "t1", label: "Write it", state: "running", done: 0, total: 3 }),
        entry("mission.progress", { taskId: "t1", label: "Write it", state: "failed", done: 0, total: 3 }),
        entry("budget.warning", { kind: "tokens", used: 9, limit: 10 }),
      ],
      {},
      (id) => id,
      [],
    );
    // Every state, not only pending: the plan strip in the panel draws where
    // things stand, and the `error` event says a failure in words.
    expect(rows.filter((r) => r.kind === "note" && r.chrome)).toHaveLength(4);
  });

  it("still makes exactly one row per event", () => {
    const events = [
      entry("mission.started", { kind: "mission", goal: "go", workspaceRoot: "C:/ws" }),
      entry("mission.progress", { taskId: "t1", label: "x", state: "pending", done: 0, total: 1 }),
      entry("budget.warning", { kind: "tokens", used: 9, limit: 10 }),
      entry("mission.ended", { reason: "completed", summary: "done" }),
    ];
    expect(buildTranscript(events, {}, (id) => id, [])).toHaveLength(events.length);
  });
});

suite("errors the run recovered from", () => {
  const errors = (recoverable: boolean) =>
    buildTranscript(
      [entry("error", { code: "plan_corrected", message: "retried", recoverable })],
      {},
      (id) => id,
      [],
    ).filter((r) => r.kind === "note") as Extract<
      ReturnType<typeof buildTranscript>[number],
      { kind: "note" }
    >[];

  it("stops shouting about one the app corrected itself", () => {
    // "the plan was rejected and retried" in alarm red, between two rules,
    // reads as something broken — over a run that went on to finish.
    const [row] = errors(true);
    expect(row!.chrome).toBe(true);
    expect(row!.tone).not.toBe("stop");
  });

  it("keeps shouting about one that stopped something", () => {
    const [row] = errors(false);
    expect(row!.chrome).toBeUndefined();
    expect(row!.tone).toBe("stop");
  });
});

suite("a tool result that is a page, not a sentence", () => {
  const toolEnd = (summary: string) =>
    buildTranscript(
      [entry("agent.tool.end", { agentId: "a1", callId: "c1", tool: "bash", ok: false, summary })],
      {},
      (id) => id,
      [],
    )[0] as Extract<ReturnType<typeof buildTranscript>[number], { kind: "did" }>;

  it("leaves the sentences the tools actually write alone", () => {
    const row = toolEnd("wrote 2898 bytes to app/globals.css");
    expect(row.text).toContain("2898 bytes");
    expect(row.detail).toBeUndefined();
  });

  it("clamps a command that printed a stylesheet, and keeps it", () => {
    // One row turned into a wall of red across the messages either side of it.
    const wall = "svg { display: block; max-width: 100%; } ".repeat(40);
    const row = toolEnd(wall);
    expect(row.text.length).toBeLessThan(260);
    expect(row.text.endsWith("…")).toBe(true);
    expect(row.detail).toContain(wall.slice(0, 60));
  });

  it("is still one row", () => {
    const wall = "x".repeat(5000);
    expect(
      buildTranscript(
        [entry("agent.tool.end", { agentId: "a1", callId: "c1", tool: "bash", ok: false, summary: wall })],
        {},
        (id) => id,
        [],
      ),
    ).toHaveLength(1);
  });
});
