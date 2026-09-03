/**
 * What one line typed into the composer means.
 *
 * The composer's box has always done exactly one thing — send words to a team
 * of agents. Adding `/` to it means the same box now sometimes speaks to the
 * **app** instead, and those two are not close to the same act: one costs
 * money and reaches four models, the other opens a panel.
 *
 * So this is a pure function with a hard rule: **only a command this build
 * actually knows is a command.** Everything else is a message, including a
 * line that starts with a slash. `/usr/local/bin is missing` is an ordinary
 * sentence and has to be sendable, and a build that answered it with "unknown
 * command" would be refusing to pass on something the person plainly meant to
 * say. There is no error state here at all, by design.
 *
 * The same rule applies to `@`. `@Wren check that again` addresses one
 * teammate; `@ 9am tomorrow` is text. A name is only a name when a name was
 * given, and whether it matches anyone is the backend's answer, not ours —
 * `Mailbox.resolve` already decides that, and having the client decide too
 * would be two answers to one question (§2.1).
 */

export type Parsed =
  | { kind: "message"; text: string; to: string | null }
  | { kind: "command"; id: CommandId; rest: string };

export type CommandId = "plan" | "rewind" | "fork";

export interface CommandSpec {
  id: CommandId;
  /** What is typed after the slash. */
  name: string;
  /** The one line the menu shows. Says what happens, not what it is. */
  summary: string;
  /** Whether it takes the rest of the line as its argument. */
  takesText: boolean;
  /** Only offered where it can actually do something — the same rule the tool
   *  registry follows: a control that cannot work is not shown (§16.5). */
  needs: "always" | "run" | "stopped-run";
}

export const COMMANDS: CommandSpec[] = [
  {
    id: "plan",
    name: "plan",
    summary: "Show the plan and wait for you before the work starts",
    takesText: true,
    needs: "always",
  },
  {
    id: "fork",
    name: "fork",
    summary: "Start a separate run from here — same team, same folder",
    takesText: true,
    needs: "run",
  },
  {
    id: "rewind",
    name: "rewind",
    summary: "Put the files back the way they were at a point in this run",
    takesText: false,
    needs: "stopped-run",
  },
];

/** Which commands make sense right now. A run that has never started cannot be
 *  forked, and a run in progress must not have its files rewritten under it. */
export function available(state: {
  hasMission: boolean;
  running: boolean;
}): CommandSpec[] {
  return COMMANDS.filter((c) => {
    if (c.needs === "run") return state.hasMission;
    if (c.needs === "stopped-run") return state.hasMission && !state.running;
    return true;
  });
}

const NAME = /^@([^\s]+)\s+([\s\S]+)$/;
const SLASH = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i;

export function parse(
  raw: string,
  allowed: CommandSpec[] = COMMANDS,
  /** The real teammates, so a name with a space in it survives. Optional: the
   *  bare `@word` form still works without it. */
  names: string[] = [],
): Parsed {
  const text = raw.trim();

  const slash = SLASH.exec(text);
  if (slash) {
    const spec = allowed.find((c) => c.name === slash[1]!.toLowerCase());
    // Unknown, or known but not usable right now: a message. Never an error —
    // see the module comment. A `/rewind` typed at a run that has not started
    // is a person typing a word, and refusing to send it teaches nothing.
    if (spec)
      return { kind: "command", id: spec.id, rest: (slash[2] ?? "").trim() };
  }

  if (text.startsWith("@")) {
    // A real name first, longest match wins. The roster reads
    // `Developer (Dev)` and `Tester (QA Engineer)`, and the picker inserts
    // exactly that — so a rule that stopped at the first space took
    // `Developer` as the recipient and left `(Dev)` at the front of the
    // message. Found by picking a name off the list and reading what came out,
    // which no amount of testing the bare-word form would have shown.
    const after = text.slice(1);
    const lowered = after.toLowerCase();
    const hit = [...names]
      .sort((a, b) => b.length - a.length)
      .find(
        (name) =>
          lowered.startsWith(name.toLowerCase()) &&
          /\s/.test(after.charAt(name.length)),
      );
    if (hit) {
      const body = after.slice(hit.length).trim();
      if (body) return { kind: "message", text: body, to: hit };
    }
    // A name and nothing else is an address half-typed — the picker has just
    // filled it in and the message is still to come. Falling through would let
    // the bare-word rule below read `@Developer (Dev)` as "(Dev)" said to
    // Developer, which is a message nobody wrote.
    if (names.some((name) => name.toLowerCase() === lowered.trim())) {
      return { kind: "message", text, to: null };
    }
  }

  const addressed = NAME.exec(text);
  if (addressed) {
    return { kind: "message", text: addressed[2]!.trim(), to: addressed[1]! };
  }

  return { kind: "message", text, to: null };
}

/**
 * What the `/` menu should show for what has been typed so far.
 *
 * Returns null when the menu should not be open at all — which is every case
 * except a line that is *only* a partial command. Once there is a space the
 * name is settled and the menu is in the way of the argument being typed.
 */
export function menuFilter(raw: string): string | null {
  if (!raw.startsWith("/")) return null;
  const rest = raw.slice(1);
  if (/\s/.test(rest)) return null;
  return rest.toLowerCase();
}

/**
 * The same, for `@`.
 *
 * A teammate's name is not something anyone should have to remember exactly.
 * The roster reads `Developer (Dev)` and `Tester (QA Engineer)`, and while
 * `Mailbox.resolve` accepts a prefix, that only helps somebody who already
 * knows roughly what to type — and a name that fits two people is refused, so
 * guessing has a real cost. Picking from the list is how you get it right the
 * first time.
 */
export function nameFilter(raw: string): string | null {
  if (!raw.startsWith("@")) return null;
  const rest = raw.slice(1);
  // A space means the name is settled and the message is being typed.
  if (/\s/.test(rest)) return null;
  return rest.toLowerCase();
}

/** Teammates whose name starts with, or contains, what has been typed.
 *
 *  Prefix first for the same reason `matches` does it: two letters appear
 *  inside most names, so searching only by "contains" never narrows. */
export function whoMatches(filter: string, names: string[]): string[] {
  if (!filter) return names;
  const lower = names.map((n) => [n, n.toLowerCase()] as const);
  const byStart = lower.filter(([, n]) => n.startsWith(filter));
  const pool =
    byStart.length > 0 ? byStart : lower.filter(([, n]) => n.includes(filter));
  return pool.map(([n]) => n);
}

/**
 * The names that start with what has been typed — and only if none do, the
 * ones whose description contains it.
 *
 * Searching both at once looked more helpful and was the opposite: two letters
 * appear inside almost any English sentence, so `/re` matched *befo**re***,
 * *sepa**ra**te* and *rewind* alike and the list never narrowed. A filter that
 * does not narrow is a filter that has to be read every time instead of typed
 * through.
 *
 * The fallback still earns its place: `/files` finds `rewind`, which is what
 * somebody looking for it would type.
 */
export function matches(filter: string, specs: CommandSpec[]): CommandSpec[] {
  if (!filter) return specs;
  const byName = specs.filter((c) => c.name.startsWith(filter));
  if (byName.length > 0) return byName;
  return specs.filter((c) => c.summary.toLowerCase().includes(filter));
}
