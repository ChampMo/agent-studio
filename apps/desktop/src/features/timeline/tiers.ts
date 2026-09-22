/**
 * How much room each row gets, and what gets folded away.
 *
 * The timeline's problem was never that it held too much. It is that **every
 * line had the same weight**: `tool ok — 0 match(es)` was set in the same size
 * as a question that had been waiting twelve minutes for an answer. Reading it
 * meant scanning 265 rows at one volume to find the four that mattered.
 *
 * So every row gets a tier, and the tier — not the colour — decides how much
 * space it takes, whether it can be folded, and what a filter hides.
 *
 *   blocking    the run has stopped and is waiting on you
 *   dialogue    somebody's actual words, always with who they were for
 *   milestone   a task changed state, a file was written, a round ended
 *   activity    tool calls, token counts, statuses — the machine working
 *
 * **Folded, never dropped.** A group keeps every row inside it and says how
 * many there are, because a timeline that quietly hides things is no longer
 * something you can check the run against — which is the whole reason the
 * transcript is one-row-per-event in the first place (§1). The count is the
 * promise: what is behind it is exactly what it says.
 *
 * Pure, and separate from the component, so the interesting rules are tests:
 * a group never spans two agents, a run that is still going is never folded
 * out of sight, and expanding one gives back precisely the rows that went in.
 */
import type { Row } from "./transcript";

export type Tier = "blocking" | "dialogue" | "milestone" | "activity";

/** Consecutive activity from one agent folds together while the gap between
 *  rows stays under this. Long enough to cover a burst of tool calls, short
 *  enough that two separate pieces of work do not merge into one line. */
export const FOLD_WINDOW_MS = 90_000;

/** Below this there is nothing to gain: a "1 more" chevron costs a click and
 *  saves a line. */
export const FOLD_FROM = 2;

export function tierOf(row: Row): Tier {
  switch (row.kind) {
    case "ask":
      return "blocking";
    case "said":
      return "dialogue";
    case "busy":
      return "activity";
    case "broken":
      // Something arrived that could not be read. That is a fact about this
      // build, and burying it in a fold is how it stays unnoticed.
      return "milestone";
    case "did":
      // Including one that failed — which reverses the rule this file was
      // written with, and the evidence changed it. "A tool that failed is the
      // most useful line on the timeline" is true of a tool whose failure
      // stopped something; it is not true of `read_file` meeting a binary,
      // which the agent read, shrugged at, and worked around. Standing in red
      // across the whole width, that row claimed the run was in trouble when
      // the run was fine.
      //
      // What genuinely stopped something is an `error` event with
      // `recoverable: false`, and that still stands on its own. A failed call
      // folds with the work it was part of, stays red inside the fold, and is
      // one click from the reader who wants it.
      return "activity";
    case "note":
      // Bookkeeping folds with the background: a task announced as `pending`
      // repeats the plan directly above it, and a budget warning is a number
      // the panel is already drawing. Both are true; neither is a milestone.
      return row.chrome ? "activity" : "milestone";
  }
}

export interface ActivityGroup {
  kind: "group";
  id: string;
  /** Every row that was folded, in order. Nothing is dropped. */
  rows: Row[];
  agentId: string | null;
  name: string;
  /** What they were doing, as a count of rows — the honest summary, and the
   *  promise that expanding gives back exactly this many. */
  count: number;
  ts: string | null;
  /** Last timestamp in the group, so the header can carry the span rather than
   *  every row repeating a clock nobody asked for. */
  until: string | null;
  /** True when something inside failed. A fold that can hide a failure without
   *  saying so is a fold nobody dares leave closed — and then the fold has
   *  bought nothing. */
  failed: boolean;
  /** The files this group touched, in order, first occurrence only. Names are
   *  what makes a fold safe to leave shut: "wrote 4 files · package.json,
   *  tsconfig.json +2" can be judged; "16 steps" can only be opened. */
  files: string[];
  /** How many of the rows were file writes, so the header can lead with the
   *  thing that changed the workspace rather than the count of everything. */
  wrote: number;
}

export type Grouped = Row | ActivityGroup;

export function isGroup(item: Grouped): item is ActivityGroup {
  return (item as ActivityGroup).kind === "group";
}

/** The text a row shows, or "" for the kinds that carry none. */
function textOf(row: Row): string {
  return "text" in row && typeof row.text === "string" ? row.text : "";
}

/**
 * The file a row wrote, or null.
 *
 * Read off the sentence the *backend* wrote — "tool ok - wrote 439 bytes to
 * package.json", "tool ok - edited app.js (-228 bytes)" — because that
 * sentence is the record and the tool id is not on the row.
 *
 * Plain string work rather than a regular expression, and not as a matter of
 * taste: the two shapes here are fixed and simple, and the pattern that
 * expressed them went through three layers of shell and editor escaping and
 * came out subtly different each time — matching nothing, silently, while
 * every isolated check of it passed.
 */
function wroteWhat(text: string): string | null {
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i += 1) {
    const verb = words[i]!.toLowerCase();
    if (verb !== "wrote" && verb !== "edited") continue;
    // "wrote 439 bytes to package.json" puts the path after "to"; "edited
    // app.js (-228 bytes)" puts it straight after the verb.
    const to = words.indexOf("to", i);
    const at = to > i && to < i + 4 ? to + 1 : i + 1;
    const path = words[at];
    if (!path) return null;
    const clean = path.replace(/[(),]+$/, "");
    return clean.includes(".") ? clean : null;
  }
  return null;
}

/** Which files a run of activity touched, first mention only and in order. */
function filesIn(rows: Row[]): string[] {
  const seen: string[] = [];
  for (const row of rows) {
    const path = wroteWhat(textOf(row));
    if (path && !seen.includes(path)) seen.push(path);
  }
  return seen;
}

/** The agent a row belongs to, or null for rows that belong to nobody. */
function ownerOf(row: Row): string | null {
  return row.kind === "did" || row.kind === "busy" || row.kind === "said"
    ? row.agentId
    : null;
}

function nameOf(row: Row): string {
  return row.kind === "did" || row.kind === "busy" || row.kind === "said"
    ? row.name
    : "";
}

function apart(a: Row, b: Row): number {
  if (!a.ts || !b.ts) return 0;
  const from = Date.parse(a.ts);
  const to = Date.parse(b.ts);
  // An unreadable timestamp must not split a group *or* join one across an
  // hour. Treating it as "no gap" keeps the fold, which is the same choice
  // `shouldChime` makes about a timestamp it cannot read.
  return Number.isNaN(from) || Number.isNaN(to) ? 0 : Math.abs(to - from);
}

/**
 * Fold runs of background activity, leave everything else alone.
 *
 * A group needs the same agent, an unbroken run, and gaps under the window. A
 * row from anyone else — or of any other tier — ends it, so a group can never
 * claim work that was not one agent's.
 */
export function groupRows(rows: Row[]): Grouped[] {
  const out: Grouped[] = [];
  let run: Row[] = [];

  const flush = () => {
    if (run.length === 0) return;
    // Bookkeeping folds even when it is alone. `FOLD_FROM` exists so a chevron
    // never costs a click to save one line of *content* — but a budget warning
    // is not content: it is the number the panel is already drawing live, and
    // a lone one still stood as an amber divider across the whole transcript.
    const allChrome = run.every(
      (row) => (row.kind === "note" || row.kind === "did") && row.chrome,
    );
    if (run.length < FOLD_FROM && !allChrome) {
      out.push(...run);
    } else {
      const first = run[0]!;
      out.push({
        kind: "group",
        id: `group-${first.id}`,
        rows: run,
        agentId: ownerOf(first),
        name: nameOf(first),
        count: run.length,
        ts: first.ts,
        until: run[run.length - 1]!.ts,
        failed: run.some((row) => "tone" in row && row.tone === "stop"),
        files: filesIn(run),
        wrote: filesIn(run).length,
      });
    }
    run = [];
  };

  for (const row of rows) {
    if (tierOf(row) !== "activity") {
      flush();
      out.push(row);
      continue;
    }
    // A pending tool call is the thing a spinner is drawn for. Folding it puts
    // the one row that says "this is happening right now" behind a click.
    if (row.kind === "did" && row.pending) {
      flush();
      out.push(row);
      continue;
    }
    // The same for the busy row. It is the live "this agent is thinking"
    // line, appended after the log and gone the moment the agent speaks —
    // and it was landing inside a collapsed fold of that agent's tool calls,
    // so a reader saw "Pell · 1 step" and nothing moving. It stands on its
    // own while it exists; there is nothing to fold it into afterwards.
    if (row.kind === "busy") {
      flush();
      out.push(row);
      continue;
    }
    const last = run[run.length - 1];
    // Chrome belongs to nobody, so it joins whatever run it lands in rather
    // than breaking one in half — the alternative is a fold, a lone warning,
    // and a second fold where there was one piece of work.
    if (last) {
      const chrome = (row.kind === "note" || row.kind === "did") && row.chrome;
      const lastChrome =
        (last.kind === "note" || last.kind === "did") && last.chrome;
      const differentOwner =
        !chrome && !lastChrome && ownerOf(last) !== ownerOf(row);
      if (differentOwner || apart(last, row) > FOLD_WINDOW_MS) flush();
    }
    run.push(row);
  }
  flush();
  return out;
}

/** Every row a grouped list holds, flattened back. The property that makes the
 *  fold safe: this equals what went in, in the same order. */
export function ungroup(items: Grouped[]): Row[] {
  return items.flatMap((item) => (isGroup(item) ? item.rows : [item]));
}

/**
 * Only the rows a person is in.
 *
 * The reading a filter has to get right is what "for me" means. It is not
 * "mentions the user" — it is **what the run needs from you, and what it said
 * to you**: a question it stopped on, your own messages, and a reply addressed
 * to you rather than to a teammate. Everything the agents said to each other
 * is the team working, and that is exactly what this hides.
 *
 * Milestones stay. "The round ended" and "a task failed" are not addressed to
 * anyone and are the frame the rest hangs on — a filtered view with no ending
 * in it would read as a run still going.
 */
export function addressedToUser(row: Row): boolean {
  if (tierOf(row) === "blocking") return true;
  if (row.kind === "said") return row.side === "right" || row.to === "you";
  if (row.kind === "note" || row.kind === "broken") return true;
  return false;
}

/**
 * How many of the newest items to draw.
 *
 * Opening a run pushes its whole history through the decoder and then asks the
 * DOM for a node per row — 1,170 on one real run, and growing every time the
 * conversation is continued, so a long run gets slower to open for ever.
 *
 * The batching fixed how *often* React was asked to draw. This fixes how
 * *much*. A reader opens a run at the bottom and reads upward, so the newest
 * page is the only part that has to exist before the first paint.
 */
export const WINDOW = 120;
/** One more page per press of "show earlier". Big enough to be worth the
 *  click, small enough that the press feels instant. */
export const PAGE = 200;

export interface Windowed {
  items: Grouped[];
  /** How many are above what is drawn. Shown as a count on the button, never
   *  hidden: a transcript that silently starts partway through is a transcript
   *  you cannot check a run against (§1). */
  hidden: number;
}

/** The last `limit` items, and how many were left above them. */
export function windowed(items: Grouped[], limit: number): Windowed {
  if (items.length <= limit) return { items, hidden: 0 };
  return { items: items.slice(items.length - limit), hidden: items.length - limit };
}
