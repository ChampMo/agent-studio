/**
 * Options an agent offered, turned into buttons.
 *
 * `ask_user` returns prose, and prose is what the agent wrote. Very often it
 * ends in a list — *(a) do this, or (b) do that* — and answering it meant
 * reading the list, then typing the letter back. This finds those lists so the
 * answer is one press.
 *
 * **Every button's label is the agent's own words, and pressing it sends
 * exactly that.** Not the letter: `"a"` on the log is unreadable a week later,
 * and `mission_events` is the record (§9.3). What is sent is the text on the
 * button, so what you pressed and what the run says you answered are the same
 * string.
 *
 * The parsing is deliberately hard to satisfy, because the failure that matters
 * is a **false positive**: prose split into buttons offers a choice nobody made,
 * and one click sends it. So:
 *
 *   * markers must run in sequence from the start — `(a)(b)(c)` or `1.2.3.`,
 *     never a stray `(b)` in a sentence;
 *   * there must be at least two, since one option is not a choice;
 *   * an option that runs past `MAX_LABEL` is prose that happens to contain a
 *     marker, and the whole list is refused rather than truncated — a button
 *     showing half a sentence would be the model's words with the end cut off;
 *   * the last option stops at the end of its sentence, so a closing remark
 *     ("Note: I can verify either way") does not become part of the answer.
 *
 * When anything is unclear it returns nothing and the reply box is all there
 * is, which is exactly what there was before.
 *
 * **The list is lifted out of the question, not copied from it.** Once the
 * options are buttons, leaving them in the paragraph above says everything
 * twice — and the second copy is the one you have to read to find out that the
 * first one is clickable. Nothing is lost by moving it: every word taken out of
 * the paragraph is on a button, verbatim, and the untouched question is on the
 * log either way (§9.3). Whatever the agent wrote *after* the list stays — a
 * closing remark is not an option, and dropping it would be losing something
 * that is nowhere else on screen.
 */

export interface Choice {
  /** `a`, `b`, `1` — shown small, so the agent's own numbering is still there
   *  to match against the question above. Null when the agent gave its
   *  options as a field rather than writing a numbered list: there is no
   *  numbering in the question to match against, so printing one would be
   *  this build inventing it. */
  marker: string | null;
  /** The agent's words. This is the label and this is what gets sent. */
  text: string;
}

/**
 * Past this an "option" is a paragraph, and the list is refused.
 *
 * 260, and the number is measured rather than chosen: the question that
 * prompted this feature has an option 185 characters long — a full sentence
 * with a bracketed list inside it — and the first guess of 180 threw the whole
 * thing away by five characters. A cap that refuses real questions is worse
 * than no cap, because the failure is silent: you get the plain reply box and
 * no reason why.
 */
export const MAX_LABEL = 260;

const LETTER = /\(([a-z])\)|(?:^|\s)([a-z])\)/gi;
const NUMBER = /\((\d{1,2})\)|(?:^|\s)(\d{1,2})[.)]/g;

interface Mark {
  marker: string;
  at: number;
  end: number;
}

function marks(text: string, re: RegExp): Mark[] {
  const out: Mark[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const marker = (m[1] ?? m[2] ?? "").toLowerCase();
    if (!marker) continue;
    out.push({ marker, at: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** `a, b, c…` or `1, 2, 3…` with nothing missing and nothing repeated. */
function sequential(found: Mark[]): boolean {
  const first = found[0]?.marker;
  if (!first) return false;
  const numeric = /^\d+$/.test(first);
  if (numeric ? first !== "1" : first !== "a") return false;
  return found.every((mark, i) =>
    numeric
      ? mark.marker === String(i + 1)
      : mark.marker === String.fromCharCode(97 + i),
  );
}

/** Trim the connector a list leaves behind: "…here, or" → "…here". */
function tidy(raw: string): string {
  return raw
    .trim()
    .replace(/[\s,;]*\b(?:or|and)\s*$/i, "")
    .replace(/[\s,;:.]+$/, "")
    .trim();
}

/** Where the last option ends: the close of the sentence it began in. */
function sentenceEnd(text: string, from: number): number {
  const rest = text.slice(from);
  const stop = rest.search(/[.!?](?:\s+[A-Z(]|\s*$)/);
  return stop === -1 ? text.length : from + stop + 1;
}

/** A lead-in the list leaves stranded: "Options:" with nothing after it. Only
 *  a single word and a colon, so a real sentence is never eaten. */
const LEAD = /(?:^|[.:;?!]|\s)\s*[A-Z][a-z]{2,11}:\s*$/;

export interface Ask {
  /** The question with the option list lifted out of it. */
  text: string;
  /** What the agent offered, or empty when it offered nothing parseable. */
  choices: Choice[];
}

export function parseAsk(question: string): Ask {
  for (const re of [LETTER, NUMBER]) {
    const found = marks(question, re);
    if (found.length < 2 || !sequential(found)) continue;

    const out: Choice[] = [];
    let ok = true;
    let last = 0;
    for (let i = 0; i < found.length; i += 1) {
      const mark = found[i]!;
      const stop =
        i + 1 < found.length
          ? found[i + 1]!.at
          : sentenceEnd(question, mark.end);
      const text = tidy(question.slice(mark.end, stop));
      // Empty, or long enough that it is prose rather than an option. Either
      // way the list is not what it looked like, so none of it is offered.
      if (!text || text.length > MAX_LABEL) {
        ok = false;
        break;
      }
      out.push({ marker: mark.marker, text });
      last = stop;
    }
    if (!ok || out.length < 2) continue;

    const head = question.slice(0, found[0]!.at);
    const lead = LEAD.exec(head);
    const before = lead ? head.slice(0, lead.index + 1) : head;
    const after = question.slice(last);
    return {
      text: `${before.trim()} ${after.trim()}`.replace(/\s+/g, " ").trim(),
      choices: out,
    };
  }
  return { text: question, choices: [] };
}

/** What a question card shows, and what it offers. */
export interface Offer {
  /** The question text, as the card should print it. */
  asked: string;
  /** The buttons, in order. `marker` is the letter or number a prose list
   *  carried, and is null for options the agent gave as a field. */
  offered: Choice[];
}

/**
 * The two halves of a question, decided together — because they are one
 * decision and were briefly two.
 *
 * `parseAsk` lifts a list *out* of the prose, and the paragraph above explains
 * why that is safe: every word it removes reappears on a button, verbatim.
 * That held for as long as the buttons *were* the strings it removed.
 *
 * Then `ask_user` gained a structured `options` field, the buttons started
 * coming from there, and the two lists stopped being the same list. The text
 * being stripped was whatever the agent had *also* written out in prose —
 * which is where it puts its reasons, one line per option — and the buttons
 * replacing it are short labels. So the agent's argument for each choice was
 * being deleted from the one screen where somebody is choosing, and left
 * nowhere but the raw event.
 *
 * Hence one function. A structured question is shown exactly as written and
 * its buttons come from the field; only a question this build had to *read*
 * has anything lifted out of it. Nothing can strip text that no button
 * carries, because one return decides both.
 */
export function offerFor(question: string, options: string[] | null): Offer {
  if (options?.length) {
    return {
      asked: question,
      offered: options.map((text) => ({ marker: null, text })),
    };
  }
  const parsed = parseAsk(question);
  return { asked: parsed.text, offered: parsed.choices };
}
