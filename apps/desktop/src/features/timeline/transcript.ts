/**
 * The event log, arranged as a conversation (§18.2).
 *
 * The rule this file exists to keep: **a chat view is a shape, not a filter.**
 * The timeline is the observability claim made concrete (§1) — if it starts
 * dropping events because they do not look like chat, then the thing that was
 * supposed to let you check what happened has quietly become a thing that shows
 * you the nice parts. So every event that goes in comes out, including types
 * this build has never heard of (§8) and frames it could not read at all.
 *
 * What changes is the row's *shape*. Three of them:
 *
 * - `said` — someone's actual words. A bubble, the agent on the left, the
 *   person on the right, the way every chat app has arranged this since talking
 *   to a machine looked like talking to a person.
 * - `did` — an action attributable to one agent: a tool call, a status, a
 *   thought. A quiet line under their name, because "Source Scout calls grep"
 *   is not something Source Scout *said*.
 * - `note` — the run itself: started, ended, a question waiting, a budget
 *   warning, a file written. Centred, belonging to nobody.
 *
 * Pure, and separate from the component, so the interesting parts — an unknown
 * event still appears, consecutive turns from one speaker share a header,
 * streaming text lands under the right name — are tests rather than something
 * checked by scrolling.
 */
import type { EventEnvelope } from "../../transport/events.generated";
import type { SequencedEntry, StreamingMessage } from "../../stores/eventStore";
import { describe } from "../../transport/decode";
import { missionLook } from "../../components/ui/status";

export type Tone = "idle" | "search" | "write" | "wait" | "stop" | "done";

/**
 * The one-line version of a note, where the full one is a wall of text.
 *
 * Nothing is lost: what is left out goes to `detail` and opens on demand. The
 * three here were each a paragraph printed between two rules, every time the
 * run was scrolled past.
 */
/** Past this a tool result stops being a line and becomes a wall. Long enough
 *  for the sentences the tools actually write — *wrote 2,898 bytes to
 *  app/globals.css*, *0 match(es) for 'x' in 74 file(s)* — and short enough
 *  that a command which printed a stylesheet does not bury its neighbours. */
const CLAMP = 200;

/** One line, and the rest behind a chevron. Nothing is lost: the row is still
 *  one row, and `detail` holds exactly what was clamped off. */
function clamp(text: string): { text: string; detail?: string } {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= CLAMP) return { text: oneLine };
  return { text: `${oneLine.slice(0, CLAMP).trimEnd()}…`, detail: text };
}

const asString = (v: unknown) => (typeof v === "string" ? v : null);

function shortNote(
  type: string,
  p: Record<string, unknown>,
  nameOf: (id: string) => string,
): string | null {
  if (type === "mission.started") {
    // The goal used to be repeated here in full — directly above the user's
    // own message saying exactly the same thing, twice on one screen.
    return p.workspaceRoot ? `Started in ${p.workspaceRoot}` : "Started";
  }
  if (type === "mission.ended") {
    // The same words the sidebar and the header use, not the raw enum. A run
    // stopped by a ceiling read "Round finished — budget_exceeded" here and
    // "Out of tokens" three inches away, and `failed` — which means the work
    // was wrong — was being printed over runs that had simply run out.
    const look = missionLook(null, String(p.reason ?? ""), asString(p.limit));
    return `Round finished — ${look.label.toLowerCase()}`;
  }
  if (type === "agent.request.resolved") {
    const who = typeof p.resolvedBy === "string" ? p.resolvedBy : "someone";
    return `Answered by ${who === "user" ? "you" : nameOf(who)}`;
  }
  return null;
}

/** Whitespace-insensitive, and only the opening: the ending's summary is the
 *  leader's message truncated at 2,000 characters and sometimes prefixed with
 *  the limit that stopped the run, so the two are the same text and never the
 *  same string. */
const SAME_ENOUGH = 160;

function looksLikeSame(summary: string, said: string): boolean {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  // A prefix such as "stopped at the tokens limit (x/y) — " is the app's own
  // words in front of the leader's; compare what follows it.
  const body = flat(summary.replace(/^stopped at the [^—]*—\s*/i, ""));
  if (body.length < 40) return false;
  return flat(said).includes(body.slice(0, SAME_ENOUGH));
}

function detailOf(
  type: string,
  p: Record<string, unknown>,
  lastSaid: string,
): { detail?: string } {
  const long =
    type === "mission.started"
      ? p.goal
      : type === "mission.ended"
        ? p.summary
        : type === "agent.request.resolved"
          ? p.answer
          : null;
  if (typeof long !== "string" || !long.trim()) return {};
  // A round's summary *is* the leader's last message. Attaching it here put
  // the same paragraphs on screen twice, one under the other.
  if (type === "mission.ended" && looksLikeSame(long, lastSaid)) return {};
  return { detail: long };
}

function isChrome(type: string, p: Record<string, unknown>): boolean {
  if (type === "budget.warning") return true;
  // Every state, not only `pending`. A task moving through pending → running
  // → done is *where things stand*, which is what the plan strip in the panel
  // draws and keeps drawing; as a run of centred dividers it was the same
  // three facts written four times between the two messages that mattered.
  //
  // `failed` folds with them because the `error` event that follows it says
  // the same thing in words, and the strip colours it red — a task that broke
  // is not being hidden, it is being said once instead of twice.
  if (type === "mission.progress") return true;
  // A **recoverable** error is the app correcting itself and carrying on: a
  // plan that was rejected and retried, a tool round that gave up so the next
  // task could start. Drawn in alarm red between two rules it reads as
  // something broken, and the run went on to finish perfectly well.
  //
  // The distinction is already on the wire — `recoverable` — rather than
  // guessed from the code. One that is not recoverable stays a milestone and
  // stays red, because then something really did stop.
  return type === "error" && p.recoverable === true;
}

/**
 * Who a message was addressed to, as a name.
 *
 * A `Recipient` is an object rather than a magic string precisely so an agent
 * id can never collide with the literal "user" (§6.2), and this is the one
 * place that turns it back into something readable. An unrecognised shape
 * returns null rather than a guess: no arrow is better than a wrong one.
 */
export function recipient(
  to: unknown,
  nameOf: (id: string) => string,
): string | null {
  if (!to || typeof to !== "object") return null;
  const kind = (to as { kind?: unknown }).kind;
  if (kind === "user") return "you";
  if (kind === "broadcast") return "the team";
  if (kind === "agent") {
    const id = (to as { id?: unknown }).id;
    return typeof id === "string" && id ? nameOf(id) : null;
  }
  return null;
}

interface Base {
  id: string;
  seq: number | null;
  ts: string | null;
}

export interface SaidRow extends Base {
  kind: "said";
  side: "left" | "right";
  agentId: string | null;
  name: string;
  text: string;
  /** Still arriving. Assembled from deltas, so it has no sequence yet. */
  streaming: boolean;
  /** False when the row above is the same speaker: one header per run of
   *  turns, the way a chat app groups them. */
  showHeader: boolean;
  /** Who it was addressed to, resolved to a name — "the team", "you", or a
   *  teammate's. Every line used to start with a speaker and never say the
   *  recipient, so a message to the team, a handover to one agent and a
   *  question aimed at the reader all looked identical. Null when the log did
   *  not record one. */
  to: string | null;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface DidRow extends Base {
  kind: "did";
  agentId: string | null;
  name: string;
  text: string;
  tone: Tone;
  /** The whole thing, when the line above it is a clamped version. A failed
   *  `bash` reports what the command printed, and a command that printed a
   *  stylesheet turned one row into a wall of red covering the messages either
   *  side of it. */
  detail?: string;
  /** Bookkeeping rather than something that happened: a status that expired
   *  seconds after it was written. Folds with the background. */
  chrome?: boolean;
  /** Started and not finished: the log holds an `agent.tool.start` whose
   *  `callId` never got its `agent.tool.end`. Drawn as a spinner rather than a
   *  dot — the difference between "ran grep" and "is running grep". */
  pending?: boolean;
}

/**
 * Somebody is working right now.
 *
 * Not an event — a derivation, like the streaming bubble, and appended after
 * the rows the log produced. It exists because an agent that is thinking
 * publishes `agent.status thinking` and then nothing at all until its reply is
 * finished, which on a slow model is a minute of a screen that looks broken.
 */
export interface BusyRow extends Base {
  kind: "busy";
  agentId: string;
  name: string;
  /** The status as published, so an unrecognised one is shown rather than
   *  guessed at (§8). */
  status: string;
  /** False for `waiting` and `blocked`: those are stopped on something, and a
   *  spinner would claim progress that is not happening. */
  spinning: boolean;
}

export interface NoteRow extends Base {
  kind: "note";
  text: string;
  tone: Tone;
  /** Set for `attachment.added`, so the row can show the picture instead of
   *  only naming it. The bytes are fetched by id — they are not on the log. */
  attachmentId?: string;
  /** The long version, opened on demand. A round's whole closing report and a
   *  paragraph-long answer to a question are both worth keeping and neither is
   *  worth a wall of centred text every time the run is scrolled past. */
  detail?: string;
  /** Bookkeeping rather than a milestone: a task moving to `pending`, a budget
   *  warning. True on the log, and not what anyone is reading the timeline
   *  for, so it folds with the background activity instead of standing between
   *  two rules. */
  chrome?: boolean;
  /** Set for an event type this build does not know (§8). */
  unknownType?: string;
  futureVersion?: boolean;
}

/**
 * A question the run stopped to ask.
 *
 * Its own row rather than a note, because it is the one thing on the timeline
 * that can still be *acted on*. Whether it is still waiting is not decided
 * here — this row only records that it was asked, and the renderer asks the
 * approval store whether anyone is still waiting for an answer. Deriving
 * "pending" from the log would mean re-implementing, in the transcript, a fact
 * the backend already owns (§2.1).
 */
export interface AskRow extends Base {
  kind: "ask";
  requestId: string;
  question: string;
  /** "approval" gets buttons; anything else gets a box to type in. */
  ask: string;
  options: string[] | null;
  /** Which of `options` the asker would take. Its recommendation, never the
   *  app's, and null when it did not make one. */
  recommended: string | null;
  name: string | null;
  /** So the renderer can draw the asker's face with the `avatarOf` it holds. */
  agentId: string | null;
}

export interface BrokenRow extends Base {
  kind: "broken";
  reason: string;
}

export type Row = SaidRow | DidRow | NoteRow | AskRow | BrokenRow | BusyRow;

/** Statuses that mean work is under way. `waiting` and `blocked` are neither
 *  of these: they are stopped, on a person or on a problem. */
const RESTS = new Set(["idle", "waiting", "blocked"]);

/** Which events are the run talking about itself rather than an agent acting. */
const NOTE_TONE: Record<string, Tone> = {
  "mission.started": "idle",
  "mission.ended": "done",
  "mission.progress": "idle",
  "agent.request": "wait",
  "agent.request.resolved": "done",
  "artifact.created": "write",
  "attachment.added": "idle",
  "budget.warning": "wait",
  error: "stop",
};

/** Tools, coloured by what they do rather than by what they are called. */
function toolTone(tool: unknown): Tone {
  const name = String(tool ?? "");
  if (name.startsWith("web_") || name === "grep" || name === "glob") return "search";
  if (name === "write_file" || name === "edit_file" || name === "bash") return "write";
  return "idle";
}

/**
 * Read a payload without knowing which of the fourteen it is.
 *
 * Through `unknown` deliberately. The generated union is closed and each
 * branch has its own fields, so TypeScript is right that no single one of them
 * is a `Record<string, unknown>` — but this function's whole job is to look at
 * fields whose presence depends on the type, including on events from a newer
 * backend that no branch describes at all (§8). Narrowing per branch here would
 * be fourteen switch arms restating what `describe()` already knows.
 */
function payloadOf(event: EventEnvelope): Record<string, unknown> {
  return (event.draft.payload ?? {}) as unknown as Record<string, unknown>;
}

export function buildTranscript(
  events: SequencedEntry[],
  streaming: Record<string, StreamingMessage>,
  nameOf: (agentId: string) => string,
  malformed: { reason: string }[] = [],
): Row[] {
  const rows: Row[] = [];
  /** Who owns the row above, so a run of turns can share one header. */
  let lastSpeaker: string | null = null;
  //: The most recent agent message, so an ending that merely repeats it can
  //: stop repeating it.
  let lastSaid = "";
  /** Tool calls that started and have not ended, by `callId` — and where their
   *  row is, so the end can reach back and clear it. */
  const openCalls = new Map<string, DidRow>();
  /** The latest status each agent published. */
  const latestStatus = new Map<string, string>();
  //: The row that carried each agent's latest status, so the one that is
  //: still true can be marked as under way rather than sitting as a dot.
  const latestStatusRow = new Map<string, DidRow>();
  let ended = false;

  const push = (row: Row) => {
    // Anything that is not speech breaks the run: an action between two
    // messages means the second one deserves its name again.
    if (row.kind !== "said") lastSpeaker = null;
    rows.push(row);
  };

  for (const { event, known, futureVersion } of events) {
    const type = event.draft.type;
    // The first event after a round ended opens the next one. `mission.ended`
    // ends a *round*, not the log: a continued run appends to the same
    // events, and with `ended` left standing no continued round ever showed
    // a spinner, a fish, or a busy row again — the same rule `deriveVitals`
    // and the scene already carry, and the third place it has been needed.
    if (ended && type !== "mission.ended") ended = false;
    const p = payloadOf(event);
    const base = { id: event.id, seq: event.seq, ts: event.ts };
    const agentId = typeof p.agentId === "string" ? p.agentId : null;

    // An event this build has never heard of still happened (§8). It gets a
    // note with its raw type showing, rather than being quietly skipped —
    // which in a chat view would be indistinguishable from nothing happening.
    if (!known) {
      push({
        ...base,
        kind: "note",
        text: describe(event, nameOf),
        tone: "idle",
        unknownType: type,
        futureVersion,
      });
      continue;
    }

    if (type === "user.message") {
      push({
        ...base,
        kind: "said",
        side: "right",
        agentId: null,
        name: "",
        text: String(p.content ?? ""),
        streaming: false,
        showHeader: false,
        to: null,
      });
      lastSpeaker = "user";
      continue;
    }

    if (type === "agent.message") {
      const speaker = agentId ?? "agent";
      // A turn that spent everything on reasoning and emitted nothing. The
      // event is right — the agent really did produce no words — but drawn as
      // an empty speech bubble it reads as the app losing the message. Checked
      // against the log: `content` is "" and `outputTokens` is the whole cap.
      //
      // A quiet line instead, saying what it cost. `run_agent_turn` already
      // publishes no message for a round that only called tools, for the same
      // reason; this is the case it cannot know about in advance.
      if (!String(p.content ?? "").trim()) {
        const spent = (p.usage as { outputTokens?: number } | undefined)?.outputTokens;
        push({
          ...base,
          kind: "did",
          agentId,
          name: agentId ? nameOf(agentId) : "",
          text: spent
            ? `${agentId ? nameOf(agentId) : "the agent"} produced no answer — ${spent.toLocaleString("en")} output tokens spent`
            : `${agentId ? nameOf(agentId) : "the agent"} produced no answer`,
          tone: "stop",
        });
        lastSpeaker = speaker;
        continue;
      }
      rows.push({
        ...base,
        kind: "said",
        side: "left",
        agentId,
        name: agentId ? nameOf(agentId) : "",
        text: String(p.content ?? ""),
        streaming: false,
        showHeader: lastSpeaker !== speaker,
        to: recipient(p.to, nameOf),
        usage: p.usage as SaidRow["usage"],
      });
      lastSaid = String(p.content ?? "");
      lastSpeaker = speaker;
      continue;
    }

    if (type === "agent.usage") {
      // What a round of tool calls cost. A quiet line, not a bubble: the agent
      // said nothing, it spent something. Before this event existed those
      // tokens were counted by the budget guard and absent from the log, so the
      // meter beside the limit was measuring a different run (§1).
      push({
        ...base,
        kind: "did",
        agentId,
        name: agentId ? nameOf(agentId) : "",
        text: describe(event, nameOf),
        tone: "idle",
      });
      continue;
    }

    if (type === "agent.thought" || type === "agent.status") {
      if (type === "agent.status" && agentId) {
        latestStatus.set(agentId, String(p.status ?? ""));
      }
      const statusRow: DidRow = {
        ...base,
        kind: "did",
        agentId,
        name: agentId ? nameOf(agentId) : "",
        text: describe(event, nameOf),
        tone: "idle",
        // `is thinking` / `is working` / `is idle` is a state that expires in
        // seconds, written permanently into a history. The panel shows who is
        // doing what *now*, live, beside their face; here it is one row per
        // transition, forever, pushing the run's actual content off screen.
        //
        // Still a row — every event makes one — but bookkeeping, so it folds
        // with the background rather than standing between two messages.
        ...(type === "agent.status" ? { chrome: true } : {}),
      };
      if (type === "agent.status" && agentId) latestStatusRow.set(agentId, statusRow);
      push(statusRow);
      continue;
    }

    if (type === "agent.tool.start" || type === "agent.tool.end") {
      const callId = typeof p.callId === "string" ? p.callId : null;
      const row: DidRow = {
        ...base,
        kind: "did",
        agentId,
        name: agentId ? nameOf(agentId) : "",
        ...clamp(describe(event, nameOf)),
        tone:
          type === "agent.tool.end" && p.ok === false ? "stop" : toolTone(p.tool),
      };

      if (type === "agent.tool.start" && callId) {
        row.pending = true;
        openCalls.set(callId, row);
      } else if (callId) {
        // The end has landed, so the start is no longer in progress. Reaching
        // back is what keeps this honest on a *replay*: every call in a
        // finished run is complete, and a spinner frozen over last week's log
        // would be the record claiming something is still happening (§1).
        const start = openCalls.get(callId);
        if (start) start.pending = false;
        openCalls.delete(callId);
      }

      push(row);
      continue;
    }

    if (type === "mission.ended") {
      ended = true;
      // Nothing is under way once the round is over — closed here, at the
      // ending, so a dangling call or status from this round cannot be
      // carried into the next one as though it were still happening.
      for (const row of openCalls.values()) row.pending = false;
      openCalls.clear();
      latestStatus.clear();
      latestStatusRow.clear();
    }

    if (type === "agent.request" && typeof p.requestId === "string") {
      const asker = typeof p.agentId === "string" ? p.agentId : null;
      push({
        ...base,
        kind: "ask",
        requestId: p.requestId,
        question: typeof p.question === "string" ? p.question : "",
        ask: typeof p.kind === "string" ? p.kind : "question",
        options: Array.isArray(p.options) ? (p.options as string[]) : null,
        // Only when it is genuinely one of the options: a run recorded before
        // this field existed has none, and a value naming something not on
        // offer would point at a button nobody drew (§8).
        recommended:
          typeof p.recommended === "string" &&
          Array.isArray(p.options) &&
          (p.options as string[]).includes(p.recommended)
            ? p.recommended
            : null,
        name: asker ? nameOf(asker) : null,
        agentId: asker,
      });
      continue;
    }

    push({
      ...base,
      kind: "note",
      text: shortNote(type, p, nameOf) ?? describe(event, nameOf),
      ...detailOf(type, p, lastSaid),
      // A task announced as `pending` says what the plan directly above it
      // already listed, and a budget warning is a number the panel is already
      // drawing. Both are true and neither is a milestone.
      ...(isChrome(type, p) ? { chrome: true } : {}),
      // A recoverable error is not an alarm. Same rule as the fold: it is
      // still on the log, still readable, and no longer shouting.
      tone: isChrome(type, p) && type === "error" ? "idle" : (NOTE_TONE[type] ?? "idle"),
      ...(type === "attachment.added" && typeof p.attachmentId === "string"
        ? { attachmentId: p.attachmentId }
        : {}),
    });
  }

  // Text still arriving. It has no sequence — it is not on the log yet — so it
  // goes last, which is also where it belongs in time.
  for (const [messageId, partial] of Object.entries(streaming)) {
    const speaker = partial.agentId || null;
    rows.push({
      id: `stream-${messageId}`,
      seq: null,
      ts: null,
      kind: "said",
      side: "left",
      agentId: speaker,
      name: speaker ? nameOf(speaker) : "",
      text: partial.text,
      streaming: true,
      showHeader: lastSpeaker !== (speaker ?? "agent"),
      // Not known until the message lands: the recipient is on the stored
      // event, and the deltas carry only text.
      to: null,
    });
    lastSpeaker = speaker ?? "agent";
  }

  // Nothing is under way once the run is over. A cancelled mission leaves its
  // last `agent.tool.start` dangling — the record is right, the agent really
  // was mid-call — but the *ending* is what says it stopped, the same terminal
  // reset the scene uses rather than waiting for a status nobody published.
  if (ended) {
    for (const row of openCalls.values()) row.pending = false;
    openCalls.clear();
    latestStatus.clear();
  }

  // Who is working right now. An agent that is thinking publishes a status and
  // then says nothing until its whole reply is ready, so without this a slow
  // model is a minute of a screen that looks broken.
  const typing = new Set(
    Object.values(streaming)
      .map((partial) => partial.agentId)
      .filter(Boolean),
  );
  for (const [agentId, status] of latestStatus) {
    // The status row itself is still true while it is the latest: `X is
    // thinking` is happening now, not a thing that happened. Marked as under
    // way so it draws the fish rather than a finished dot, and so the fold
    // leaves it out where it can be seen. The same rule as a tool call whose
    // end has not landed, and it clears the same way — `mission.ended`
    // empties `latestStatus`.
    //
    // This *is* the busy indicator now. There used to be a separate `busy`
    // row appended after the log as well, and with the fish on the status
    // row it was the same fact twice, one above the other; the artist
    // crossed it out. The `busy` kind stays in the types so a row of that
    // shape still renders if one is ever produced again.
    if (typing.has(agentId)) continue;
    if (RESTS.has(status)) continue;
    const row = latestStatusRow.get(agentId);
    if (row) row.pending = true;
  }

  // A frame this build could not read at all. Surfaced, never swallowed (§8).
  for (const [i, entry] of malformed.entries()) {
    rows.push({
      id: `malformed-${i}`,
      seq: null,
      ts: null,
      kind: "broken",
      reason: entry.reason,
    });
  }

  return rows;
}
